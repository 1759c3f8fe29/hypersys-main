// ---------------------------------------------------------------------------
// Document text extraction
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
//
// ChatInput advertises support for pdf/docx/xlsx/pptx/csv/code uploads, but the
// upload path only ever produced a base64 data URL. For anything that is not an
// image that is useless: the model received a giant meaningless string, so it
// either hallucinated the contents or said it could not see the file. The UI
// promised a feature the pipeline never implemented.
//
// This module turns a File into text the model can actually read. The heavy
// parsers are dynamically imported so a user who only ever sends images never
// downloads the PDF or spreadsheet machinery.
//
// WHAT "ANY FILE TYPE" MEANS HERE
//
// The second half of the same problem: the list of formats was closed, and a file
// outside it was not refused — it was dropped. `canExtract` returned false, the
// caller filtered the file out of the extraction pass, and the attachment still
// appeared in the composer and its *name* still reached the model. So attaching a
// `.yaml`, a `.go`, a `Dockerfile` or a `.log` produced a confident answer about a
// file nothing had opened, which is worse than a visible rejection because it is
// indistinguishable from working.
//
// Extraction is total now. Three tiers, in `extractDocument`:
//
//   1. A dedicated parser, keyed on the extension: pdf, docx, xlsx, pptx,
//      OpenDocument, epub, rtf, ipynb, and the legacy OLE2 formats.
//   2. A name that says text: ~250 extensions, the extension-less names that are
//      always text (`Dockerfile`, `Makefile`, `LICENSE`), and text-ish MIME types.
//   3. The bytes. `extractUnknown` identifies the format from its magic number and
//      re-dispatches to tier 1 when it recognises one (so a docx that arrived as
//      `attachment` with no extension still gets parsed as a docx), reads the file
//      as text when it reads as text, and otherwise reports what the file is.
//
// There is no "unsupported file type" branch left. The closest thing is a binary
// with no text in it, which comes back identified — "MP4 video, 12.4 MB" — and
// flagged as `binary` rather than as an `error`, because a video is a fact about
// the upload and not a failure to read it.

// OCR fallback for scanned PDFs — pages that carry no text layer at all.
// `nemotron-parse` is a non-conversational service live on the NVIDIA endpoint
// (verified via scripts/verify-models.mjs); a plain text layer stays the fast
// path and only an empty page routes through OCR, so a normal PDF never pays the
// cost. Image *uploads* are deliberately not handled here — that case belongs to
// the `ocr_image` tool, which the model calls when it judges the image to be a
// document. See src/lib/tools/ocr-image.ts.
import { ocrImage } from "./ai";
import { fenceFor } from "./chat-format";

export interface ExtractedDocument {
  name: string;
  mimeType: string;
  /** Extracted text, already truncated to a sane size. */
  text: string;
  /**
   * The attachment id assigned by the caller, threaded back here so it surfaces
   * in the document context block the model reads. The model copies it into an
   * edit_file call to name a specific file. Optional because `extractDocument`
   * predates ids and not every caller has one.
   */
  id?: string;
  /** Set when extraction failed, so the caller can tell the user honestly. */
  error?: string;
  /** True when the text was cut short. */
  truncated?: boolean;
  /** Page/sheet/slide count where the format has one. */
  units?: number;
  /**
   * The file holds no text at all: a video, a font, an executable, a database.
   *
   * Deliberately not an `error`. "This is an MP4" is a fact about the file, not a
   * failure to read it, and the two need different handling in both directions:
   * the caller toasts every `error` (so a knowingly-attached video would raise an
   * alarm about nothing), and the model must be told to describe the file rather
   * than to apologise for it or guess at contents it cannot have.
   */
  binary?: boolean;
  /** Human-readable format identification, e.g. "MP4 video, 12.4 MB". */
  detail?: string;
}

// A single document should not be able to consume the whole context window.
// Beyond this the budgeter would drop conversation history to make room, which
// is a worse trade than telling the user their file was truncated.
const MAX_CHARS_PER_DOC = 120_000;

// Fallback OCR is metered: a scanned 500-page book must not fire 500 paid calls.
// Only pages with no text layer route through OCR, and only this many of them.
const OCR_PAGE_BUDGET = 10;

// A bound on pages examined. MAX_CHARS_PER_DOC stops documents that have text;
// this stops the other shape — an all-scan file past the OCR budget, where every
// page yields nothing, so the size cap never trips and the loop would parse
// every text layer in a 2000-page file to find them all empty.
const MAX_PDF_PAGES_SCANNED = 200;

// How much of a file is examined to decide whether it is text. Read from a
// `slice`, never from the whole file: the point of this path is that it runs on
// things like a 700 MB disk image, and answering "is this text" does not require
// loading one.
const MAX_SNIFF_BYTES = 64 * 1024;

// A text read is capped at 4 bytes per retained character, UTF-8's worst case, so
// a 400 MB log file costs one bounded slice instead of a 400 MB string that
// `truncate` then throws 99.9% of away.
const MAX_TEXT_BYTES = MAX_CHARS_PER_DOC * 4;

// Entries listed for an archive we have no specialised reader for. Enough to show
// what the archive is; not so many that a node_modules zip becomes the context.
const MAX_ARCHIVE_ENTRIES = 200;

const TEXT_LIKE_EXTENSIONS = new Set([
  // Prose and data
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "asciidoc", "org", "tex",
  "bib", "csv", "tsv", "psv", "log", "json", "json5", "jsonl", "ndjson", "xml",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "plist",
  "srt", "vtt", "ass", "sub", "ics", "vcf", "po", "pot", "diff", "patch", "sql",
  // Markup and styling
  "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl", "svg", "vue",
  "svelte", "astro", "hbs", "ejs", "pug", "jade", "twig", "liquid", "haml", "slim",
  // Code
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "pyi", "pyw", "rb",
  "rake", "gemspec", "go", "rs", "java", "kt", "kts", "scala", "sbt", "groovy",
  "clj", "cljs", "cljc", "edn", "ex", "exs", "erl", "hrl", "hs", "lhs", "elm",
  "ml", "mli", "fs", "fsx", "fsi", "swift", "m", "mm", "c", "h", "cc", "cpp",
  "cxx", "c++", "hpp", "hh", "hxx", "h++", "cs", "vb", "php", "phtml", "pl", "pm",
  "lua", "r", "jl", "dart", "zig", "nim", "v", "sv", "vhd", "vhdl", "d", "cr",
  "f", "f90", "f95", "for", "pas", "pp", "ada", "adb", "asm", "s", "wat", "sol",
  "move", "cairo", "vy", "gd",
  // Shells, build and infrastructure
  "sh", "bash", "zsh", "fish", "ksh", "csh", "bat", "cmd", "ps1", "psm1", "psd1",
  "awk", "sed", "vim", "el", "lisp", "scm", "rkt", "tcl", "makefile", "mk",
  "cmake", "gradle", "dockerfile", "containerfile", "tf", "tfvars", "hcl",
  "nomad", "bicep", "gitignore", "gitattributes", "gitmodules", "editorconfig",
  "npmrc", "nvmrc", "babelrc", "eslintrc", "prettierrc", "browserslistrc",
  "dockerignore", "lock", "sum", "mod", "resolved", "cabal", "opam", "nix",
  // Schemas and interface definitions
  "proto", "graphql", "gql", "avsc", "thrift", "capnp", "fbs", "smithy", "raml",
  "sdl", "ddl", "cql", "prisma",
]);

/**
 * Extension-less files that are plain text, matched on the whole name.
 *
 * `extensionOf("Dockerfile")` is `""`, so listing "dockerfile" among the
 * extensions above only ever matched `something.dockerfile`. The real file, the
 * one every repository actually contains, fell through to the "cannot read"
 * branch — as did `Makefile`, `LICENSE`, `README` and every dotfile. The sniff
 * would now catch all of these anyway; this keeps them on the fast path and
 * documents that they were the miss.
 */
const TEXT_LIKE_BASENAMES = new Set([
  "dockerfile", "containerfile", "makefile", "gnumakefile", "rakefile",
  "gemfile", "podfile", "brewfile", "procfile", "vagrantfile", "justfile",
  "jenkinsfile", "cmakelists.txt", "license", "licence", "copying", "notice",
  "authors", "contributors", "readme", "changelog", "changes", "news", "todo",
  "install", "manifest", "codeowners", "owners", "version",
]);

/** Zip-based formats with a real extractor of their own, keyed by extension. */
const OPENDOCUMENT_EXTENSIONS = new Set([
  "odt", "ott", "ods", "ots", "odp", "otp", "odg", "otg", "odf", "odc", "odb",
]);

/**
 * Archive extensions we can name but not open in the browser. Zip we *can* open
 * (jszip is already a dependency for .pptx), so it is deliberately absent.
 */
const OPAQUE_ARCHIVE_EXTENSIONS = new Set([
  "rar", "7z", "gz", "tgz", "bz2", "xz", "zst", "lz", "lzma", "cab", "iso",
  "dmg", "pkg", "deb", "rpm", "msi", "tar",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Whether the *name* alone says this is text.
 *
 * Three ways in, because all three occur in real uploads: a known extension
 * (`app.py`), a known extension-less name (`Dockerfile`), and a dotfile whose
 * "extension" is the whole name (`.gitignore` → `extensionOf` returns
 * `gitignore`, which is why those are in the extension set).
 */
function nameLooksTextual(file: File): boolean {
  const ext = extensionOf(file.name);
  return (
    TEXT_LIKE_EXTENSIONS.has(ext) ||
    TEXT_LIKE_BASENAMES.has(file.name.toLowerCase()) ||
    file.type.startsWith("text/") ||
    // application/json, application/xml, image/svg+xml, application/x-sh, …
    /^application\/(json|.*\+json|xml|.*\+xml|javascript|x-sh|x-shellscript|sql|toml|yaml)$/.test(file.type) ||
    file.type === "image/svg+xml"
  );
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHARS_PER_DOC) return { text, truncated: false };
  return {
    // Cut at a line boundary so the model doesn't receive a half-token tail.
    text: text.slice(0, MAX_CHARS_PER_DOC).replace(/\n[^\n]*$/, ""),
    truncated: true,
  };
}

/** Whether this file should be sent as an image rather than extracted as text. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** Whether we have any extractor for this file at all. */
export function canExtract(file: File): boolean {
  // Every non-image file, now. This used to be a closed allowlist and the answer
  // mattered: its one caller drops whatever it rejects, *silently* — no error
  // block, no toast — while the attachment still renders in the composer and the
  // filename still reaches the model. So a `.yaml`, a `.go`, a `Dockerfile` or
  // anything else outside the list arrived as a name with no content, and the
  // model answered about a file nobody had read. That is a worse outcome than
  // refusing the upload, because it is indistinguishable from success.
  //
  // Extraction is total now: known formats have real extractors, unknown ones are
  // sniffed and read as text when they are text, and a genuine binary comes back
  // identified rather than dropped. So there is nothing left for this to say no
  // to. It stays exported and stays called, because "is this a file we read as
  // text at all" is still the question the call site is asking, and images are
  // still the answer "no".
  return !isImageFile(file);
  // Images are deliberately excluded. An image has no text layer to extract, so
  // "extracting" one means an OCR call, and doing that here would bill every
  // image upload — including the photo the user just wants looked at — and
  // report a text-free picture as an unreadable file. That case belongs to the
  // `ocr_image` tool, which the model calls only when the image is a document.
  // See src/lib/tools/ocr-image.ts for the full reasoning.
}

// ---------------------------------------------------------------------------
// Bytes: decoding, sniffing, identifying
// ---------------------------------------------------------------------------

/**
 * Decode bytes to a string, honouring a byte-order mark.
 *
 * Windows tools export .txt and .csv as UTF-16 more often than is comfortable, and
 * UTF-16 read as UTF-8 is not merely mangled: every other byte is NUL, so the
 * text sniff below calls it binary and the file is reported unreadable. A
 * three-byte check fixes a whole class of "it says my file is empty".
 */
function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** The first `MAX_SNIFF_BYTES` of a file, for identification. */
async function sniffBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, MAX_SNIFF_BYTES).arrayBuffer());
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * Whether a byte prefix reads as text.
 *
 * The test is what a human means by "can I open this in a text editor": it
 * decodes, and what comes out is mostly not control characters. Two thresholds
 * rather than one absolute rule, because both failure directions are real. A
 * single stray NUL is decisive (no text format contains one, every binary does),
 * while a *few* bad bytes are not: a UTF-8 file with one truncated character at
 * the slice boundary, or a legacy Latin-1 file with a handful of accented bytes,
 * is still a text file the user wants read.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  // A BOM is a positive declaration; trust it and skip the heuristics.
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    return true;
  }

  if (bytes.includes(0x00)) return false;

  // `fatal: false` so invalid sequences become U+FFFD and get counted, rather
  // than throwing and losing the ratio that decides the answer.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let bad = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // C0 controls other than tab/newline/carriage-return, plus DEL, plus the
    // replacement character the decoder emits for invalid UTF-8.
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f || code === 0xfffd) {
      bad++;
    }
  }
  return bad / text.length < 0.1;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Name a binary format from its leading bytes.
 *
 * Magic numbers rather than the extension, because the extension is exactly what
 * is missing or wrong in the cases this path exists for. Returns null when
 * nothing matches, and the caller falls back to the declared MIME type or to
 * "binary file" — an honest unknown is the point, and guessing here would put a
 * confident wrong format name in front of the model.
 */
export function identifyBinary(bytes: Uint8Array): string | null {
  const signatures: Array<[number[], string, number?]> = [
    [ascii("%PDF"), "PDF document"],
    [[0x50, 0x4b, 0x03, 0x04], "ZIP archive"],
    [[0x1f, 0x8b], "gzip archive"],
    [ascii("BZh"), "bzip2 archive"],
    [[0xfd, 0x37, 0x7a, 0x58, 0x5a], "xz archive"],
    [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], "7-Zip archive"],
    [ascii("Rar!"), "RAR archive"],
    [[0x28, 0xb5, 0x2f, 0xfd], "Zstandard archive"],
    [[0xd0, 0xcf, 0x11, 0xe0], "legacy Microsoft Office document (OLE2)"],
    [[0x89, 0x50, 0x4e, 0x47], "PNG image"],
    [[0xff, 0xd8, 0xff], "JPEG image"],
    [ascii("GIF8"), "GIF image"],
    [ascii("BM"), "BMP image"],
    [[0x00, 0x00, 0x01, 0x00], "ICO icon"],
    [ascii("8BPS"), "Photoshop document"],
    [ascii("ftyp"), "MP4/QuickTime media", 4],
    [ascii("ID3"), "MP3 audio"],
    [[0xff, 0xfb], "MP3 audio"],
    [ascii("OggS"), "Ogg media"],
    [ascii("fLaC"), "FLAC audio"],
    [ascii("wOFF"), "WOFF font"],
    [ascii("wOF2"), "WOFF2 font"],
    [ascii("OTTO"), "OpenType font"],
    [[0x00, 0x01, 0x00, 0x00], "TrueType font"],
    [ascii("SQLite format 3"), "SQLite database"],
    [[0x7f, 0x45, 0x4c, 0x46], "Linux executable (ELF)"],
    [ascii("MZ"), "Windows executable"],
    [[0xca, 0xfe, 0xba, 0xbe], "Java class file"],
    [[0x00, 0x61, 0x73, 0x6d], "WebAssembly module"],
    [[0xcf, 0xfa, 0xed, 0xfe], "macOS executable (Mach-O)"],
    [ascii("ustar"), "TAR archive", 257],
  ];

  // RIFF and matroska carry their real format a few bytes in.
  if (startsWith(bytes, ascii("RIFF"))) {
    const kind = new TextDecoder().decode(bytes.subarray(8, 12));
    if (kind === "WAVE") return "WAV audio";
    if (kind === "AVI ") return "AVI video";
    if (kind === "WEBP") return "WebP image";
    return "RIFF container";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "Matroska/WebM video";

  for (const [signature, label, offset] of signatures) {
    if (startsWith(bytes, signature, offset)) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-format extractors
// ---------------------------------------------------------------------------

/**
 * Render a pdfjs page to a PNG data URL at a legible scale, the input the
 * nemotron-parse service expects. The scale is a balance: too low and small body
 * text grows illegible to the OCR model; too high and the data URL balloons past
 * what a serverless function will happily forward. 1.5 reads standard body text
 * on a letter-size page cleanly. Returns null if rendering itself fails — that
 * page then falls back to its (empty) text-layer result rather than aborting the
 * whole document.
 */
async function renderPageToDataUrl(
  page: { getViewport: (o: { scale: number }) => { width: number; height: number } } & {
    render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => Promise<unknown>;
  },
  scale = 1.5,
): Promise<string | null> {
  try {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, viewport });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * The notices appended after a PDF's page blocks, telling the model what it did
 * not get.
 *
 * Pure and exported so the rule that matters here is testable without a real
 * scanned PDF: **a document that fitted the budget must not be described as
 * partial.** The version this replaced tested `i <= doc.numPages` — the loop's
 * own condition, so always true — and therefore announced a budget overrun on
 * every complete ten-page scan, leaving the model to hedge about a file it had
 * read in full.
 */
export function pdfCoverageNotices(
  unreadScanPages: number,
  lastPageScanned: number,
  totalPages: number,
): string[] {
  const notices: string[] = [];
  if (unreadScanPages > 0) {
    notices.push(
      `--- (${unreadScanPages} further scanned ${unreadScanPages === 1 ? "page was" : "pages were"} not OCR-ed: the document exceeded the ${OCR_PAGE_BUDGET}-page OCR budget) ---`,
    );
  }
  if (totalPages > lastPageScanned) {
    notices.push(`--- (pages ${lastPageScanned + 1}-${totalPages} were not read) ---`);
  }
  return notices;
}

async function extractPdf(file: File): Promise<{ text: string; units: number }> {
  // Vite needs the worker resolved explicitly; without this pdf.js tries to
  // fetch a worker path that does not exist in the built bundle.
  const pdfjs = await import("pdfjs-dist");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  const pages: string[] = [];
  // Tracked rather than recomputed: `pages.join(...).length` inside the loop is
  // quadratic, and the whole point of the early break is that this runs on
  // 500-page files.
  let size = 0;
  let ocrBudget = OCR_PAGE_BUDGET;
  // Scanned pages reached after the budget ran out. Counted rather than flagged
  // so the closing notice can say how many pages went unread — and so a scan that
  // fits entirely inside the budget produces no notice at all.
  let unreadScanPages = 0;
  const lastPage = Math.min(doc.numPages, MAX_PDF_PAGES_SCANNED);

  for (let i = 1; i <= lastPage; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    let block = pageText ? `--- Page ${i} ---\n${pageText}` : "";

    // No text layer means a scanned page (an image of text). Render it and run
    // OCR instead of leaving it silently empty. This is the case the old code
    // punted on with "upload it as an image instead"; the re-upload is now the
    // app's job, not the user's.
    if (!pageText) {
      if (ocrBudget > 0) {
        ocrBudget--;
        const dataUrl = await renderPageToDataUrl(page as never);
        if (dataUrl) {
          const ocr = await ocrImage(dataUrl);
          if (ocr.text) block = `--- Page ${i} (OCR) ---\n${ocr.text}`;
          // ocr.text === "" with no error is an honest "no text on this page"
          // (a blank or decorative sheet) — leave block empty and move on.
        }
      } else {
        // Out of OCR budget. Keep scanning rather than breaking: later pages may
        // carry a text layer, and reading those costs nothing. A PDF with a
        // scanned cover and forty digital pages must not lose the forty.
        unreadScanPages++;
      }
    }

    if (block) {
      pages.push(block);
      size += block.length + 2;
    }

    // Stop early on very long PDFs; the cap would discard the rest anyway and
    // parsing every page of a 500-page file just to throw it away is wasteful.
    if (size > MAX_CHARS_PER_DOC) break;
  }

  // Say what was left out, so the model reports "I read the first ten scanned
  // pages" instead of implying it saw the whole file. Each notice is omitted when
  // its count is zero — see pdfCoverageNotices for why that matters.
  pages.push(...pdfCoverageNotices(unreadScanPages, lastPage, doc.numPages));

  return { text: pages.join("\n\n"), units: doc.numPages };
}

async function extractDocx(file: File): Promise<{ text: string }> {
  const mammoth = await import("mammoth");
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return { text: result.value.trim() };
}

async function extractSpreadsheet(file: File): Promise<{ text: string; units: number }> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });

  const sheets: string[] = [];
  let size = 0;
  for (const name of wb.SheetNames) {
    // CSV rather than JSON: it carries the same information in far fewer
    // tokens, which matters when the whole point is fitting in a context window.
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    if (csv.trim()) {
      const block = `--- Sheet: ${name} ---\n${csv.trim()}`;
      sheets.push(block);
      size += block.length + 2;
    }
    if (size > MAX_CHARS_PER_DOC) break;
  }

  return { text: sheets.join("\n\n"), units: wb.SheetNames.length };
}

/**
 * Decode the XML entities a `.pptx` body carries.
 *
 * The slide extractor below reads text straight out of the XML with a regex, and
 * XML text nodes are escaped: a slide that reads "Q&A — 20% < 30%" is stored as
 * `Q&amp;A — 20% &lt; 30%`. Without this the model is handed the escaped form and
 * quotes it back that way, which is a wrong reading of the user's own document.
 * `&amp;` is decoded last so `&amp;lt;` survives as the literal text `&lt;`.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

async function extractPptx(file: File): Promise<{ text: string; units: number }> {
  // A .pptx is a zip of per-slide XML. Pulling the text nodes out directly
  // avoids adding a dedicated presentation parser for a rarely-used format.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const n = (s: string) => Number(s.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      return n(a) - n(b);
    });

  const slides: string[] = [];
  let size = 0;
  for (let i = 0; i < slidePaths.length; i++) {
    const xml = await zip.files[slidePaths[i]].async("string");
    const text = decodeXmlEntities(
      (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [])
        .map((m) => m.replace(/<\/?a:t>/g, ""))
        .join(" "),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      const block = `--- Slide ${i + 1} ---\n${text}`;
      slides.push(block);
      size += block.length + 2;
    }
    // Same early break as the other long formats: a 300-slide deck is past the
    // cap long before the last slide, and unzipping the rest is wasted work.
    if (size > MAX_CHARS_PER_DOC) break;
  }

  return { text: slides.join("\n\n"), units: slidePaths.length };
}

/**
 * Read a file as text.
 *
 * Bounded and BOM-aware, neither of which `file.text()` is. The bound matters
 * because `truncate` discards everything past 120k characters anyway, so reading a
 * 400 MB log in full is 400 MB of string allocation to throw away 99.9% of it —
 * and on a big enough file that is the tab crashing rather than a slow answer.
 */
async function extractPlainText(file: File): Promise<{ text: string }> {
  const slice = file.size > MAX_TEXT_BYTES ? file.slice(0, MAX_TEXT_BYTES) : file;
  let text = decodeText(await slice.arrayBuffer());
  // Cutting at a byte offset can land mid-character, and the decoder marks that
  // with a replacement character. Drop it rather than hand the model a glyph that
  // is not in their file.
  if (file.size > MAX_TEXT_BYTES) text = text.replace(/�+$/, "");
  return { text: text.trim() };
}

/**
 * OpenDocument: .odt, .ods, .odp and friends.
 *
 * A zip with the whole document in `content.xml`, so jszip — already here for
 * .pptx — is the entire dependency. The tags are read with regexes rather than a
 * DOM parse for the same reason .pptx is: this is a text extraction, not a
 * fidelity-preserving import, and one regex pass over one entry is far cheaper
 * than instantiating a parser for a format most users never send.
 */
async function extractOpenDocument(file: File): Promise<{ text: string }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const entry = zip.file("content.xml");
  if (!entry) throw new Error("Not an OpenDocument file (no content.xml).");
  const xml = await entry.async("string");

  const text = decodeXmlEntities(
    xml
      // A table cell wraps its contents in `<text:p>` like everything else in
      // ODF, so the paragraph rule below would fire inside every cell and put a
      // newline in front of the cell's own tab: `a\n\tb` instead of `a\tb`, which
      // is a table with one column per row. Drop the paragraph break only where it
      // is the last thing in a cell — a genuinely multi-paragraph cell keeps its
      // internal breaks.
      .replace(/<\/text:(?:p|h)>(\s*<\/table:table-(?:cell|row)>)/g, "$1")
      // Structure next, while the tags that carry it still exist. Rows and
      // paragraphs are line breaks; cells are columns; ODF's explicit space and
      // tab elements are the characters they stand for.
      .replace(/<text:s\/>/g, " ")
      .replace(/<text:s [^>]*\/>/g, " ")
      .replace(/<text:tab\/>/g, "\t")
      .replace(/<text:line-break\/>/g, "\n")
      .replace(/<\/table:table-cell>/g, "\t")
      .replace(/<\/table:table-row>/g, "\n")
      .replace(/<\/text:(p|h)>/g, "\n")
      .replace(/<\/table:table>/g, "\n\n")
      // Then everything that is left is markup.
      .replace(/<[^>]+>/g, ""),
  )
    // A cell-per-tab layout leaves a trailing tab on every row.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text };
}

/**
 * EPUB: a zip of XHTML chapters.
 *
 * Read in *spine* order, which is the order the book is meant to be read in and
 * is not recoverable from the filenames: `chapter10.xhtml` sorts before
 * `chapter2.xhtml`, and plenty of publishers name their files by internal id
 * rather than by position at all. The spine lives in the OPF package file, whose
 * location lives in `META-INF/container.xml`, so both are followed. Filename
 * order is the fallback rather than the plan.
 */
async function extractEpub(file: File): Promise<{ text: string; units: number }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const htmlPaths = Object.keys(zip.files).filter((p) => /\.(x?html|htm)$/i.test(p));

  let ordered = htmlPaths;
  try {
    const container = await zip.file("META-INF/container.xml")?.async("string");
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    const opf = opfPath ? await zip.file(opfPath)?.async("string") : undefined;
    if (opf && opfPath) {
      const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
      const manifest = new Map<string, string>();
      for (const item of opf.match(/<item\b[^>]*>/g) ?? []) {
        const id = item.match(/\bid="([^"]+)"/)?.[1];
        const href = item.match(/\bhref="([^"]+)"/)?.[1];
        if (id && href) manifest.set(id, dir + decodeURIComponent(href));
      }
      const spine = (opf.match(/<itemref\b[^>]*>/g) ?? [])
        .map((ref) => manifest.get(ref.match(/\bidref="([^"]+)"/)?.[1] ?? ""))
        .filter((p): p is string => !!p && !!zip.file(p));
      if (spine.length > 0) ordered = spine;
    }
  } catch {
    // A malformed container or OPF is not worth failing the whole book over;
    // filename order still produces a readable, if possibly misordered, text.
  }

  const chapters: string[] = [];
  let size = 0;
  for (const path of ordered) {
    const html = await zip.files[path].async("string");
    const text = htmlToText(html);
    if (text) {
      chapters.push(text);
      size += text.length + 2;
    }
    if (size > MAX_CHARS_PER_DOC) break;
  }

  return { text: chapters.join("\n\n"), units: ordered.length };
}

/**
 * Strip markup from an HTML fragment.
 *
 * `<script>` and `<style>` bodies are removed rather than stripped of their tags:
 * their contents are not prose, and a chapter that arrives with a minified
 * stylesheet inlined into it spends the context window on CSS.
 */
function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n")
      .replace(/<\/(td|th)>/gi, "\t")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " "),
  )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * RTF: text interleaved with control words.
 *
 * Worth a real extractor rather than the text fallback, even though an RTF file
 * *is* ASCII and so passes the sniff. What the fallback would produce is the
 * markup: `{\rtf1\ansi\deff0{\fonttbl…}` and a font table ahead of every
 * sentence. The model can read around that, but it costs tokens and invites it to
 * quote control words back as if they were the user's words.
 */
async function extractRtf(file: File): Promise<{ text: string }> {
  const raw = decodeText(await file.slice(0, MAX_TEXT_BYTES).arrayBuffer());

  const text = raw
    // Metadata groups: font tables, colour tables, stylesheets, and anything
    // marked ignorable. Their contents are not document text.
    .replace(/\{\\\*[\s\S]*?\}/g, "")
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info|listtable|listoverridetable)[\s\S]*?\}\}/g, "")
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info)[^{}]*\}/g, "")
    // Escaped literals, before the control-word sweep eats their backslashes.
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, code) => String.fromCodePoint(((Number(code) % 65536) + 65536) % 65536))
    .replace(/\\(par|line|page)\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\\(?:emdash|endash)\b/g, "-")
    .replace(/\\(?:lquote|rquote)\b/g, "'")
    .replace(/\\(?:ldblquote|rdblquote)\b/g, '"')
    // Remaining control words, then escaped braces, then the group braces.
    .replace(/\\[a-z]+-?\d*\s?/gi, "")
    .replace(/\\([{}\\])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text };
}

/**
 * Jupyter notebook: JSON, and readable as text, but not usefully.
 *
 * A raw read hands the model the serialised form — every line of every cell as a
 * JSON string array, with `\n` written out, wrapped in metadata — and, far worse,
 * every rendered plot as a multi-megabyte base64 PNG inside `outputs`. One chart
 * can exceed the whole context budget on its own. So the cells are unwrapped into
 * the notebook as a person reads it, and image outputs are named rather than
 * included.
 */
async function extractNotebook(file: File): Promise<{ text: string; units: number }> {
  const nb = JSON.parse(decodeText(await file.arrayBuffer())) as {
    cells?: Array<{
      cell_type?: string;
      source?: string | string[];
      outputs?: Array<{ output_type?: string; text?: string | string[]; data?: Record<string, unknown>; ename?: string; evalue?: string }>;
    }>;
    metadata?: { kernelspec?: { language?: string } };
  };
  const cells = nb.cells ?? [];
  const language = nb.metadata?.kernelspec?.language ?? "python";
  const flatten = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join("") : s ?? "");

  const blocks: string[] = [];
  let size = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const source = flatten(cell.source).trim();
    if (!source && !cell.outputs?.length) continue;

    if (cell.cell_type === "markdown" || cell.cell_type === "raw") {
      if (source) blocks.push(source);
    } else {
      // `fenceFor`, not a literal ```: a cell that prints markdown — or holds a
      // docstring with a fenced example in it — closes a three-backtick wrapper
      // early, and the rest of the cell reaches the model as prose.
      const fence = fenceFor(source);
      const parts = [`${fence}${language}\n${source}\n${fence}`];
      for (const out of cell.outputs ?? []) {
        if (out.output_type === "error") {
          parts.push(`Output (error): ${out.ename}: ${out.evalue}`);
          continue;
        }
        const plain = flatten(out.text) || flatten((out.data?.["text/plain"] as string | string[]) ?? "");
        if (plain.trim()) {
          // Bounded per output: a training loop's progress log is thousands of
          // near-identical lines and the first few carry all the information.
          const trimmed = plain.trim();
          parts.push(`Output:\n${trimmed.length > 2_000 ? trimmed.slice(0, 2_000) + "\n… (output truncated)" : trimmed}`);
        } else if (out.data) {
          const kinds = Object.keys(out.data).filter((k) => k !== "text/plain");
          if (kinds.length) parts.push(`Output: [${kinds.join(", ")}]`);
        }
      }
      blocks.push(parts.join("\n\n"));
    }
    size = blocks[blocks.length - 1] ? size + blocks[blocks.length - 1].length + 2 : size;
    if (size > MAX_CHARS_PER_DOC) break;
  }

  return { text: blocks.join("\n\n"), units: cells.length };
}

/**
 * Legacy binary Office: .doc, .ppt, .xls written before 2007.
 *
 * These are OLE2 compound files and parsing one properly needs a parser this app
 * does not ship. What it does instead is scavenge: the document text is in there
 * as contiguous runs of characters, in Latin-1 for .ppt and in UTF-16LE for .doc,
 * surrounded by structure that is not printable. Pulling the runs out gives real
 * sentences in the real order, with occasional junk between them.
 *
 * Both encodings are tried and the longer harvest wins, because the two are
 * mutually unreadable: run UTF-16LE text through the Latin-1 pass and every
 * character comes back followed by a NUL, which fails the printable-run test.
 *
 * This replaced a flat refusal that told the user to go and re-save their file.
 * A partial read of the document they actually have beats a correct instruction
 * they may not be able to follow — they may not own Word. When the harvest comes
 * back too thin to be a document, the refusal is still there as the fallback.
 */
export function scavengeText(bytes: Uint8Array, minRun = 6): string {
  const runs: string[] = [];

  const printable = (code: number) =>
    (code >= 0x20 && code < 0x7f) || code === 0x09 || code >= 0xa0;

  // Latin-1: one byte per character.
  let run = "";
  for (const byte of bytes) {
    if (printable(byte)) run += String.fromCharCode(byte);
    else {
      if (run.length >= minRun) runs.push(run);
      run = "";
    }
  }
  if (run.length >= minRun) runs.push(run);
  const latin = runs.join("\n");

  // UTF-16LE: two bytes, the high one zero for anything Latin.
  const wide: string[] = [];
  run = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (printable(code)) run += String.fromCharCode(code);
    else {
      if (run.length >= minRun) wide.push(run);
      run = "";
    }
  }
  if (run.length >= minRun) wide.push(run);
  const utf16 = wide.join("\n");

  return (utf16.length > latin.length ? utf16 : latin)
    .replace(/[ \t]{3,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractLegacyOffice(file: File): Promise<{ text: string }> {
  const bytes = new Uint8Array(await file.slice(0, MAX_TEXT_BYTES).arrayBuffer());
  return { text: scavengeText(bytes) };
}

/**
 * An archive we can open but whose contents are not one document: a .zip, a .jar,
 * an .apk, an unrecognised OOXML variant.
 *
 * Listing the entries is what "reading" a zip means. It is also genuinely the
 * answer to the most common question about one ("what's in this?"), and it lets
 * the model say something true about a file it otherwise could not open at all.
 * Text entries are *not* concatenated: a repository zip would blow the context
 * window, and the user who wants a file read can send that file.
 */
async function extractArchive(file: File): Promise<{ text: string; units: number }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const listed = entries.slice(0, MAX_ARCHIVE_ENTRIES);
  const lines = listed.map((f) => {
    // `_data.uncompressedSize` is jszip's internal field and is not on the public
    // type, so the size is optional here rather than assumed.
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    return size === undefined ? f.name : `${f.name} (${formatBytes(size)})`;
  });
  if (entries.length > listed.length) {
    lines.push(`… and ${entries.length - listed.length} more entries`);
  }

  return {
    text: [
      `This is an archive containing ${entries.length} ${entries.length === 1 ? "file" : "files"}.`,
      "Its entries are listed below. The contents of the individual files were not extracted;",
      "ask the user to attach a specific file from the archive if its contents are needed.",
      "",
      ...lines,
    ].join("\n"),
    units: entries.length,
  };
}

// ---------------------------------------------------------------------------
// The fallback: a file we were given no usable name for
// ---------------------------------------------------------------------------

/** What the extractors can return. Narrowed onto ExtractedDocument by the caller. */
type Extraction = { text: string; units?: number; binary?: boolean; detail?: string };

// A zip has to be fully in memory to be opened, so past this it is described from
// its magic bytes instead. The number is a memory bound, not a policy: a 200 MB
// archive would be ~400 MB of heap between the buffer and jszip's entry table,
// which on a laptop with the app already loaded is the tab dying rather than an
// answer arriving.
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * What kind of document a zip actually is, from the entries it contains.
 *
 * Every OOXML and OpenDocument format is a zip with a characteristic layout, so
 * the contents identify the format when the filename does not. This is the path
 * for a `.docx` that arrived as `attachment`, `report.bin`, or `Document (1)` —
 * downloads that lost their extension, files renamed by a chat app, exports from
 * a system that never set one.
 */
async function zipKind(file: File): Promise<"docx" | "xlsx" | "pptx" | "odf" | "epub" | "archive"> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const names = Object.keys(zip.files);
  const has = (prefix: string) => names.some((n) => n.startsWith(prefix));

  if (has("word/document.xml")) return "docx";
  if (has("xl/workbook.xml") || has("xl/worksheets/")) return "xlsx";
  if (has("ppt/slides/")) return "pptx";
  if (names.includes("content.xml") && names.includes("META-INF/manifest.xml")) return "odf";
  if (names.includes("mimetype") && has("META-INF/container.xml")) return "epub";
  return "archive";
}

/**
 * Read a file whose name told us nothing.
 *
 * The point of the whole tier: every file gets an answer, and the answer is
 * derived from the bytes rather than from the extension, because the extension is
 * precisely what is missing or wrong in the cases that reach here. In order:
 * identify the format from its magic number and re-dispatch to a real extractor if
 * one exists, then fall back to reading it as text if it reads as text, then
 * report honestly what it is.
 *
 * The last branch is the one worth defending. Returning "cannot read .mp4 files"
 * looks like the same thing but is not: an `error` gets toasted at the user, who
 * knows perfectly well they attached a video, and the model is told a failure
 * happened rather than told what the file is. A model that knows it has been given
 * a 12 MB MP4 can say something useful about it. A model told nothing invents
 * contents, which is the exact failure this whole module exists to stop.
 */
async function extractUnknown(file: File): Promise<Extraction> {
  const bytes = await sniffBytes(file);
  const format = identifyBinary(bytes);

  if (format === "PDF document") return extractPdf(file);

  if (format === "ZIP archive" && file.size <= MAX_ARCHIVE_BYTES) {
    switch (await zipKind(file)) {
      case "docx": return extractDocx(file);
      case "xlsx": return extractSpreadsheet(file);
      case "pptx": return extractPptx(file);
      case "odf": return extractOpenDocument(file);
      case "epub": return extractEpub(file);
      case "archive": return extractArchive(file);
    }
  }

  // OLE2: a pre-2007 Office file, or something else built on the same container.
  // The scavenge is the only reader available for it either way.
  if (format === "legacy Microsoft Office document (OLE2)") {
    const scavenged = await extractLegacyOffice(file);
    if (scavenged.text.length > 200) return scavenged;
  }

  if (looksLikeText(bytes)) return extractPlainText(file);

  return {
    text: "",
    binary: true,
    detail: [format ?? file.type ?? "", formatBytes(file.size)].filter(Boolean).join(", "),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract readable text from a file.
 *
 * Never throws: a failed extraction is reported in the `error` field so the
 * caller can tell the user which file could not be read and still send the
 * rest. Throwing would lose the whole turn over one bad attachment.
 *
 * Never gives up either, which is the newer half. The dispatch below is three
 * tiers: formats with a dedicated parser, then names that say "text", then
 * `extractUnknown`, which decides from the bytes and always returns something.
 * There is no "unsupported file type" branch left, because the branch that used to
 * be there was the bug — a `.yaml` or a `Dockerfile` hit it, the caller dropped
 * the file without a word, and the model answered from the filename alone.
 */
export async function extractDocument(
  file: File,
  /**
   * The attachment's id, if the caller assigned one. Threaded through to the
   * returned document so a later `buildDocumentContext` call can surface it for
   * the model to reference from edit_file. Optional and unused for extraction
   * itself.
   */
  id?: string,
): Promise<ExtractedDocument> {
  const ext = extensionOf(file.name);
  const base = { name: file.name, mimeType: file.type || `application/${ext}`, ...(id ? { id } : {}) };

  try {
    let raw: Extraction;

    // Tier 1: formats with a parser. Keyed on the extension because that is what
    // is right in the overwhelming majority of uploads; when it is wrong, the
    // parser throws and the catch below reports it, and when it is *absent* the
    // magic-number dispatch in tier 3 recovers the same formats from the bytes.
    if (ext === "pdf") raw = await extractPdf(file);
    else if (ext === "docx" || ext === "docm") raw = await extractDocx(file);
    else if (ext === "xlsx" || ext === "xls" || ext === "xlsm" || ext === "xlsb") raw = await extractSpreadsheet(file);
    else if (ext === "pptx" || ext === "pptm") raw = await extractPptx(file);
    else if (OPENDOCUMENT_EXTENSIONS.has(ext)) raw = await extractOpenDocument(file);
    else if (ext === "epub") raw = await extractEpub(file);
    else if (ext === "rtf") raw = await extractRtf(file);
    else if (ext === "ipynb") raw = await extractNotebook(file);
    // Tier 2: the name says text. Checked after the parsers so `.svg` and `.xml`
    // still route here while `.docx` does not, and before the sniff so a code file
    // never pays for a byte inspection.
    else if (nameLooksTextual(file)) raw = await extractPlainText(file);
    else if (ext === "doc" || ext === "ppt") {
      // Was a flat refusal: "save it as docx and re-upload". The scavenge gets
      // real sentences out of an OLE2 file, so the refusal is now the fallback for
      // when it comes back too thin to be a document rather than the first answer.
      raw = await extractLegacyOffice(file);
      if (raw.text.length < 200) {
        return {
          ...base,
          text: "",
          error: `${ext.toUpperCase()} is a legacy binary format and little readable text could be recovered. Please save it as ${ext}x and re-upload.`,
        };
      }
    } else if (ext === "zip" || ext === "jar" || ext === "apk" || ext === "aar" || ext === "war" || ext === "whl" || ext === "crx" || ext === "vsix" || ext === "nupkg") {
      raw = file.size <= MAX_ARCHIVE_BYTES
        ? await extractArchive(file)
        : { text: "", binary: true, detail: `${ext.toUpperCase()} archive, ${formatBytes(file.size)}, too large to open` };
    } else if (OPAQUE_ARCHIVE_EXTENSIONS.has(ext)) {
      // Openable in principle, but every one of these needs a decompressor this
      // app does not ship. Named rather than attempted.
      raw = { text: "", binary: true, detail: `${ext.toUpperCase()} archive, ${formatBytes(file.size)}` };
    }
    // Tier 3: ask the bytes.
    else raw = await extractUnknown(file);

    // A binary is not a failure, so it skips the empty-text check below: `text` is
    // legitimately "" and `detail` carries the whole answer.
    if (raw.binary) {
      return { ...base, text: "", binary: true, detail: raw.detail, units: raw.units };
    }

    if (!raw.text) {
      return {
        ...base,
        text: "",
        // For a PDF the scan case is handled inside extractPdf (OCR runs on
        // pages with no text layer), so an empty result here means the OCR
        // service was unavailable or the pages genuinely hold no text — an
        // honest "no readable text" rather than the old advice to re-upload the
        // file as an image, which is work the app now does itself.
        error: "No readable text found in this file (it may be blank, or a scan the OCR service could not read).",
        units: raw.units,
      };
    }

    const { text, truncated } = truncate(raw.text);
    return { ...base, text, truncated, units: raw.units };
  } catch (err) {
    console.error(`[documents] failed to extract ${file.name}:`, err);
    return {
      ...base,
      text: "",
      error: err instanceof Error ? err.message : "Extraction failed.",
    };
  }
}

/**
 * Render extracted documents as a context block for the model.
 *
 * Failures are included rather than omitted: a model told a file could not be
 * read will say so, whereas a model shown nothing will confidently answer as if
 * the document had been empty.
 *
 * Binaries get a third shape, distinct from both text and failure. "This is a
 * 12 MB MP4" is neither content nor an error, and collapsing it into either one
 * produces a wrong reply: as content the model invents what is in the video, and
 * as an error it apologises for a problem that does not exist.
 */
export function buildDocumentContext(docs: ExtractedDocument[]): string | null {
  if (docs.length === 0) return null;

  const blocks = docs.map((doc) => {
    if (doc.error) {
      return `--- FILE: ${doc.name} ---\n[Could not be read: ${doc.error}]`;
    }
    if (doc.binary) {
      return [
        `--- FILE: ${doc.name}${doc.detail ? ` (${doc.detail})` : ""} ---`,
        "[This file holds no readable text, so none is included. This is not an error and nothing failed:",
        "it is simply a binary format. Say what the file is and answer whatever the user asked about it.",
        "Do NOT guess at, summarise, or describe its contents.]",
      ].join("\n");
    }
    const notes: string[] = [];
    if (doc.id) notes.push(`attachment_id: ${doc.id}`);
    if (doc.units) notes.push(`${doc.units} ${doc.units === 1 ? "part" : "parts"}`);
    if (doc.truncated) notes.push("truncated to fit the context window");
    const header = notes.length > 0 ? `${doc.name} (${notes.join(", ")})` : doc.name;

    return `--- FILE: ${header} ---\n${doc.text}`;
  });

  return [
    "The user attached the following file(s). Their full text is below.",
    "Answer using this content. If a file was truncated, say so when the answer might depend on the missing part.",
    "Never invent content that is not present in these files.",
    "Each file carries an attachment_id. If the user asks you to change, update, edit, fix, or rework one of these files, call edit_file with that attachment_id, the instructions, and the full modified content — do not say you cannot edit it.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
