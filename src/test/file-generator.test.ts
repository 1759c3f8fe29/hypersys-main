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

// This function used to own a private fence regex — `/^\s*```+\s*(\S+)?\s*$/` — and a
// second parser for "where does code start and end" is always the narrower one. Each
// case below was measured against the shipped version and produced a corrupt document:
// one that opens cleanly in Word and is wrong, which is the worst failure this file can
// produce (brief §14.2 #16's shape, in the write direction).
//
// The split now comes from `segmentByFence`, so an export agrees with what the user saw
// on screen. That agreement is the actual requirement, and a private rule could never
// meet it.
describe("parseMarkdownBlocks uses the app's one fence rule", () => {
  // The tell in every case is a code comment becoming a document heading. `# ` is an
  // H1 in prose and a comment in half the languages models write, so a fence that
  // fails to hold turns the *inside* of the block into document structure.
  const INSIDE = "# initialise\n- not a bullet";

  it("treats a ~~~ fence as a fence", () => {
    // The shipped regex knew only backticks, so this became six blocks: two paragraphs
    // holding the literal text "~~~python" and "~~~", an H1 reading "initialise", and a
    // bullet — with the fence markers printed in the document body.
    const blocks = parseMarkdownBlocks(`Intro\n\n~~~python\n${INSIDE}\n~~~\n\nOutro`);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1]).toMatchObject({ type: "code", lang: "python", text: INSIDE });
  });

  it("accepts an info string of more than one token", () => {
    // ```js {1,3} and ```py title="app.py" are both routine model output, and the old
    // `(\S+)?\s*$` required the info string to be a single token. The *second* failure
    // is the worse one: the closing ``` was then read as an opening fence, so every
    // paragraph after the block was swallowed into a code box — or lost, when the
    // block was last in the document.
    for (const info of ["js {1,3}", 'js title="app.js"', "js showLineNumbers"]) {
      const blocks = parseMarkdownBlocks(`Intro\n\n\`\`\`${info}\n${INSIDE}\n\`\`\`\n\nOutro`);
      expect(blocks.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
      expect(blocks[1]).toMatchObject({ lang: "js", text: INSIDE });
      // The assertion that names the data loss: the trailing prose is still prose.
      expect(blocks[2]).toMatchObject({ type: "paragraph", text: "Outro" });
    }
  });

  it("lets a longer fence contain a shorter one", () => {
    // CommonMark: the closing fence is at least as long as the opener. Writing docs
    // about markdown is a normal request, and the old rule ended the outer block at
    // the inner ``` — so the example's own `# heading` escaped into the document as
    // real structure and the tail was swallowed as code.
    const md = "Intro\n\n````md\n```js\nconst a = 1;\n```\n# inside the example\n````\n\nOutro";
    const blocks = parseMarkdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1]).toMatchObject({ lang: "md" });
    expect((blocks[1] as { text: string }).text).toContain("# inside the example");
    expect(blocks[2]).toMatchObject({ type: "paragraph", text: "Outro" });
  });

  it("keeps a table's lookahead inside its own segment", () => {
    // The table branch reads `lines[i + 1]` for the separator row, and the parser is
    // now per-segment — so this pins that a table immediately before a fence still
    // parses, i.e. that segmenting did not sever a lookahead from what it looks at.
    const blocks = parseMarkdownBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx();\n```");
    expect(blocks.map((b) => b.type)).toEqual(["table", "code"]);
    expect(blocks[0]).toMatchObject({ header: ["a", "b"], rows: [["1", "2"]] });
  });

  it("still gives a bare fence an empty body and no language", () => {
    const blocks = parseMarkdownBlocks("```\n```");
    expect(blocks).toEqual([{ type: "code", text: "", lang: undefined }]);
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
