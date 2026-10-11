// Did the file we are about to hand the user actually come out as a file?
//
// WHY THIS EXISTS
//
// `executeCreateFile` used to report `ok: true` the moment `generateFile`
// returned a blob, and the model then told the user their document was ready and
// showed a download link. Nothing in that path ever looked at the bytes. A
// generator bug — a zero-row xlsx, a pptx whose presentation part never got
// written, a pdf truncated at the header — produced a confident success message
// and a link to a file that will not open.
//
// This repo has already been bitten by exactly this class of bug on the
// neighbouring path: `handleDownloadImage` once saved a 404 error page to disk
// under a `.png` name, because `fetch` resolves for a 404 as happily as for a 200
// and `.blob()` on an error page succeeds. The note left there is the rule this
// module implements: *a file that will not open is worse than a message saying
// the download failed, because the user has to work out for themselves that it
// is not an image.*
//
// WHAT "VERIFIED" MEANS HERE, EXACTLY
//
// Two claims, and no more than two, because overclaiming is the failure mode this
// module exists to prevent:
//
//   1. STRUCTURE — the bytes parse as the format they are labelled with. OOXML
//      (xlsx/docx/pptx) is a ZIP, so it is unzipped and the part that makes it
//      that format is required to be present. PDF is checked at both ends, since
//      a truncated write keeps the header and loses the trailer. JSON must parse.
//   2. CONTENT — the parsed document contains at least one real element: a
//      non-empty cell, a text run, a row. This is deliberately not a token match
//      against the source string: the generators legitimately transform their
//      input (an xlsx is built from JSON rows and its cells hold the *values*,
//      not the JSON), so asserting the input survives verbatim would fail on
//      correct output. "There is something in it" is a claim the bytes can
//      actually support.
//
// It does NOT claim the document is well-designed, that a chart rendered, or that
// the content is correct. Saying "I verified the file" when only the magic bytes
// were checked is the same lie in a smaller font.
//
// Pure over `Uint8Array` rather than taking a Blob, so the tests can hand it
// genuinely corrupt bytes — which is the only way to know the checks have teeth.

import JSZip from "jszip";
import * as XLSX from "xlsx";

import type { FileFormat } from "./file-generator";
import { isSupportedFormat } from "./file-generator";

/**
 * A verdict on some bytes.
 *
 * WHY THIS IS ONE OPTIONAL-FIELD SHAPE AND NOT A DISCRIMINATED UNION
 *
 * It was written as `{ ok: true; detail } | { ok: false; reason }` first, which
 * is the better type — and it does not compile in this project. `tsconfig.app.json`
 * sets `"strict": false`, so `strictNullChecks` is off, and without it TypeScript
 * does not narrow a union by a literal discriminant: every access to `.reason`
 * was rejected with *"Property 'reason' does not exist on type '{ ok: true;
 * detail: string }'"*, including inside `r.ok ? "" : r.reason`, where narrowing
 * would normally be unarguable.
 *
 * `ToolResult` in ./tools/types.ts looks like a counter-example, but it is not:
 * its success branch carries `[key: string]: unknown`, so `result.error` type-checks
 * through the index signature rather than through narrowing. That is the shape
 * this config actually supports.
 *
 * So: optional fields, and the two accessors below to hand callers a guaranteed
 * string. Exactly one of `detail` and `reason` is ever set.
 */
export interface VerifyResult {
  ok: boolean;
  /** Set when `ok` — what was actually checked, in the words of the check. */
  detail?: string;
  /** Set when not `ok` — why the bytes were refused. */
  reason?: string;
}

/** Why a verdict failed, or "" when it passed. */
export const verifyReason = (r: VerifyResult): string => r.reason ?? "";

/** What a verdict checked, or "" when it failed. */
export const verifyDetail = (r: VerifyResult): string => r.detail ?? "";

/**
 * The part whose presence is what makes a ZIP that format, rather than a ZIP.
 *
 * `[Content_Types].xml` is required by OOXML too and is checked separately for
 * all three — a ZIP with a `word/document.xml` and no content types is not a
 * document any reader will open.
 */
const OOXML_PART: Record<string, string> = {
  xlsx: "xl/workbook.xml",
  docx: "word/document.xml",
  pptx: "ppt/presentation.xml",
};

/**
 * A PDF with nothing in it is about 400 bytes of header, catalog and trailer.
 * The floor is below that on purpose: it is here to catch a *truncated* write,
 * and the `%%EOF` check below is what catches the empty-but-well-formed case.
 */
const PDF_MIN_BYTES = 200;

const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

export async function verifyArtifact(
  format: string,
  bytes: Uint8Array,
): Promise<VerifyResult> {
  // `format` is a plain string because that is what the callers hold:
  // `resolveFormat` in create_file can fall through to an unrecognised
  // extension. In practice an unsupported format never reaches here, because
  // `generateFile` rejects it first and both gates call the same
  // `isSupportedFormat` — but refusing is the honest answer to "verify this
  // thing I don't recognise", and a cast would have claimed the opposite.
  if (!isSupportedFormat(format)) {
    return { ok: false, reason: `"${format}" is not a format this app generates` };
  }
  const known: FileFormat = format;

  // Before anything format-specific: a zero-byte file is the single most common
  // shape of this failure and the cheapest to catch.
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "the generator produced an empty file (0 bytes)" };
  }

  if (known === "xlsx" || known === "docx" || known === "pptx") {
    return verifyOoxml(known, bytes);
  }
  if (known === "pdf") return verifyPdf(bytes);
  if (known === "json") return verifyJson(bytes);
  if (known === "csv") return verifyCsv(bytes);
  return verifyText(known, bytes);
}

async function verifyOoxml(format: string, bytes: Uint8Array): Promise<VerifyResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    // Not a ZIP at all. This is what a half-written OOXML file looks like, and
    // it is also what a text error message saved under a .xlsx name looks like.
    return {
      ok: false,
      reason: `the ${format} is not a readable archive (${e instanceof Error ? e.message : "unzip failed"})`,
    };
  }

  if (!zip.file("[Content_Types].xml")) {
    return { ok: false, reason: `the ${format} archive is missing [Content_Types].xml` };
  }
  const part = OOXML_PART[format];
  const mainPart = zip.file(part);
  if (!mainPart) {
    return { ok: false, reason: `the ${format} archive is missing ${part}` };
  }

  // CONTENT. Each format is read with something that actually understands it,
  // rather than with a substring search over the XML — `<w:t>` appears in an
  // empty document's styles too.
  if (format === "xlsx") {
    try {
      const book = XLSX.read(bytes, { type: "array" });
      const sheets = book.SheetNames || [];
      if (sheets.length === 0) return { ok: false, reason: "the workbook has no sheets" };
      for (const name of sheets) {
        const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, blankrows: false });
        if (rows.length > 0) {
          return { ok: true, detail: `${sheets.length} sheet(s), ${rows.length} row(s) in "${name}"` };
        }
      }
      return { ok: false, reason: `the workbook's ${sheets.length} sheet(s) are all empty` };
    } catch (e) {
      return { ok: false, reason: `the workbook did not reopen (${e instanceof Error ? e.message : "read failed"})` };
    }
  }

  const xml = await mainPart.async("string");
  // WHERE THE TEXT ACTUALLY LIVES differs between the two, and getting this
  // wrong is not a theoretical risk — the first version of this function looked
  // for text runs in `ppt/presentation.xml` and rejected every real deck the
  // generator produced. `presentation.xml` holds the slide size and the slide-id
  // list; the words are in `ppt/slides/slideN.xml`. A docx is the opposite: the
  // body text really is in `word/document.xml`.
  //
  // It was caught by the one test that fed this function a pptx from the actual
  // generator rather than a hand-built fixture, which is why the controls below
  // now do that for all three OOXML formats.
  const parts =
    format === "pptx"
      ? Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      : [part];

  if (format === "pptx" && parts.length === 0) {
    return { ok: false, reason: "the pptx has no slide parts (ppt/slides/slideN.xml)" };
  }

  // The text-run tag differs between WordprocessingML and DrawingML, which is
  // why this is not one shared check.
  const runTag = format === "docx" ? "w:t" : "a:t";
  const runRe = new RegExp(`<${runTag}[^>]*>([^<]*)</${runTag}>`, "g");
  let withText = 0;
  for (const name of parts) {
    const body = name === part ? xml : await zip.file(name)!.async("string");
    for (const run of body.match(runRe) || []) {
      if (run.replace(/<[^>]+>/g, "").trim().length > 0) withText += 1;
    }
  }
  if (withText === 0) {
    return { ok: false, reason: `the ${format} contains no text runs` };
  }
  return {
    ok: true,
    detail:
      format === "pptx"
        ? `${parts.length} slide(s), ${withText} text run(s)`
        : `${withText} text run(s) in ${part}`,
  };
}

function verifyPdf(bytes: Uint8Array): VerifyResult {
  // Checked at BOTH ends deliberately: a write truncated partway keeps a perfect
  // `%PDF-` header, so a header-only check would pass the exact file this
  // function exists to reject.
  const head = text(bytes.subarray(0, 8));
  if (!head.startsWith("%PDF-")) {
    return { ok: false, reason: "the file does not start with a %PDF- header" };
  }
  // The trailer is at the end, but some writers leave trailing whitespace.
  const tail = text(bytes.subarray(Math.max(0, bytes.byteLength - 2048)));
  if (!tail.includes("%%EOF")) {
    return { ok: false, reason: "the PDF has no %%EOF trailer — the write was truncated" };
  }
  if (bytes.byteLength < PDF_MIN_BYTES) {
    return { ok: false, reason: `the PDF is only ${bytes.byteLength} bytes, too small to hold a page` };
  }
  return { ok: true, detail: `${bytes.byteLength} bytes, header and trailer present` };
}

function verifyJson(bytes: Uint8Array): VerifyResult {
  const body = text(bytes);
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || (typeof parsed === "object" && Object.keys(parsed as object).length === 0)) {
      return { ok: false, reason: "the JSON parsed but holds nothing" };
    }
    return { ok: true, detail: `valid JSON, ${body.length} chars` };
  } catch (e) {
    return { ok: false, reason: `the JSON does not parse (${e instanceof Error ? e.message : "parse failed"})` };
  }
}

function verifyCsv(bytes: Uint8Array): VerifyResult {
  const lines = text(bytes).split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { ok: false, reason: "the CSV has no non-empty rows" };
  return { ok: true, detail: `${lines.length} row(s)` };
}

function verifyText(format: string, bytes: Uint8Array): VerifyResult {
  const body = text(bytes);
  if (body.trim().length === 0) {
    return { ok: false, reason: `the ${format} file is whitespace only` };
  }
  return { ok: true, detail: `${body.length} chars` };
}
