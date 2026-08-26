// Do the two ways an artifact id gets derived actually agree?
//
// There are two, and they never meet in the type system:
//   • `extractArtifacts` scans the raw assistant markdown with its own fence
//     scanner and puts `code:<hash>` in the store.
//   • `CodeBlock` in ChatMessage hashes the string react-markdown handed it and
//     uses that as the id its "Open in canvas" button opens.
// If they disagree by a single character the button opens an id the store has
// never heard of, `ArtifactPanel` finds nothing and returns null, and the canvas
// docks correctly while displaying nothing at all — which is exactly the symptom
// that was observed in the running app.
//
// So the oracle here is the real markdown parser (mdast, the same micromark
// pipeline react-markdown runs), not a second hand-rolled scanner: `node.value`
// is what the renderer passes as children. Comparing our scanner against it is
// the only comparison that means anything.

import { describe, it, expect } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import { extractArtifacts, artifactIdForCode, extractCodeBlocks } from "@/lib/artifacts";

/** The ids ChatMessage's CodeBlock would produce for a given markdown source. */
function idsFromRenderer(markdown: string): string[] {
  const tree = fromMarkdown(markdown);
  const out: string[] = [];
  // Typed against mdast rather than `any`: `type === "code"` then narrows to the
  // Code node, so `lang` and `value` below are the real fields and not two
  // hopeful property reads. `"children" in node` is the honest recursion guard —
  // a Code node is a leaf and has none.
  const walk = (node: Root | RootContent) => {
    if (node.type === "code") {
      // react-markdown gives `language-<lang>` on the <code> element and the
      // node's value as children; ChatMessage strips one trailing newline.
      const language = node.lang || "text";
      const content = String(node.value).replace(/\n$/, "");
      out.push(artifactIdForCode(language, content));
    }
    if ("children" in node) {
      for (const child of node.children) walk(child);
    }
  };
  walk(tree);
  return out;
}

/** The ids the store ends up holding for the same markdown. */
function idsFromStore(markdown: string): string[] {
  return extractArtifacts(markdown, [], "m1")
    .filter((a) => a.kind === "code")
    .map((a) => a.id);
}

const body = Array.from({ length: 20 }, (_, i) => `print(${i})`).join("\n");

describe("artifact id agreement between the store and the rendered code block", () => {
  it("agrees on a plain fenced block", () => {
    const md = `Here you go:\n\n\`\`\`python\n${body}\n\`\`\`\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });

  it("agrees when the stream used CRLF line endings", () => {
    // A provider that emits \r\n is the realistic version of this bug: the
    // markdown parser normalises the line endings, a naive split("\n") does not,
    // so every body line keeps a trailing \r and the hash diverges.
    const md = `Here you go:\r\n\r\n\`\`\`python\r\n${body.replace(/\n/g, "\r\n")}\r\n\`\`\`\r\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });

  it("agrees when the fence is indented (nested under a list item)", () => {
    // CommonMark strips the fence's own indentation from each body line. A
    // scanner that keeps the raw text hashes 2 extra spaces per line.
    const indented = body
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    const md = `1. Step one:\n\n  \`\`\`python\n${indented}\n  \`\`\`\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });

  it("agrees on a language tag written in mixed case", () => {
    const md = `\`\`\`Python\n${body}\n\`\`\`\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });

  it("agrees when the block carries an info string after the language", () => {
    const md = `\`\`\`python title="analyse.py"\n${body}\n\`\`\`\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });

  it("does not treat the closing fence as the start of another block", () => {
    const md = `\`\`\`python\n${body}\n\`\`\`\n\nSome prose after.\n`;
    expect(extractCodeBlocks(md)).toHaveLength(1);
  });
});

// The divergence the oracle above was built to catch, found later and by reading:
// the private scanner required the closing fence to be *exactly* the opener, and
// CommonMark requires it to be **at least as long**. One word, and it only shows
// up on input nobody thinks to try — but "quote some markdown" is not exotic, it
// is what asking for a README produces.
describe("the closing fence is at least as long as the opener, not equal to it", () => {
  it("agrees when the model closes a ``` block with ````", () => {
    // Measured against mdast before the fix:
    //   renderer : "const a = 1;"
    //   scanner  : "const a = 1;\n````\n\nOutro paragraph."
    // Two failures in one: the id no rendered block can compute, so the canvas
    // docks and shows nothing — and the card it does hold has the answer's own
    // trailing prose inside it, set in monospace as though it were code.
    const md = `Intro\n\n\`\`\`js\n${body}\n\`\`\`\`\n\nOutro paragraph.\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });

  it("agrees when a longer fence appears inside a shorter block", () => {
    // Compared as a subset rather than with toEqual, and the reason is a property
    // of the two helpers rather than of this input: `idsFromRenderer` reports
    // *every* code node, while the store holds only the ones clearing
    // `MIN_CODE_LINES`. This markdown ends up with a substantial block and a
    // three-line tail, so the counts legitimately differ.
    //
    // The invariant that matters is the directional one anyway: **every id the
    // store holds must be one the renderer also computes**, because the store is
    // what "Open in canvas" looks up. A renderer id missing from the store is a
    // block deliberately left inline.
    const md = `Intro\n\n\`\`\`md\n${body}\n\`\`\`\`\nnested\n\`\`\`\`\n\`\`\`\n\nOutro.\n`;
    const stored = idsFromStore(md);
    // Paired presence assertion: a subset check alone is satisfied by an empty
    // store, which is §14.2 #18's lesson written as a habit.
    expect(stored).toHaveLength(1);
    expect(idsFromRenderer(md)).toContain(stored[0]);
  });

  it("agrees on the same shape with tildes", () => {
    const md = `Intro\n\n~~~py\n${body}\n~~~~\n\nOutro paragraph.\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });

  it("still refuses to close a ```` block at an inner ```", () => {
    // The other direction, and the one the old rule got right — worth pinning
    // because the fix moves this code, and a `>=` written as `<=` passes every
    // test above while breaking exactly this.
    const md = `\`\`\`\`md\n\`\`\`js\nx = 1\n\`\`\`\n${body}\n\`\`\`\`\n\nOutro.\n`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
    expect(extractCodeBlocks(md)).toHaveLength(1);
  });

  it("agrees on a block the stream cut off mid-body", () => {
    // No closing fence at all: both sides must take the rest of the text as the
    // body, and `parseFenceSegment` must not pop a line that is not a fence.
    const md = `Here you go:\n\n\`\`\`python\n${body}`;
    expect(idsFromStore(md)).toEqual(idsFromRenderer(md));
  });
});
