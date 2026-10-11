// Can `create_file` tell a working document from a broken one?
//
// THE DEFECT THIS FILE WAS WRITTEN AGAINST
//
// `executeCreateFile` returned `ok: true` as soon as `generateFile` handed back a
// blob, and the model then told the user their file was ready and showed a
// download link. Nothing in that path read the bytes. So a generator bug — an
// xlsx with no sheets, a pptx missing its presentation part, a pdf truncated at
// the header — was reported as a success, and the user got a confident message
// and a link to a file that will not open.
//
// The same bug already has a note in this repo on the image path:
// `handleDownloadImage` once wrote a 404 error page to disk under a `.png` name,
// because `fetch` resolves for a 404 and `.blob()` on an error page succeeds.
// "A file that will not open is worse than a message saying the download failed."
//
// WHY THE TESTS LOOK LIKE THIS
//
// Half of them feed the verifier *genuinely corrupt bytes* rather than asking a
// generator to misbehave. That is the only way to know the checks have teeth: a
// verifier tested exclusively against its own generator's good output cannot
// distinguish "this validates documents" from "this returns true".
//
// The other half go through `executeCreateFile` with the generator mocked, which
// is where the integration claim lives: the tool must REFUSE, and must not
// register the artifact — a rejected file that still appears in the download list
// is the same lie with an extra step.

import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import { verifyArtifact, verifyReason, verifyDetail } from "@/lib/artifact-verify";

const enc = (s: string) => new TextEncoder().encode(s);

describe("the verifier rejects bytes that are not the document they claim to be", () => {
  it("rejects an empty file for every format", async () => {
    // The most common shape of this failure and the cheapest to catch.
    for (const format of ["txt", "md", "json", "csv", "xlsx", "docx", "pdf", "pptx"] as const) {
      const r = await verifyArtifact(format, new Uint8Array(0));
      expect(r.ok, `${format} must reject 0 bytes`).toBe(false);
      expect(verifyReason(r)).toMatch(/empty|0 bytes/i);
    }
  });

  it("rejects an error message saved under a .xlsx name", async () => {
    // Not hypothetical: this is the exact shape of the image-path bug, where a
    // server's error body was written out under a binary extension.
    const r = await verifyArtifact("xlsx", enc("Internal Server Error"));
    expect(r.ok).toBe(false);
    expect(verifyReason(r)).toMatch(/not a readable archive/i);
  });

  it("rejects a valid ZIP that is not an OOXML document", async () => {
    // A ZIP unzips fine. That is not the same as being a workbook, and a check
    // that stopped at "did it unzip" would pass this.
    const zip = new JSZip();
    zip.file("hello.txt", "not a spreadsheet");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyArtifact("xlsx", bytes);
    expect(r.ok).toBe(false);
    expect(verifyReason(r)).toMatch(/\[Content_Types\]\.xml/);
  });

  it("rejects an OOXML archive whose format-defining part is missing", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("docProps/app.xml", "<Properties/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyArtifact("pptx", bytes);
    expect(r.ok).toBe(false);
    expect(verifyReason(r)).toMatch(/ppt\/presentation\.xml/);
  });

  it("rejects a pptx that has a presentation part but no slides", async () => {
    // The shape a deck takes when slide generation silently produced nothing:
    // the presentation-level scaffolding is written, the slides are not.
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("ppt/presentation.xml", "<p:presentation><p:sldIdLst/></p:presentation>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyArtifact("pptx", bytes);
    expect(r.ok).toBe(false);
    expect(verifyReason(r)).toMatch(/no slide parts/i);
  });

  it("rejects a docx whose text runs are all empty", async () => {
    // Structure present, content absent — the case a structure-only check misses.
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:t>   </w:t></w:p></w:body></w:document>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyArtifact("docx", bytes);
    expect(r.ok).toBe(false);
    expect(verifyReason(r)).toMatch(/no text runs/i);
  });

  it("rejects a PDF truncated after its header", async () => {
    // The reason the trailer is checked: a truncated write keeps a perfect
    // header, so a header-only check passes the exact file this must reject.
    const r = await verifyArtifact("pdf", enc("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>"));
    expect(r.ok).toBe(false);
    expect(verifyReason(r)).toMatch(/%%EOF|truncated/i);
  });

  it("rejects a file with a PDF trailer but no PDF header", async () => {
    const r = await verifyArtifact("pdf", enc(`${"x".repeat(400)}\n%%EOF\n`));
    expect(r.ok).toBe(false);
    expect(verifyReason(r)).toMatch(/%PDF- header/);
  });

  it("rejects JSON that does not parse, and JSON that holds nothing", async () => {
    const broken = await verifyArtifact("json", enc('{"a": 1,'));
    expect(broken.ok).toBe(false);
    const hollow = await verifyArtifact("json", enc("{}"));
    expect(hollow.ok).toBe(false);
    expect(verifyReason(hollow)).toMatch(/holds nothing/i);
  });

  it("rejects a whitespace-only text file and a header-free CSV", async () => {
    const blank = await verifyArtifact("md", enc("   \n\n  \t\n"));
    expect(blank.ok).toBe(false);
    const empty = await verifyArtifact("csv", enc("\n\n\n"));
    expect(empty.ok).toBe(false);
  });
});

describe("the verifier accepts documents that really are documents", () => {
  // CONTROLS. Without these the suite above is satisfied by a verifier that
  // returns false for everything, which would block every real file.
  it("accepts a real workbook built by the library that reads it back", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["name", "qty"], ["bolt", 12]]), "Stock");
    const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
    const r = await verifyArtifact("xlsx", bytes);
    expect(r.ok, verifyReason(r)).toBe(true);
    expect(verifyDetail(r)).toMatch(/sheet/);
  });

  it("accepts a docx with real text", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:t>Quarterly report</w:t></w:p></w:body></w:document>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyArtifact("docx", bytes);
    expect(r.ok, verifyReason(r)).toBe(true);
  });

  it("accepts a pptx whose text is in the slide parts, where it really lives", async () => {
    // Deliberately a separate control from docx on two counts: the text-run tag
    // differs (DrawingML `a:t` vs WordprocessingML `w:t`), AND so does the part.
    // The first version of this verifier looked for runs in presentation.xml and
    // rejected every real deck, because presentation.xml holds the slide size and
    // the slide-id list, not the words.
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("ppt/presentation.xml", "<p:presentation><p:sldIdLst/></p:presentation>");
    zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>The AI bubble</a:t></p:sld>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyArtifact("pptx", bytes);
    expect(r.ok, verifyReason(r)).toBe(true);
    expect(verifyDetail(r)).toMatch(/slide/);
  });

  it("accepts what the real generators actually produce", async () => {
    // THE CONTROL THAT WAS MISSING, and the reason a bug shipped in this file.
    //
    // Every other case here is a hand-built fixture, and a fixture encodes what
    // its author BELIEVED the format looks like. This author believed pptx text
    // lived in presentation.xml. It does not, so the verifier rejected every real
    // deck while its own fixture sailed straight through. A verifier is only
    // trustworthy once it has been run against the generator it guards.
    //
    // `importActual` is load-bearing: this file mocks `generateFile` for the
    // integration tests below, and `vi.mock` is hoisted file-wide, so a plain
    // import here would hand this control the mock and it would verify nothing.
    const real = await vi.importActual<typeof import("@/lib/file-generator")>(
      "@/lib/file-generator",
    );
    for (const [format, content] of [
      ["pptx", "# The AI bubble\n\n- Valuations\n- Capex spend\n"],
      ["docx", "# Quarterly report\n\nRevenue grew by 12%.\n"],
      ["xlsx", '[{"name":"bolt","qty":12}]'],
      ["pdf", "# Report\n\nBody text.\n"],
      ["csv", "name,qty\nbolt,12\n"],
      ["json", '{"rows":[1,2]}'],
      ["md", "# Notes\n\nSome notes."],
      ["txt", "plain text"],
    ] as const) {
      const made = await real.generateFile(format, `probe.${format}`, content);
      expect(made.ok, `the generator failed for ${format}`).toBe(true);
      if (!made.ok) continue;
      const r = await verifyArtifact(format, new Uint8Array(await made.blob.arrayBuffer()));
      expect(r.ok, `the verifier rejected a real ${format}: ${verifyReason(r)}`).toBe(true);
    }
  });

  it("accepts a well-formed PDF, JSON, CSV and markdown", async () => {
    const pdf = await verifyArtifact("pdf", enc(`%PDF-1.7\n${"% padding\n".repeat(40)}trailer\n%%EOF\n`));
    expect(pdf.ok, verifyReason(pdf)).toBe(true);
    expect((await verifyArtifact("json", enc('{"rows":[1,2]}'))).ok).toBe(true);
    expect((await verifyArtifact("csv", enc("name,qty\nbolt,12\n"))).ok).toBe(true);
    expect((await verifyArtifact("md", enc("# Report\n\nBody."))).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The integration claim: the tool must refuse, and must not register the file.
// ---------------------------------------------------------------------------

const { generateFile } = vi.hoisted(() => ({ generateFile: vi.fn() }));
vi.mock("@/lib/file-generator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/file-generator")>()),
  generateFile,
}));

import { executeCreateFile } from "@/lib/tools/create-file";

/** A ToolContext with only what create_file touches. */
function ctx() {
  return { artifacts: {} as { files?: unknown[] } } as unknown as Parameters<typeof executeCreateFile>[1];
}

describe("create_file refuses to deliver a file it cannot verify", () => {
  beforeEach(() => {
    generateFile.mockReset();
    // jsdom's URL has no createObjectURL.
    if (!("createObjectURL" in URL)) {
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:stub");
    }
  });

  it("reports a failure the model can act on when the bytes are corrupt", async () => {
    // The generator "succeeds" and hands back an error page under a .xlsx name —
    // precisely the shape that used to be announced as a ready download.
    const blob = new Blob([enc("Internal Server Error")]);
    generateFile.mockResolvedValue({
      ok: true, blob, filename: "report.xlsx", mimeType: "application/vnd.ms-excel", size: blob.size,
    });

    const c = ctx();
    const result = await executeCreateFile({ filename: "report.xlsx", format: "xlsx", content: "[]" }, c);

    expect(result.ok, "a corrupt artifact must not be reported as created").toBe(false);
    expect(String(result.error)).toMatch(/verif|archive|could not/i);
    // And the half of the fix that matters just as much: a refused file must not
    // appear in the download list.
    expect(c.artifacts.files ?? []).toHaveLength(0);
  });

  it("still delivers a file that verifies, and says what was verified", async () => {
    // CONTROL. Without this the fix above is satisfied by refusing everything.
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["a"], [1]]), "S");
    const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
    const blob = new Blob([bytes]);
    generateFile.mockResolvedValue({
      ok: true, blob, filename: "ok.xlsx", mimeType: "application/vnd.ms-excel", size: blob.size,
    });

    const c = ctx();
    const result = await executeCreateFile({ filename: "ok.xlsx", format: "xlsx", content: "[]" }, c);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    expect(c.artifacts.files ?? []).toHaveLength(1);
  });

  it("passes a generator failure straight through, unchanged", async () => {
    // CONTROL: the verifier must not swallow or reword the generator's own
    // diagnosis, which is the message the model needs in order to retry.
    generateFile.mockResolvedValue({ ok: false, error: "unsupported format \"xls\"" });
    const c = ctx();
    const result = await executeCreateFile({ filename: "x.xls", format: "xls", content: "" }, c);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/unsupported format/);
    expect(c.artifacts.files ?? []).toHaveLength(0);
  });
});
