// The two arguments a model picks independently, and what happens when they
// disagree.
//
// `create_file` had no test of its own. `file-generator.test.ts` proves the blobs
// open — a real %PDF header, a real zip — and this file covers the layer above it:
// the executor that takes what the *model* sent and decides what to build.
//
// That layer matters because its inputs are not validated JSON, they are a
// language model's best effort. tools/types.ts says so in as many words: "models
// routinely omit required fields". `filename` and `format` are chosen in the same
// breath and disagree often, and the schema marking both required is a request,
// not a guarantee.
//
// The failure texts are asserted as *contents*, not shapes. An `{ok:false}` from a
// tool is not an error page — it is the next thing the model reads, and it has one
// job: to say what to send instead. A message naming an argument the model never
// supplied ("unsupported format \"\"") ends the turn in an apology.

import { describe, it, expect, beforeEach } from "vitest";
import { executeCreateFile } from "@/lib/tools/create-file";
import type { ToolContext } from "@/lib/tools/types";

const ctx = (): ToolContext => ({ modelId: "test-model", artifacts: {} });

let context: ToolContext;
beforeEach(() => {
  context = ctx();
});

describe("what gets built when the model's two arguments disagree", () => {
  it("infers the format from the filename when `format` is missing", async () => {
    // The reported shape of this: "make me a q3-report.csv" produced *unsupported
    // format ""* — a complaint about an argument the user never saw, next to a
    // filename that named the format unambiguously.
    const result = await executeCreateFile(
      { filename: "q3-report.csv", content: "name,total\nwidgets,10" },
      context,
    );

    expect(result.ok).toBe(true);
    expect(context.artifacts.files?.[0].filename).toBe("q3-report.csv");
    expect(context.artifacts.files?.[0].mimeType).toContain("text/csv");
  });

  it("replaces a conflicting extension instead of stacking a second one", async () => {
    // `{filename: "report.xlsx", format: "csv"}` is a routine call. Appending gave
    // "report.xlsx.csv", which Windows displays as "report.xlsx" with the real
    // extension hidden — so the user double-clicks it expecting Excel and gets a
    // text file. The format wins, because `content` was written to match it.
    const result = await executeCreateFile(
      { filename: "report.xlsx", format: "csv", content: "a,b\n1,2" },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).toBe("report.csv");
  });

  it("leaves an extension that is not ours alone", async () => {
    // "archive.tar.gz" must not become "archive.tar.txt": `gz` is not a format
    // this app claims, so it is part of the name rather than a claim to correct.
    const result = await executeCreateFile(
      { filename: "archive.tar.gz", format: "txt", content: "notes" },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).toBe("archive.tar.gz.txt");
  });

  it("does not guess when neither argument names a format", async () => {
    // The one case that must stay an error. Inferring from *nothing* would be the
    // silent substitution rule: a .bin the user asked for arriving as a .txt.
    // The message has to carry the string the model sent so it can correct it.
    const result = await executeCreateFile(
      { filename: "mystery.bin", format: "binary", content: "x" },
      context,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("binary");
      expect(result.error).toContain("csv"); // the supported list, so the retry can succeed
    }
    expect(context.artifacts.files).toBeUndefined();
  });
});

describe("the failures a model has to be able to act on", () => {
  it("names the missing filename rather than building `file.txt`", async () => {
    const result = await executeCreateFile({ format: "txt", content: "hello" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("filename");
  });

  it("refuses empty content instead of handing over a 0-byte download", async () => {
    // An empty file is the worst outcome available here: it looks like success in
    // the chat and like data loss on disk.
    const result = await executeCreateFile(
      { filename: "empty.txt", format: "txt", content: "   " },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("content");
  });

  it("returns a result rather than throwing on JSON that will not parse", async () => {
    // The central rule from tools/types.ts: an executor never throws for a
    // tool-level failure, because a throw kills the turn and the user watches a
    // promise of "here's your file" become a dead conversation. `json` is the
    // format that can fail *inside* the generator rather than at its gate.
    const result = await executeCreateFile(
      { filename: "data.json", format: "json", content: "{not json," },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("create_file:");
  });
});

describe("what the model is told after a file is made", () => {
  it("hands back a name, a size and an instruction — and no content", async () => {
    const body = "# Q3\n\nRevenue rose.";
    const result = await executeCreateFile(
      { filename: "q3.md", format: "md", content: body },
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe("q3.md");
    expect(result.bytes).toBe(body.length);
    // The user's own report — "donot show file content generated by ai when it is
    // shown in side panel" — has a half that lives here rather than in the panel:
    // the model must not be handed the body back, or it pastes it into the reply
    // beside the download it was told about.
    expect(JSON.stringify(result)).not.toContain("Revenue rose");
    expect(String(result.status)).toMatch(/do not paste/i);
  });

  it("appends to artifacts.files rather than replacing them", async () => {
    // Two files in one turn is an ordinary request ("give me the csv and a readme").
    // A `=` instead of a spread here loses the first download with no error.
    await executeCreateFile({ filename: "one.txt", format: "txt", content: "1" }, context);
    await executeCreateFile({ filename: "two.txt", format: "txt", content: "2" }, context);

    expect(context.artifacts.files?.map((f) => f.filename)).toEqual(["one.txt", "two.txt"]);
    // Distinct object URLs: the download links are keyed and revoked individually.
    const urls = context.artifacts.files?.map((f) => f.url) ?? [];
    expect(new Set(urls).size).toBe(2);
    expect(urls.every((u) => u.startsWith("blob:"))).toBe(true);
  });
});
