import { describe, it, expect } from "vitest";
import {
  generateFile,
  parseMarkdownBlocks,
  parseInline,
  withExtension,
  SUPPORTED_FORMATS,
} from "@/lib/file-generator";

// A real .docx / .xlsx / .pptx is a ZIP; a real .pdf starts with %PDF. Checking
// the magic bytes is what makes this a test of "the file opens" rather than
// "the function returned something" — a blob of the wrong shape passes the
// latter and fails in the user's Office.
const ZIP_MAGIC = [0x50, 0x4b];

// jsdom 20's Blob implements only slice/size/type — no arrayBuffer(), no text().
// Browsers have had both for years, so this is a harness gap rather than
// something the generator should work around; FileReader is the reader jsdom
// does provide.
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function magic(blob: Blob, count = 4): Promise<number[]> {
  return Array.from(new Uint8Array(await readBlob(blob.slice(0, count))));
}

async function text(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await readBlob(blob));
}

describe("parseMarkdownBlocks", () => {
  it("reads headings, lists, quotes and rules", () => {
    const blocks = parseMarkdownBlocks(
      ["# Title", "", "Some prose.", "- one", "  - nested", "1. first", "> quoted", "---"].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "bullet",
      "bullet",
      "numbered",
      "quote",
      "rule",
    ]);
    expect(blocks[0]).toMatchObject({ level: 1, text: "Title" });
    expect(blocks[3]).toMatchObject({ depth: 1 });
  });

  it("reads a GFM table but leaves a bare pipe line as prose", () => {
    const table = parseMarkdownBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(table[0]).toMatchObject({ type: "table", header: ["a", "b"], rows: [["1", "2"]] });

    // No separator row: this is text that happens to contain pipes.
    const notTable = parseMarkdownBlocks("| a | b |\njust prose");
    expect(notTable.every((b) => b.type === "paragraph")).toBe(true);
  });

  it("keeps an unterminated code fence from swallowing the document as prose", () => {
    const blocks = parseMarkdownBlocks("```js\nconst x = 1;");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "code", lang: "js", text: "const x = 1;" });
  });
});

describe("parseInline", () => {
  it("splits bold, italic and code without eating the surrounding text", () => {
    expect(parseInline("a **b** c `d` e *f*")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c " },
      { text: "d", code: true },
      { text: " e " },
      { text: "f", italic: true },
    ]);
  });

  it("treats ** as bold rather than as two italics", () => {
    expect(parseInline("**bold**")).toEqual([{ text: "bold", bold: true }]);
  });
});

describe("withExtension", () => {
  it("appends the extension only when it is missing", () => {
    expect(withExtension("report", "pdf")).toBe("report.pdf");
    expect(withExtension("report.pdf", "pdf")).toBe("report.pdf");
  });

  it("strips path separators so a filename cannot escape the download", () => {
    // Separators become dashes, and the leading run of dots/dashes goes too —
    // otherwise "../../etc/passwd" lands as "-..-etc-passwd.txt", and a name
    // starting with a dot is a hidden file on Unix.
    expect(withExtension("../../etc/passwd", "txt")).toBe("etc-passwd.txt");
    expect(withExtension("C:\\Windows\\system32\\cfg", "txt")).toBe("C-Windows-system32-cfg.txt");
    // A trailing dot is a name Windows refuses to save.
    expect(withExtension("report.", "txt")).toBe("report.txt");
    // Nothing survivable left: still a usable name, not an empty one.
    expect(withExtension("///", "txt")).toBe("file.txt");
  });
});

describe("generateFile", () => {
  it("writes a real PDF with the %PDF header", async () => {
    const result = await generateFile("pdf", "doc", "# Title\n\nBody text.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await magic(result.blob)).toEqual([0x25, 0x50, 0x44, 0x46]); // %PDF
    expect(result.filename).toBe("doc.pdf");
  });

  it("paginates a long PDF instead of writing off the page", async () => {
    const short = await generateFile("pdf", "a", "one line");
    const long = await generateFile("pdf", "b", Array.from({ length: 400 }, (_, i) => `Line ${i}`).join("\n\n"));
    expect(short.ok && long.ok).toBe(true);
    if (!short.ok || !long.ok) return;
    // 400 paragraphs cannot fit on one page; a bigger file is the observable
    // proof that pages were added rather than text being overprinted.
    expect(long.size).toBeGreaterThan(short.size);
  });

  it("writes a real docx (a ZIP) from markdown", async () => {
    const result = await generateFile("docx", "doc", "# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await magic(result.blob, 2))).toEqual(ZIP_MAGIC);
  });

  it("writes a real pptx from both accepted shapes", async () => {
    const fromJson = await generateFile(
      "pptx",
      "deck",
      JSON.stringify({ slides: [{ title: "One", bullets: ["a", "b"], notes: "say this" }] }),
    );
    const fromMarkdown = await generateFile("pptx", "deck", "# One\n- a\n- b\n\n# Two\n- c");
    expect(fromJson.ok && fromMarkdown.ok).toBe(true);
    if (!fromJson.ok || !fromMarkdown.ok) return;
    expect(await magic(fromJson.blob, 2)).toEqual(ZIP_MAGIC);
    expect(await magic(fromMarkdown.blob, 2)).toEqual(ZIP_MAGIC);
  });

  it("writes a real xlsx and keeps multiple sheets", async () => {
    const result = await generateFile(
      "xlsx",
      "data",
      JSON.stringify({ sheets: [{ name: "A", rows: [{ x: 1 }] }, { name: "B", rows: [{ y: 2 }] }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await magic(result.blob, 2)).toEqual(ZIP_MAGIC);
  });

  it("quotes csv fields that would otherwise shift a column", async () => {
    const result = await generateFile(
      "csv",
      "rows",
      JSON.stringify([{ name: 'A, Inc "x"', note: "line\nbreak" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = await text(result.blob);
    expect(body).toContain('"A, Inc ""x"""');
    expect(body).toContain('"line\nbreak"');
  });

  it("keeps a column that only a later csv row introduces", async () => {
    const result = await generateFile("csv", "rows", JSON.stringify([{ a: 1 }, { a: 2, b: 3 }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = await text(result.blob);
    expect(body.split("\r\n")[0]).toBe("a,b");
  });

  it("passes literal CSV text through untouched", async () => {
    const result = await generateFile("csv", "rows", 'a,b\r\n"already, quoted",2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await text(result.blob)).toBe('a,b\r\n"already, quoted",2');
  });

  it("returns ok:false instead of throwing on bad input", async () => {
    // Each of these would abort the agent turn if the generator threw.
    const badFormat = await generateFile("rtf", "f", "x");
    const emptyContent = await generateFile("txt", "f", "   ");
    const noFilename = await generateFile("txt", "", "x");
    const badJson = await generateFile("json", "f", "{not json");
    const badXlsx = await generateFile("xlsx", "f", "[]");

    for (const result of [badFormat, emptyContent, noFilename, badJson, badXlsx]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeTruthy();
    }
    if (!badFormat.ok) expect(badFormat.error).toContain("unsupported format");
  });

  it("produces a non-empty file for every advertised format", async () => {
    // The tool schema advertises SUPPORTED_FORMATS, so anything listed there and
    // not buildable here is a format the model can promise and fail to deliver.
    const content: Record<string, string> = {
      json: '{"a":1}',
      csv: "a,b\n1,2",
      xlsx: '[{"a":1}]',
      pptx: "# Slide\n- point",
    };
    for (const format of SUPPORTED_FORMATS) {
      const result = await generateFile(format, "out", content[format] ?? "# Title\n\nBody.");
      expect(result.ok, `${format} failed`).toBe(true);
      if (result.ok) expect(result.size, `${format} was empty`).toBeGreaterThan(0);
    }
  });
});
