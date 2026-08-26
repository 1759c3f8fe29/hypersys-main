// Extraction is the difference between "the model read your file" and "the model
// hallucinated about a base64 blob", so the interesting assertions here are all
// about faithfulness: the text that comes out has to be the text the user sees in
// their own document.
//
// Two of these pin real defects. `.pptx` text is read out of XML with a regex, so
// a slide reading "Q&A" is stored as `Q&amp;A` and was handed to the model that
// way. And `slide10.xml` sorts before `slide2.xml` as a string, which would have
// renumbered and reordered a deck of ten or more slides.

import { describe, it, expect } from "vitest";
import {
  extractDocument,
  buildDocumentContext,
  canExtract,
  isImageFile,
  pdfCoverageNotices,
  identifyBinary,
  scavengeText,
  type ExtractedDocument,
} from "@/lib/documents";
import { segmentByFence, parseFenceSegment } from "@/lib/chat-format";

const fileOf = (name: string, content: string, type = "") =>
  new File([content], name, { type });

/** A file with real bytes, for the paths that decide from the bytes. */
const bytesOf = (name: string, bytes: number[], type = "") =>
  new File([new Uint8Array(bytes)], name, { type });

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A minimal .pptx: a zip whose ppt/slides/slideN.xml hold the text runs. */
async function pptxOf(slides: Record<string, string[]>): Promise<File> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  // A real deck carries these too; including one proves the path filter is doing
  // its job rather than picking up every xml in the archive.
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/slides/_rels/slide1.xml.rels", "<Relationships/>");
  for (const [name, runs] of Object.entries(slides)) {
    zip.file(
      `ppt/slides/${name}`,
      `<p:sld xmlns:a="x"><p:cSld><p:spTree>${runs
        .map((r) => `<a:p><a:r><a:t>${r}</a:t></a:r></a:p>`)
        .join("")}</p:spTree></p:cSld></p:sld>`,
    );
  }
  const blob = await zip.generateAsync({ type: "arraybuffer" });
  return new File([blob], "deck.pptx", {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}

/** Build a zip from a path→content map, as a File with the given name/type. */
async function zipOf(entries: Record<string, string>, name: string, type = ""): Promise<File> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return new File([await zip.generateAsync({ type: "arraybuffer" })], name, { type });
}

describe("file triage", () => {
  it("routes images away from text extraction", () => {
    expect(isImageFile(fileOf("a.png", "x", "image/png"))).toBe(true);
    expect(isImageFile(fileOf("a.txt", "x", "text/plain"))).toBe(false);
  });

  // This used to be a closed allowlist, and its one caller *drops* what it
  // rejects — silently, while the attachment still renders and the filename still
  // reaches the model. So the answer being "no" was never a refusal the user saw;
  // it was a confident reply about a file nothing had opened. Extraction is total
  // now, so the only thing left to say no to is an image.
  it("attempts every non-image file, because dropping one is invisible", () => {
    for (const name of [
      "a.pdf", "a.docx", "a.xlsx", "a.pptx", "a.py", "a.csv", "a.md",
      // Formerly rejected, all of them readable:
      "a.exe", "a.mp4", "config.yaml", "main.go", "Dockerfile", "LICENSE",
      "notes.thing", "no-extension-at-all",
    ]) {
      expect(canExtract(fileOf(name, "x"))).toBe(true);
    }
    expect(canExtract(fileOf("a.png", "x", "image/png"))).toBe(false);
  });
});

describe("extractDocument on text-like files", () => {
  it("returns the file's own text and threads the attachment id through", async () => {
    const doc = await extractDocument(fileOf("notes.md", "# Title\n\nbody\n"), "att_1");
    expect(doc.text).toBe("# Title\n\nbody");
    expect(doc.id).toBe("att_1");
    expect(doc.error).toBeUndefined();
    expect(doc.truncated).toBe(false);
  });

  it("keeps code exactly as written, including the characters a sanitiser would touch", async () => {
    const code = 'def f():\n    # comment\n    print("a\\nb")\n';
    const doc = await extractDocument(fileOf("f.py", code));
    expect(doc.text).toBe(code.trim());
  });

  it("truncates a long file at a line boundary and says so", async () => {
    const line = "x".repeat(99) + "\n";
    const doc = await extractDocument(fileOf("big.log", line.repeat(2_000)));
    expect(doc.truncated).toBe(true);
    expect(doc.text.length).toBeLessThanOrEqual(120_000);
    expect(doc.text.endsWith("\n")).toBe(false);
    expect(doc.text.split("\n").every((l) => l.length === 99)).toBe(true);
  });

  it("reports an empty file as unreadable rather than as an empty document", async () => {
    // A model shown nothing answers as if the document were blank.
    const doc = await extractDocument(fileOf("empty.txt", "   \n  ", "text/plain"));
    expect(doc.text).toBe("");
    expect(doc.error).toMatch(/no readable text/i);
  });
});

describe("extractDocument refuses honestly", () => {
  it("names the legacy Office formats when the scavenge comes back empty", async () => {
    // "\0binary" is a stub with a NUL in it and no recoverable text, so it falls
    // through to the refusal — which is still the right answer for a file that
    // really is unreadable. It is just no longer the *first* answer: see the
    // scavenge tests below for a .doc that does yield its prose.
    for (const ext of ["doc", "ppt"]) {
      const doc = await extractDocument(fileOf(`old.${ext}`, "\0binary"));
      expect(doc.error).toMatch(new RegExp(`save it as ${ext}x`, "i"));
      expect(doc.text).toBe("");
    }
  });

  it("turns a corrupt archive into an error field, not a thrown turn", async () => {
    // One bad attachment must not cost the user the whole message.
    const doc = await extractDocument(fileOf("broken.pptx", "not a zip at all"));
    expect(doc.text).toBe("");
    expect(doc.error).toBeTruthy();
  });
});

// ── Reading any file type ─────────────────────────────────────────────────────
// The report was "make it capablle to read any types of files", and the defect
// behind it was not a missing parser. It was that the format list was *closed*:
// `canExtract` said no, and its one caller drops what it rejects without a word,
// so the file's name still reached the model while its contents did not. A model
// given a filename and no content does not report a problem — it answers. Which is
// why the assertions below care as much about what is NOT an error as about what
// text comes out.

describe("text files the closed list used to miss", () => {
  it("reads the extensions that were supported by the extractor but not the picker", async () => {
    const cases: Array<[string, string]> = [
      ["deploy.yaml", "replicas: 3"],
      ["main.go", "package main"],
      ["lib.rs", "fn main() {}"],
      ["query.sql", "select 1;"],
      ["server.log", "2026-08-22 boot ok"],
      ["schema.prisma", "model User { id Int }"],
      ["main.tf", 'resource "aws_s3_bucket" "b" {}'],
      ["notes.rst", "Title"],
      ["icon.svg", "<svg><text>hi</text></svg>"],
      ["Chart.lock", "resolved: 1"],
    ];
    for (const [name, body] of cases) {
      const doc = await extractDocument(fileOf(name, body));
      expect(doc.error, `${name} should have been read`).toBeUndefined();
      expect(doc.text).toBe(body);
    }
  });

  // `extensionOf("Dockerfile")` is "", so listing "dockerfile" among the
  // extensions only ever matched `something.dockerfile`. The file that every
  // repository actually contains fell through to "Cannot read . files."
  it("reads the extension-less files that every repository contains", async () => {
    const cases: Array<[string, string]> = [
      ["Dockerfile", "FROM node:20"],
      ["Makefile", "all: build"],
      ["LICENSE", "MIT License"],
      ["README", "A project."],
      [".gitignore", "node_modules/"],
      ["CODEOWNERS", "* @team"],
    ];
    for (const [name, body] of cases) {
      const doc = await extractDocument(fileOf(name, body));
      expect(doc.error, `${name} should have been read`).toBeUndefined();
      expect(doc.text).toBe(body);
    }
  });

  it("reads a file whose extension it has never heard of, because the bytes are text", async () => {
    const doc = await extractDocument(fileOf("thing.zqx", "key = value"));
    expect(doc.error).toBeUndefined();
    expect(doc.text).toBe("key = value");
  });

  it("reads a file with no name to go on at all", async () => {
    const doc = await extractDocument(fileOf("attachment", "all: build"));
    expect(doc.error).toBeUndefined();
    expect(doc.text).toBe("all: build");
  });

  // UTF-16 read as UTF-8 is not merely mangled: every second byte is NUL, so the
  // text sniff calls it binary and an ordinary Windows export comes back reported
  // as an unreadable file.
  it("decodes UTF-16 and strips the byte-order mark", async () => {
    const utf16le = [0xff, 0xfe];
    for (const ch of "héllo") {
      const code = ch.codePointAt(0)!;
      utf16le.push(code & 0xff, code >> 8);
    }
    const doc = await extractDocument(bytesOf("export.txt", utf16le, "text/plain"));
    expect(doc.text).toBe("héllo");

    const utf8Bom = await extractDocument(bytesOf("bom.csv", [0xef, 0xbb, 0xbf, ...ascii("a,b")]));
    expect(utf8Bom.text).toBe("a,b");
  });
});

describe("binary files are identified, not refused", () => {
  // A real MP4: the `ftyp` box at offset 4, then bytes that are not text.
  const mp4 = () =>
    bytesOf("clip.mp4", [0, 0, 0, 0x18, ...ascii("ftypmp42"), ...Array(64).fill(0)], "video/mp4");

  it("says what the file is instead of reporting a failure", async () => {
    const doc = await extractDocument(mp4());
    // The distinction that matters: `error` is toasted at the user and tells the
    // model something went wrong. Nothing went wrong — they attached a video.
    expect(doc.error).toBeUndefined();
    expect(doc.binary).toBe(true);
    expect(doc.detail).toContain("MP4");
    expect(doc.text).toBe("");
  });

  it("identifies formats from their magic number, not their extension", () => {
    expect(identifyBinary(new Uint8Array(ascii("%PDF-1.7")))).toBe("PDF document");
    expect(identifyBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("ZIP archive");
    expect(identifyBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("PNG image");
    expect(identifyBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe("Linux executable (ELF)");
    expect(identifyBinary(new Uint8Array(ascii("SQLite format 3")))).toBe("SQLite database");
    expect(identifyBinary(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))).toBe("WebP image");
    expect(identifyBinary(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]))).toBe("WAV audio");
    // An honest unknown, rather than a confident wrong guess.
    expect(identifyBinary(new Uint8Array([0x42, 0x99, 0x01, 0x77]))).toBeNull();
  });

  it("tells the model the contents are unavailable and not to invent them", async () => {
    const doc = await extractDocument(mp4());
    const context = buildDocumentContext([doc])!;
    expect(context).toContain("clip.mp4");
    expect(context).toContain("MP4");
    expect(context).toMatch(/no readable text/i);
    expect(context).toMatch(/not an error/i);
    expect(context).toMatch(/Do NOT guess/);
  });

  it("names an archive format it cannot decompress rather than dropping the file", async () => {
    const doc = await extractDocument(fileOf("backup.tar.gz", "\0binary"));
    expect(doc.binary).toBe(true);
    expect(doc.detail).toMatch(/GZ archive/i);
    expect(doc.error).toBeUndefined();
  });
});

describe("dispatching on the bytes when the name is wrong", () => {
  // The case this exists for: a download that lost its extension, a file renamed
  // by a chat app, an export from a system that never set one. The zip layout
  // identifies the format when the filename cannot.
  it("parses a .pptx that arrived with no extension", async () => {
    const deck = await pptxOf({ "slide1.xml": ["Quarterly review"] });
    const renamed = new File([await deck.arrayBuffer()], "attachment", { type: "" });
    const doc = await extractDocument(renamed);
    expect(doc.error).toBeUndefined();
    expect(doc.text).toContain("Quarterly review");
  });

  it("lists the entries of a zip it has no document reader for", async () => {
    const zip = await zipOf({ "src/index.ts": "export {}", "README.md": "hi" }, "project.zip");
    const doc = await extractDocument(zip);
    expect(doc.error).toBeUndefined();
    expect(doc.units).toBe(2);
    expect(doc.text).toContain("src/index.ts");
    expect(doc.text).toContain("README.md");
    // Contents deliberately not concatenated: a repository zip would be the whole
    // context window, and the user who wants a file read can attach that file.
    expect(doc.text).toContain("were not extracted");
  });
});

describe("extractDocument on OpenDocument", () => {
  const odt = (body: string) =>
    zipOf(
      {
        "META-INF/manifest.xml": "<manifest/>",
        "content.xml": `<office:document-content>${body}</office:document-content>`,
      },
      "notes.odt",
      "application/vnd.oasis.opendocument.text",
    );

  it("reads paragraphs as lines and decodes the entities", async () => {
    const doc = await extractDocument(
      await odt("<text:h>Title</text:h><text:p>Q&amp;A: 20% &lt; 30%</text:p><text:p>Second</text:p>"),
    );
    expect(doc.text).toBe("Title\nQ&A: 20% < 30%\nSecond");
  });

  it("reads a spreadsheet's cells as columns and rows", async () => {
    const doc = await extractDocument(
      await odt(
        "<table:table><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell>" +
          "<table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>",
      ),
    );
    // A cell break is a tab and a row break a newline, so the shape survives.
    expect(doc.text).toContain("a\tb");
  });

  it("keeps ODF's explicit space and tab elements", async () => {
    const doc = await extractDocument(await odt("<text:p>a<text:s/>b<text:tab/>c</text:p>"));
    expect(doc.text).toBe("a b\tc");
  });
});

describe("extractDocument on .epub", () => {
  // Filename order is wrong for most books: `chap10` sorts before `chap2`, and
  // plenty of publishers name chapter files by internal id rather than by
  // position. The spine is the reading order, so it is what gets followed.
  it("reads chapters in spine order, not filename order", async () => {
    const file = await zipOf(
      {
        mimetype: "application/epub+zip",
        "META-INF/container.xml":
          '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
        "OEBPS/book.opf":
          "<package><manifest>" +
          '<item id="c1" href="chap1.xhtml"/><item id="c2" href="chap2.xhtml"/><item id="c10" href="chap10.xhtml"/>' +
          '</manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c10"/></spine></package>',
        "OEBPS/chap1.xhtml": "<html><body><p>First chapter</p></body></html>",
        "OEBPS/chap2.xhtml": "<html><body><p>Second chapter</p></body></html>",
        "OEBPS/chap10.xhtml": "<html><body><p>Tenth chapter</p></body></html>",
      },
      "book.epub",
      "application/epub+zip",
    );
    const doc = await extractDocument(file);
    expect(doc.text.match(/First|Second|Tenth/g)).toEqual(["First", "Second", "Tenth"]);
    expect(doc.units).toBe(3);
  });

  it("drops the stylesheet rather than spending the context window on CSS", async () => {
    const file = await zipOf(
      {
        mimetype: "application/epub+zip",
        "OEBPS/chap1.xhtml":
          "<html><head><style>body{margin:0;font-family:Georgia}</style></head><body><p>Prose.</p></body></html>",
      },
      "book.epub",
    );
    const doc = await extractDocument(file);
    expect(doc.text).toContain("Prose.");
    expect(doc.text).not.toContain("font-family");
  });
});

describe("extractDocument on .rtf", () => {
  // An RTF file is ASCII, so the text fallback would "work" — and hand the model a
  // font table ahead of every sentence, which it then quotes back as if the control
  // words were the user's words.
  it("returns the prose without the control words", async () => {
    const rtf =
      "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}}\\f0\\fs24 Hello there.\\par Second line.\\par}";
    const doc = await extractDocument(fileOf("letter.rtf", rtf));
    expect(doc.text).toContain("Hello there.");
    expect(doc.text).toContain("Second line.");
    expect(doc.text).not.toContain("fonttbl");
    expect(doc.text).not.toContain("\\par");
    expect(doc.text).not.toContain("Helvetica");
  });

  it("decodes the hex and unicode escapes rather than printing them", async () => {
    const doc = await extractDocument(fileOf("a.rtf", "{\\rtf1 caf\\'e9 \\u8212? end\\par}"));
    expect(doc.text).toContain("café");
    expect(doc.text).toContain("—");
  });
});

describe("extractDocument on .ipynb", () => {
  const notebook = (cells: unknown[]) =>
    fileOf(
      "analysis.ipynb",
      JSON.stringify({ cells, metadata: { kernelspec: { language: "python" } }, nbformat: 4 }),
    );

  it("unwraps the cells instead of handing over the JSON", async () => {
    const doc = await extractDocument(
      notebook([
        { cell_type: "markdown", source: ["# Analysis\n", "\n", "Some notes.\n"] },
        {
          cell_type: "code",
          source: ["import pandas as pd\n", "df.head()\n"],
          outputs: [{ output_type: "stream", text: ["ok\n"] }],
        },
      ]),
    );
    expect(doc.text).toContain("# Analysis");
    expect(doc.text).toContain("```python\nimport pandas as pd\ndf.head()\n```");
    expect(doc.text).toContain("Output:\nok");
    // Not the serialised form.
    expect(doc.text).not.toContain('"cell_type"');
    expect(doc.units).toBe(2);
  });

  // The reason this extractor exists at all: one rendered chart is a
  // multi-megabyte base64 PNG inside `outputs`, and a raw read puts it in the
  // context window.
  it("names an image output instead of including the base64", async () => {
    const doc = await extractDocument(
      notebook([
        {
          cell_type: "code",
          source: "df.plot()",
          outputs: [{ output_type: "display_data", data: { "image/png": "iVBORw0KGgo".repeat(5_000) } }],
        },
      ]),
    );
    expect(doc.text).toContain("Output: [image/png]");
    expect(doc.text).not.toContain("iVBORw0KGgo");
  });

  it("wraps a cell that contains a fence in a longer one", async () => {
    // The wiring assertion for `fenceFor`, and a real shape: a cell whose docstring
    // shows a fenced example — or one that writes a README — used to be wrapped in
    // ```, which CommonMark closes at the cell's *own* fence. The model then read
    // the rest of the cell as prose, so a file attached to be read faithfully was
    // handed over cut in half.
    const cell = 'help = """\n```sh\nnpm ci\n```\n"""';
    const doc = await extractDocument(
      notebook([{ cell_type: "code", source: cell }]),
    );

    // Read back with the app's own fence rule: the cell must come out as one code
    // segment holding exactly what went in.
    const segments = segmentByFence(doc.text);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("code");
    const parsed = parseFenceSegment(segments[0].text);
    expect(parsed.lang).toBe("python");
    expect(parsed.body).toBe(cell);
  });

  it("keeps an error output, which is usually why the notebook was attached", async () => {
    const doc = await extractDocument(
      notebook([
        {
          cell_type: "code",
          source: "1/0",
          outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero" }],
        },
      ]),
    );
    expect(doc.text).toContain("ZeroDivisionError: division by zero");
  });
});

// The legacy binary formats used to be a flat refusal: "save it as docx and
// re-upload". Correct advice, and useless to someone who does not own Word. The
// text is in the file as contiguous printable runs, so it can be scavenged — with
// junk between the sentences, which is a far better trade than nothing.
describe("scavengeText", () => {
  it("pulls Latin-1 runs out of surrounding structure", () => {
    const bytes = new Uint8Array([0x00, 0x01, ...ascii("The quarterly report is late."), 0x00, 0xff, 0x03]);
    expect(scavengeText(bytes)).toBe("The quarterly report is late.");
  });

  it("pulls UTF-16LE runs out, which is how .doc stores its text", () => {
    const wide: number[] = [0x00, 0x00];
    for (const ch of "Minutes of the meeting.") wide.push(ch.charCodeAt(0), 0x00);
    // The Latin-1 pass sees every character followed by a NUL, so every run it
    // finds is one character long and none survives the minimum. Only the wide
    // pass reads this, which is why both are tried and the longer harvest wins.
    expect(scavengeText(new Uint8Array(wide))).toBe("Minutes of the meeting.");
  });

  it("drops runs too short to be words", () => {
    const bytes = new Uint8Array([...ascii("ab"), 0x00, ...ascii("cd"), 0x00]);
    expect(scavengeText(bytes)).toBe("");
  });

  it("recovers enough from a .doc for the refusal to step aside", async () => {
    // Over the 200-character bar the dispatch uses to decide whether the harvest
    // is a document or noise.
    const prose = "This is the body of a legacy Word document. ".repeat(6);
    const wide: number[] = [0xd0, 0xcf, 0x11, 0xe0];
    for (const ch of prose) wide.push(ch.charCodeAt(0), 0x00);
    const doc = await extractDocument(bytesOf("report.doc", wide));
    expect(doc.error).toBeUndefined();
    expect(doc.text).toContain("legacy Word document");
  });
});

describe("extractDocument on .pptx", () => {
  it("decodes the XML entities the slide XML escapes", async () => {
    const file = await pptxOf({ "slide1.xml": ["Q&amp;A", "20% &lt; 30% &quot;really&quot;"] });
    const doc = await extractDocument(file);
    expect(doc.text).toContain("Q&A");
    expect(doc.text).toContain('20% < 30% "really"');
    expect(doc.text).not.toContain("&amp;");
    expect(doc.text).not.toContain("&lt;");
  });

  it("decodes numeric character references", async () => {
    const file = await pptxOf({ "slide1.xml": ["caf&#233; &#x2014; open"] });
    const doc = await extractDocument(file);
    expect(doc.text).toContain("café — open");
  });

  it("leaves a double-escaped ampersand as literal text", async () => {
    // `&amp;lt;` means the author literally wrote `&lt;`. Decoding &amp; last is
    // what keeps that true.
    const file = await pptxOf({ "slide1.xml": ["&amp;lt;tag&amp;gt;"] });
    const doc = await extractDocument(file);
    expect(doc.text).toContain("&lt;tag&gt;");
  });

  it("orders slides numerically, not as strings", async () => {
    const file = await pptxOf({
      "slide1.xml": ["first"],
      "slide2.xml": ["second"],
      "slide10.xml": ["tenth"],
    });
    const doc = await extractDocument(file);
    expect(doc.units).toBe(3);
    const order = doc.text.match(/first|second|tenth/g);
    expect(order).toEqual(["first", "second", "tenth"]);
    // And the labels follow position, so "Slide 3" is the third slide shown.
    expect(doc.text).toContain("--- Slide 3 ---\ntenth");
  });

  it("skips a deck with no text runs rather than reporting empty slides", async () => {
    const file = await pptxOf({ "slide1.xml": [] });
    const doc = await extractDocument(file);
    expect(doc.error).toMatch(/no readable text/i);
  });
});

describe("buildDocumentContext", () => {
  const ok = (over: Partial<ExtractedDocument> = {}): ExtractedDocument => ({
    name: "a.txt",
    mimeType: "text/plain",
    text: "hello",
    ...over,
  });

  it("returns null with nothing attached", () => {
    expect(buildDocumentContext([])).toBeNull();
  });

  it("includes a failed file so the model can say it could not read it", () => {
    const out = buildDocumentContext([ok({ text: "", error: "It is a scan." })]);
    expect(out).toContain("Could not be read: It is a scan.");
  });

  it("surfaces the attachment id, which is how edit_file names a file", () => {
    const out = buildDocumentContext([ok({ id: "att_9" })]);
    expect(out).toContain("attachment_id: att_9");
    expect(out).toContain("edit_file");
  });

  it("flags truncation and pluralises the unit count", () => {
    expect(buildDocumentContext([ok({ truncated: true })])).toContain("truncated");
    expect(buildDocumentContext([ok({ units: 1 })])).toContain("1 part");
    expect(buildDocumentContext([ok({ units: 4 })])).toContain("4 parts");
  });

  it("keeps every file's text, not just the first", () => {
    const out = buildDocumentContext([ok({ name: "a.txt", text: "AAA" }), ok({ name: "b.txt", text: "BBB" })]);
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });
});

// A scanned PDF is read through a metered OCR budget, so the model has to be told
// what it did not get. The failure mode worth pinning is the inverse one: claiming
// a shortfall that never happened. The condition here used to be
// `i <= doc.numPages` — the enclosing loop's own condition, so always true — which
// announced a budget overrun on every scan that fitted the budget and left the
// model hedging about a document it had read cover to cover.
describe("pdfCoverageNotices", () => {
  it("says nothing about a document that was read in full", () => {
    expect(pdfCoverageNotices(0, 10, 10)).toEqual([]);
  });

  it("reports the scanned pages the OCR budget could not cover", () => {
    const [notice] = pdfCoverageNotices(30, 40, 40);
    expect(notice).toContain("30");
    expect(notice).toMatch(/not OCR-ed/);
    expect(notice).toMatch(/budget/i);
  });

  it("keeps the grammar right for a single skipped page", () => {
    expect(pdfCoverageNotices(1, 5, 5)[0]).toContain("page was not OCR-ed");
    expect(pdfCoverageNotices(2, 5, 5)[0]).toContain("pages were not OCR-ed");
  });

  it("names the page range it never opened when the scan cap cut the file short", () => {
    const [notice] = pdfCoverageNotices(0, 200, 640);
    expect(notice).toContain("201-640");
  });

  it("reports both shortfalls when both happened", () => {
    expect(pdfCoverageNotices(190, 200, 640)).toHaveLength(2);
  });
});
