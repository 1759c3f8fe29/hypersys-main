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
}

// ---------------------------------------------------------------------------
// Per-format extractors
// ---------------------------------------------------------------------------

async function extractPdf(file: File): Promise<{ text: string; units: number }> {
  // Vite needs the worker resolved explicitly; without this pdf.js tries to
  // fetch a worker path that does not exist in the built bundle.
  const pdfjs = await import("pdfjs-dist");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) pages.push(`--- Page ${i} ---\n${pageText}`);

    // Stop early on very long PDFs; the cap would discard the rest anyway and
    // parsing every page of a 500-page file just to throw it away is wasteful.
    if (pages.join("\n\n").length > MAX_CHARS_PER_DOC) break;
  }

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
  for (const name of wb.SheetNames) {
    // CSV rather than JSON: it carries the same information in far fewer
    // tokens, which matters when the whole point is fitting in a context window.
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    if (csv.trim()) sheets.push(`--- Sheet: ${name} ---\n${csv.trim()}`);
    if (sheets.join("\n\n").length > MAX_CHARS_PER_DOC) break;
  }

  return { text: sheets.join("\n\n"), units: wb.SheetNames.length };
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
  for (let i = 0; i < slidePaths.length; i++) {
    const xml = await zip.files[slidePaths[i]].async("string");
    const text = (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [])
      .map((m) => m.replace(/<\/?a:t>/g, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) slides.push(`--- Slide ${i + 1} ---\n${text}`);
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
        // The most common cause for a PDF is that it is a scan, which needs OCR
        // rather than text extraction. Naming that saves the user guessing.
        error:
          ext === "pdf"
            ? "No text found — this PDF is likely a scan. Try uploading it as an image instead."
            : "No readable text found in this file.",
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
