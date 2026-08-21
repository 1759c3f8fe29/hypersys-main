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

// OCR fallback for scanned PDFs — pages that carry no text layer at all.
// `nemotron-parse` is a non-conversational service live on the NVIDIA endpoint
// (verified via scripts/verify-models.mjs); a plain text layer stays the fast
// path and only an empty page routes through OCR, so a normal PDF never pays the
// cost. Image *uploads* are deliberately not handled here — that case belongs to
// the `ocr_image` tool, which the model calls when it judges the image to be a
// document. See src/lib/tools/ocr-image.ts.
import { ocrImage } from "./ai";

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

const TEXT_LIKE_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "yaml", "yml",
  "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "sql", "html", "css",
  "scss", "less", "vue", "svelte", "toml", "ini", "env", "dockerfile", "makefile",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
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
  const ext = extensionOf(file.name);
  return (
    ext === "pdf" ||
    ext === "docx" ||
    ext === "xlsx" || ext === "xls" ||
    ext === "pptx" ||
    TEXT_LIKE_EXTENSIONS.has(ext) ||
    file.type.startsWith("text/")
  );
  // Images are deliberately absent. An image has no text layer to extract, so
  // "extracting" one means an OCR call, and doing that here would bill every
  // image upload — including the photo the user just wants looked at — and
  // report a text-free picture as an unreadable file. That case belongs to the
  // `ocr_image` tool, which the model calls only when the image is a document.
  // See src/lib/tools/ocr-image.ts for the full reasoning.
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

async function extractPlainText(file: File): Promise<{ text: string }> {
  const text = await file.text();
  return { text: text.trim() };
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
    let raw: { text: string; units?: number };

    if (ext === "pdf") raw = await extractPdf(file);
    else if (ext === "docx") raw = await extractDocx(file);
    else if (ext === "xlsx" || ext === "xls") raw = await extractSpreadsheet(file);
    else if (ext === "pptx") raw = await extractPptx(file);
    else if (TEXT_LIKE_EXTENSIONS.has(ext) || file.type.startsWith("text/")) {
      raw = await extractPlainText(file);
    } else if (ext === "doc" || ext === "ppt") {
      // Legacy binary Office formats need a different parser entirely; saying so
      // is better than returning empty text that reads as an empty document.
      return {
        ...base,
        text: "",
        error: `${ext.toUpperCase()} is a legacy format. Please save it as ${ext}x and re-upload.`,
      };
    } else {
      return { ...base, text: "", error: `Cannot read .${ext} files.` };
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
 */
export function buildDocumentContext(docs: ExtractedDocument[]): string | null {
  if (docs.length === 0) return null;

  const blocks = docs.map((doc) => {
    if (doc.error) {
      return `--- FILE: ${doc.name} ---\n[Could not be read: ${doc.error}]`;
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
