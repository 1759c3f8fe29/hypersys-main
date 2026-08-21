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
