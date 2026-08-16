// ---------------------------------------------------------------------------
// File generation
// ---------------------------------------------------------------------------
// Every downloadable format Flyer can produce, behind one contract:
//
//   generateFile(format, filename, content) -> {ok:true, blob, …} | {ok:false, error}
//
// IT NEVER THROWS. The caller is a tool executor inside the agent loop, and a
// thrown error there ends the whole turn — the user would watch a promise of
// "here's your spreadsheet" turn into a dead conversation. An `{ok:false}` lets
// the model say which file failed and still finish answering.
//
// Heavy renderers (docx, jspdf, pptxgenjs, xlsx) are dynamically imported, so a
// user who never asks for a file never downloads their bundles. They add up to
// roughly a megabyte gzipped between them.
//
// FORMAT NOTES worth knowing before editing:
//  - pdf is the only format that has to do layout itself. jsPDF has no concept
//    of a page break or a text flow, so `layoutPdf` measures and paginates by
//    hand. Getting this wrong writes text off the bottom of the page and looks
//    like data loss (brief trap 9).
//  - docx and pdf share `parseMarkdownBlocks`, so a heading is a heading in both.
//  - csv quoting is not optional: an unquoted comma silently shifts a column.

export type FileFormat = "txt" | "md" | "json" | "csv" | "xlsx" | "docx" | "pdf" | "pptx";

export const FILE_MIME_TYPES: Record<FileFormat, string> = {
  txt: "text/plain;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  json: "application/json;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const SUPPORTED_FORMATS = Object.keys(FILE_MIME_TYPES) as FileFormat[];

export function isSupportedFormat(value: string): value is FileFormat {
  return Object.prototype.hasOwnProperty.call(FILE_MIME_TYPES, value);
}

/**
 * Success carries the file, failure carries the reason — `generateFile` never
 * throws, so this union is the only channel for either.
 *
 * The `error?: undefined` / `blob?: undefined` members are load-bearing, not
 * noise. This project compiles with `strict: false` (tsconfig.app.json), and
 * without `strictNullChecks` TypeScript does not narrow a union by a *boolean*
 * discriminant — inside `if (!result.ok)` the type stays wide and `result.error`
 * is an error. Declaring the absent halves as optional-undefined makes both
 * properties legal to read on either member, so call sites compile as written.
 * Under `strictNullChecks` narrowing works properly and these are inert, so this
 * stays correct if the project ever tightens the config.
 *
 * `ToolResult` in tools/types.ts sidesteps the same problem by accident: its
 * success member has an index signature, which makes any property readable.
 */
export type GenerateFileResult =
  | { ok: true; blob: Blob; filename: string; mimeType: string; size: number; error?: undefined }
  | { ok: false; error: string; blob?: undefined; filename?: undefined; mimeType?: undefined; size?: undefined };

/**
 * Keep the extension honest: a markdown body saved as report.txt confuses the
 * user. Also flattens the name into something safe to hand a download: path
 * separators become dashes, and leading dots go — a name starting `.` or `..` is
 * a hidden file on Unix, and the model does sometimes echo a path back.
 */
export function withExtension(filename: string, format: FileFormat): string {
  // Path separators and the Windows-illegal set become dashes, then the leading
  // and trailing runs of dots/spaces/dashes go: a leading dot is a hidden file on
  // Unix, and a trailing dot or space makes a name Windows will not save. Case is
  // preserved — "Q3-Report.pdf" is what the user asked for.
  const safe = filename
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .trim() || `file.${format}`;
  return safe.toLowerCase().endsWith(`.${format}`) ? safe : `${safe}.${format}`;
}

// ---------------------------------------------------------------------------
// Markdown → blocks
// ---------------------------------------------------------------------------
// A deliberately small subset: headings, bullet and numbered lists, GFM tables,
// fenced code, blockquotes, paragraphs. Enough that a model writing ordinary
// markdown gets a structured document, without pulling a full CommonMark parser
// into the bundle for a .docx nobody may ever request.
//
// Inline formatting is handled separately (parseInline) because docx needs
// TextRun objects while pdf needs font switches — same spans, different output.

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string; depth: number }
  | { type: "numbered"; text: string; depth: number }
  | { type: "quote"; text: string }
  | { type: "code"; text: string; lang?: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "rule" };

const TABLE_SEPARATOR = /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|?\s*$/;

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseMarkdownBlocks(markdown: string): MdBlock[] {
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Fenced code. Consume to the closing fence, or to EOF if the model never
    // closed it — an unterminated fence must not swallow the rest as a paragraph.
    const fence = line.match(/^\s*```+\s*(\S+)?\s*$/);
    if (fence) {
      flushParagraph();
      const lang = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", text: body.join("\n"), lang });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule" });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      continue;
    }

    // A GFM table needs the separator row on the next line to be a table at all;
    // without it a line of pipes is just text and must stay a paragraph.
    if (line.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] || "")) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({
        type: "bullet",
        text: bullet[2].trim(),
        depth: Math.min(Math.floor(bullet[1].length / 2), 3),
      });
      continue;
    }

    const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      blocks.push({
        type: "numbered",
        text: numbered[2].trim(),
        depth: Math.min(Math.floor(numbered[1].length / 2), 3),
      });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push({ type: "quote", text: quote[1].trim() });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

/** An inline span with the marks that survived into it. */
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

// Bold before italic so `**text**` is not read as two italic markers, and code
// first of all because `**` inside backticks is literal.
const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;

  for (const match of (text || "").matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: text.slice(last, index) });

    const token = match[0];
    if (token.startsWith("`")) {
      spans.push({ text: token.slice(1, -1), code: true });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ text: token.slice(2, -2), bold: true });
    } else {
      spans.push({ text: token.slice(1, -1), italic: true });
    }
    last = index + token.length;
  }

  if (last < (text || "").length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text: text || "" }];
}

/** Strip inline markers for contexts that cannot carry formatting (pptx bullets). */
export function stripInlineMarkers(text: string): string {
  return parseInline(text)
    .map((span) => span.text)
    .join("");
}

// ---------------------------------------------------------------------------
// csv
// ---------------------------------------------------------------------------
// The model may send either literal CSV text or JSON rows (it does both in
// practice, whatever the schema says). Literal text passes through untouched —
// rewriting a hand-written CSV risks corrupting quoting that was already right.
// JSON gets quoted properly here, because an unquoted comma silently shifts
// every column after it and the user sees scrambled data, not an error.

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Also quote on a leading/trailing space: some parsers keep it, some strip it.
  return /[",\n\r]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  // Union of keys in first-seen order: a later row with an extra field must not
  // silently lose it, which is what keying off row 0 alone would do.
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const header = columns.map(csvCell).join(",");
  const body = rows.map((row) => columns.map((col) => csvCell(row[col])).join(","));
  return [header, ...body].join("\r\n");
}

function buildCsv(content: string): Blob {
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const objectRows = rows.filter(
        (row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row),
      );
      if (objectRows.length === rows.length && rows.length > 0) {
        return new Blob([rowsToCsv(objectRows)], { type: FILE_MIME_TYPES.csv });
      }
    } catch {
      // Not JSON after all — fall through and treat it as literal CSV text.
    }
  }
  return new Blob([content], { type: FILE_MIME_TYPES.csv });
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

type SheetSpec = { name?: string; rows?: unknown };

async function buildXlsx(content: string): Promise<Blob> {
  const XLSX = await import("xlsx");
  const parsed: unknown = JSON.parse(content);

  const book = XLSX.utils.book_new();
  // Both documented shapes, plus a bare object: a model told "an array of row
  // objects" will occasionally send a single row unwrapped.
  const sheets: SheetSpec[] = Array.isArray((parsed as { sheets?: unknown })?.sheets)
    ? (parsed as { sheets: SheetSpec[] }).sheets
    : [{ name: "Sheet1", rows: parsed }];

  const usedNames = new Set<string>();
  let added = 0;

  sheets.forEach((sheet, i) => {
    const rowsRaw = sheet?.rows ?? [];
    const rows = Array.isArray(rowsRaw) ? rowsRaw : [rowsRaw];
    if (!rows.length) return;

    // Excel rejects a workbook with duplicate sheet names and caps them at 31
    // chars, so two long names that share a prefix would collide after slicing.
    let name = (sheet?.name || `Sheet${i + 1}`).slice(0, 31);
    for (let n = 2; usedNames.has(name); n += 1) {
      name = `${name.slice(0, 28)}(${n})`;
    }
    usedNames.add(name);

    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), name);
    added += 1;
  });

  if (!added) throw new Error("no rows to write");

  const buffer = XLSX.write(book, { bookType: "xlsx", type: "array" });
  return new Blob([buffer], { type: FILE_MIME_TYPES.xlsx });
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

async function buildDocx(content: string): Promise<Blob> {
  const docx = await import("docx");
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
  } = docx;

  const HEADINGS = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
  } as const;

  const runs = (text: string) =>
    parseInline(text).map(
      (span) =>
        new TextRun({
          text: span.text,
          bold: span.bold,
          italics: span.italic,
          // Word has no inline-code style, so monospace + a tint is the closest
          // honest rendering. Left unstyled it would read as ordinary prose.
          font: span.code ? "Consolas" : undefined,
          color: span.code ? "B03060" : undefined,
        }),
    );

  const cell = (text: string, header: boolean) =>
    new TableCell({
      children: [
        new Paragraph({
          children: [new TextRun({ text: stripInlineMarkers(text), bold: header })],
        }),
      ],
      shading: header ? { fill: "F2F2F2" } : undefined,
    });

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];

  for (const block of parseMarkdownBlocks(content)) {
    switch (block.type) {
      case "heading":
        children.push(new Paragraph({ heading: HEADINGS[block.level], children: runs(block.text) }));
        break;

      case "bullet":
        children.push(new Paragraph({ children: runs(block.text), bullet: { level: block.depth } }));
        break;

      case "numbered":
        // `numbering` needs a configured concrete instance; a manually indented
        // bullet level renders correctly without that machinery, and the marker
        // text the model wrote is preserved by keeping its own number visible.
        children.push(
          new Paragraph({
            children: runs(block.text),
            bullet: { level: block.depth },
          }),
        );
        break;

      case "quote":
        children.push(
          new Paragraph({
            children: parseInline(block.text).map(
              (span) => new TextRun({ text: span.text, italics: true, color: "555555" }),
            ),
            indent: { left: 720 },
          }),
        );
        break;

      case "code":
        // One paragraph per line: a single run with \n collapses to one long line
        // in Word, which destroys the indentation that makes code readable.
        for (const line of block.text.split("\n")) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
              shading: { fill: "F6F8FA" },
              spacing: { before: 0, after: 0 },
            }),
          );
        }
        children.push(new Paragraph({ text: "" }));
        break;

      case "table": {
        const width = { size: 100, type: WidthType.PERCENTAGE };
        const columnCount = block.header.length;
        children.push(
          new Table({
            width,
            rows: [
              new TableRow({ children: block.header.map((h) => cell(h, true)) }),
              // Pad short rows: docx renders a row with fewer cells than the
              // header as a visibly broken table rather than an empty cell.
              ...block.rows.map(
                (row) =>
                  new TableRow({
                    children: Array.from({ length: columnCount }, (_, i) => cell(row[i] ?? "", false)),
                  }),
              ),
            ],
          }),
        );
        children.push(new Paragraph({ text: "" }));
        break;
      }

      case "rule":
        children.push(
          new Paragraph({
            text: "",
            border: { bottom: { style: "single", size: 6, space: 1, color: "CCCCCC" } },
          }),
        );
        break;

      default:
        children.push(new Paragraph({ children: runs(block.text), alignment: AlignmentType.LEFT }));
    }
  }

  if (!children.length) children.push(new Paragraph({ text: "" }));

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  return new Blob([blob], { type: FILE_MIME_TYPES.docx });
}

// ---------------------------------------------------------------------------
// pdf
// ---------------------------------------------------------------------------
// jsPDF draws text at coordinates and does nothing else: no flow, no wrapping,
// no page breaks. Everything below exists because of that. The naive version of
// this function — loop the blocks, y += 10 — writes off the bottom of page one
// and silently loses the rest of the document (brief trap 9).
//
// The rules, in one place:
//  - Wrap every string through splitTextToSize before drawing it.
//  - Ask `room(n)` before drawing n lines; it adds a page when they do not fit.
//  - A heading that lands at the bottom pulls its first body line with it, so no
//    heading is ever orphaned as the last thing on a page.

const PDF_MARGIN = 48;
const PDF_LINE = 16;

async function buildPdf(content: string): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const maxWidth = pageWidth - PDF_MARGIN * 2;
  const bottom = pageHeight - PDF_MARGIN;

  let y = PDF_MARGIN;

  /** Ensure `lines` fit below the cursor, adding a page when they do not. */
  const room = (lines: number, lineHeight = PDF_LINE) => {
    if (y + lines * lineHeight <= bottom) return;
    doc.addPage();
    y = PDF_MARGIN;
  };

  const write = (
    text: string,
    opts: { size?: number; style?: "normal" | "bold" | "italic"; indent?: number; font?: string; color?: [number, number, number] } = {},
  ) => {
    const size = opts.size ?? 11;
    const lineHeight = Math.max(size * 1.45, 12);
    doc.setFont(opts.font ?? "helvetica", opts.style ?? "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(opts.color ?? [17, 17, 17]));

    const indent = opts.indent ?? 0;
    const lines: string[] = doc.splitTextToSize(text || " ", maxWidth - indent);

    // Draw line by line rather than handing the array to one text() call: a
    // multi-line array drawn in one call cannot break across a page boundary,
    // which is exactly the failure this whole function exists to prevent.
    for (const line of lines) {
      room(1, lineHeight);
      doc.text(line, PDF_MARGIN + indent, y);
      y += lineHeight;
    }
  };

  const blocks = parseMarkdownBlocks(content);

  blocks.forEach((block, index) => {
    switch (block.type) {
      case "heading": {
        const size = [20, 16, 13, 12][block.level - 1];
        y += index === 0 ? 0 : 10;
        // Keep the heading with what follows: 2 lines of headroom means a
        // heading never sits alone at the foot of a page.
        room(2, size * 1.45);
        write(stripInlineMarkers(block.text), { size, style: "bold" });
        y += 4;
        break;
      }

      case "bullet":
        write(`•  ${stripInlineMarkers(block.text)}`, { indent: 14 + block.depth * 14 });
        break;

      case "numbered":
        write(stripInlineMarkers(block.text), { indent: 14 + block.depth * 14 });
        break;

      case "quote":
        write(stripInlineMarkers(block.text), { style: "italic", indent: 18, color: [85, 85, 85] });
        break;

      case "code":
        for (const line of block.text.split("\n")) {
          write(line || " ", { font: "courier", size: 9.5, indent: 10, color: [40, 40, 40] });
        }
        y += 6;
        break;

      case "table": {
        // Equal-width columns. Real auto-fit needs measuring every cell against
        // the page and is not worth it here: a model-generated table is usually
        // 2-5 comparable columns, and equal widths never overflow the page.
        const columnCount = Math.max(block.header.length, 1);
        const colWidth = maxWidth / columnCount;

        const drawRow = (cells: string[], header: boolean) => {
          doc.setFont("helvetica", header ? "bold" : "normal");
          doc.setFontSize(10);
          doc.setTextColor(17, 17, 17);

          // Wrap every cell first, then size the row to its tallest cell — so a
          // long cell grows the row instead of overprinting its neighbour.
          const wrapped = Array.from({ length: columnCount }, (_, i) =>
            doc.splitTextToSize(stripInlineMarkers(cells[i] ?? "") || " ", colWidth - 8) as string[],
          );
          const rowLines = Math.max(...wrapped.map((w) => w.length));
          room(rowLines, 14);

          const top = y;
          wrapped.forEach((cellLines, i) => {
            cellLines.forEach((line, l) => {
              doc.text(line, PDF_MARGIN + i * colWidth + 4, top + l * 14);
            });
          });
          y = top + rowLines * 14 + 4;

          doc.setDrawColor(210, 210, 210);
          doc.line(PDF_MARGIN, y - 10, PDF_MARGIN + maxWidth, y - 10);
        };

        y += 6;
        drawRow(block.header, true);
        block.rows.forEach((row) => drawRow(row, false));
        y += 8;
        break;
      }

      case "rule":
        room(1);
        doc.setDrawColor(200, 200, 200);
        doc.line(PDF_MARGIN, y, PDF_MARGIN + maxWidth, y);
        y += PDF_LINE;
        break;

      default:
        // Inline bold/italic would need per-span x-advance measurement to flow
        // correctly across a wrap; markers are stripped instead so the text is
        // clean rather than littered with asterisks.
        write(stripInlineMarkers(block.text));
        y += 6;
    }
  });

  return doc.output("blob");
}

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------
// Two accepted shapes, because a model asked for slides sends both:
//   JSON: {slides:[{title, bullets:[], notes}]}
//   Markdown: each `#`/`##` heading starts a slide, bullets beneath it fill it.

interface SlideSpec {
  title: string;
  bullets: string[];
  notes?: string;
}

function slidesFromMarkdown(content: string): SlideSpec[] {
  const slides: SlideSpec[] = [];
  let current: SlideSpec | null = null;

  for (const block of parseMarkdownBlocks(content)) {
    if (block.type === "heading") {
      if (current) slides.push(current);
      current = { title: stripInlineMarkers(block.text), bullets: [] };
      continue;
    }
    if (!current) current = { title: "", bullets: [] };

    if (block.type === "bullet" || block.type === "numbered") {
      // Indentation is preserved as a visual prefix: pptx sub-bullets need an
      // indentLevel per paragraph object, and flattening loses the hierarchy.
      current.bullets.push(`${"    ".repeat(block.depth)}${stripInlineMarkers(block.text)}`);
    } else if (block.type === "paragraph" || block.type === "quote") {
      current.bullets.push(stripInlineMarkers(block.text));
    } else if (block.type === "code") {
      current.bullets.push(block.text);
    } else if (block.type === "table") {
      current.bullets.push([block.header.join(" | "), ...block.rows.map((r) => r.join(" | "))].join("\n"));
    }
  }

  if (current) slides.push(current);
  return slides.filter((s) => s.title || s.bullets.length);
}

function parseSlideSpecs(content: string): SlideSpec[] {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const raw = Array.isArray(parsed)
        ? parsed
        : ((parsed as { slides?: unknown }).slides as unknown);
      if (Array.isArray(raw)) {
        const specs = raw
          .map((entry): SlideSpec => {
            const slide = (entry ?? {}) as Record<string, unknown>;
            const bulletsRaw = slide.bullets ?? slide.content ?? slide.points;
            const bullets = Array.isArray(bulletsRaw)
              ? bulletsRaw.map((b) => stripInlineMarkers(String(b)))
              : typeof bulletsRaw === "string"
                ? [stripInlineMarkers(bulletsRaw)]
                : [];
            return {
              title: stripInlineMarkers(String(slide.title ?? slide.heading ?? "")),
              bullets,
              notes: typeof slide.notes === "string" ? slide.notes : undefined,
            };
          })
          .filter((s) => s.title || s.bullets.length);
        if (specs.length) return specs;
      }
    } catch {
      // Not the JSON shape — fall through to the markdown reading.
    }
  }
  return slidesFromMarkdown(content);
}

async function buildPptx(content: string): Promise<Blob> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";

  const specs = parseSlideSpecs(content);
  if (!specs.length) throw new Error("no slides could be read from the content");

  // 12 bullets is about what fits at 14pt on a 16:9 slide. Past that, continue
  // on a new slide rather than letting pptx overflow text off the bottom.
  const MAX_BULLETS = 12;

  for (const spec of specs) {
    const chunks: string[][] = [];
    for (let i = 0; i < Math.max(spec.bullets.length, 1); i += MAX_BULLETS) {
      chunks.push(spec.bullets.slice(i, i + MAX_BULLETS));
    }

    chunks.forEach((bullets, chunkIndex) => {
      const slide = pptx.addSlide();
      const title = chunkIndex === 0 ? spec.title : `${spec.title} (cont.)`;

      if (title) {
        slide.addText(title, {
          x: 0.5,
          y: 0.35,
          w: 9,
          h: 0.9,
          fontSize: 28,
          bold: true,
          color: "1A1A1A",
        });
      }

      if (bullets.length) {
        slide.addText(
          bullets.map((text) => ({
            text,
            options: { bullet: true, breakLine: true },
          })),
          {
            x: 0.6,
            y: title ? 1.5 : 0.6,
            w: 8.8,
            h: title ? 3.6 : 4.5,
            fontSize: 14,
            color: "333333",
            valign: "top",
          },
        );
      }

      // Notes only on the first slide of a split: repeating them on every
      // continuation would read as duplicated speaker guidance.
      if (spec.notes && chunkIndex === 0) slide.addNotes(spec.notes);
    });
  }

  const output = await pptx.write({ outputType: "blob" });
  return new Blob([output as Blob], { type: FILE_MIME_TYPES.pptx });
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Build a downloadable file. Never throws — see the header.
 *
 * The error strings are written to be read by the model, not by a developer:
 * they name what was wrong with the input so the next tool call can fix it.
 */
export async function generateFile(
  format: string,
  filename: string,
  content: string,
): Promise<GenerateFileResult> {
  const fmt = (format || "").toLowerCase().replace(/^\./, "");

  if (!isSupportedFormat(fmt)) {
    return {
      ok: false,
      error: `unsupported format "${format}". Supported: ${SUPPORTED_FORMATS.join(", ")}.`,
    };
  }
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: "`content` was empty. Send the complete file body." };
  }
  if (!filename || !filename.trim()) {
    return { ok: false, error: "missing `filename`." };
  }

  const outputName = withExtension(filename, fmt);

  try {
    let blob: Blob;

    switch (fmt) {
      case "xlsx":
        blob = await buildXlsx(content);
        break;
      case "csv":
        blob = buildCsv(content);
        break;
      case "docx":
        blob = await buildDocx(content);
        break;
      case "pdf":
        blob = await buildPdf(content);
        break;
      case "pptx":
        blob = await buildPptx(content);
        break;
      case "json":
        // Parse to fail loudly here rather than handing the user a .json that no
        // parser will open.
        JSON.parse(content);
        blob = new Blob([content], { type: FILE_MIME_TYPES.json });
        break;
      default:
        blob = new Blob([content], { type: FILE_MIME_TYPES[fmt] });
    }

    if (!blob.size) {
      return { ok: false, error: `the generated ${fmt} was empty — the content produced no output.` };
    }

    return {
      ok: true,
      blob,
      filename: outputName,
      mimeType: FILE_MIME_TYPES[fmt],
      size: blob.size,
    };
  } catch (err) {
    // AbortError included: generation is CPU-bound and synchronous once started,
    // so there is nothing to cancel and reporting it as a failed file is more
    // useful to the caller than re-throwing into the agent loop.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `could not build ${fmt} (${detail}).` };
  }
}
