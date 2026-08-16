import { describe, it, expect } from "vitest";
import {
  extractArtifacts,
  mergeArtifacts,
  artifactIdForCode,
  isSubstantialCodeBlock,
  extractCodeBlocks,
} from "@/lib/artifacts";
import type { MessageFile } from "@/components/chat/types";

// A code body long enough to clear the substantial-block bar — the magic
// strings here mirror the ~30-line / N-byte trigger in artifacts.ts so the test
// stays meaningful if that threshold is tuned (it is imported via the helper).
const SUBSTANTIAL: string[] = [];
for (let i = 0; i < 60; i++) SUBSTANTIAL.push(`const x${i} = ${i}; // line ${i}`);
const BIG = SUBSTANTIAL.join("\n");

const SHORT = "const x = 1;\nconst y = 2;\n";

function fenced(code: string, lang = "ts"): string {
  return "```" + lang + "\n" + code + "\n```";
}

const files = (n: string): MessageFile[] => [
  { filename: "src/" + n, url: "blob:http://localhost/abc", mimeType: "text/plain" },
];

describe("extractArtifacts", () => {
  it("keeps a substantial code block, drops a snippet", () => {
    const out = extractArtifacts(fenced(BIG) + "\n\n" + fenced(SHORT), [], "m1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "code", language: "ts" });
    expect(out[0].downloadable).toBe(false);
  });

  it("assigns the id the UI affordance uses (artifactIdForCode)", () => {
    // The "Open in canvas" button computes its id with artifactIdForCode; the
    // extractor must produce the same id or the button opens the wrong panel.
    const out = extractArtifacts(fenced(BIG), [], "m1");
    expect(out[0].id).toBe(artifactIdForCode("ts", BIG));
  });

  it("reports files as downloadable file artifacts", () => {
    const out = extractArtifacts("done", files("a.txt"), "m1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "file", downloadable: true, language: "txt" });
  });
});

describe("mergeArtifacts — versioning and dedupe", () => {
  it("treats same language + same content as the same artifact (no dup)", () => {
    const a = extractArtifacts(fenced(BIG), [], "m1");
    const b = extractArtifacts(fenced(BIG), [], "m1");
    expect(mergeArtifacts(a, b)).toHaveLength(1);
  });

  it("appends a new version when the same file is rewritten in a later turn", () => {
    // Same filename → same artifact id. The extractor stores "" content (the
    // panel fetches the real bytes from the object URL), so content equality
    // cannot tell the turns apart: a different producing message is the signal.
    const f1 = files("a.txt");
    const f2 = [{ ...files("a.txt")[0], url: "blob:http://localhost/def" }];
    const v1 = extractArtifacts("first write", f1, "m1");
    const v2 = extractArtifacts("rewrite", f2, "m2");
    const merged = mergeArtifacts(v1, v2);
    expect(merged).toHaveLength(1);
    expect(merged[0].history).toHaveLength(2);
    expect(merged[0].history.map((h) => h.version)).toEqual([0, 1]);

    // Same message re-emitting the same file id is not a new version.
    const redone = mergeArtifacts(v1, extractArtifacts("again", f1, "m1"));
    expect(redone[0].history).toHaveLength(1);
  });

  it("does NOT version a code block whose bytes did not change across turns", () => {
    // Content-derived id means a duplicate block in a new turn shares id+content,
    // so it is a duplicate, not a new version.
    const v0 = extractArtifacts(fenced(BIG), [], "m1");
    const v1 = extractArtifacts("more prose\n\n" + fenced(BIG), [], "m2");
    const merged = mergeArtifacts(v0, v1);
    expect(merged).toHaveLength(1);
    expect(merged[0].history).toHaveLength(1);
  });

  it("versions a code block passed in with the same id but different content", () => {
    // The extractor derives ids from content, so an edited block is normally a
    // brand-new id (a new artifact). But a same-id/different-content pair — which
    // edit_file produces for files and a caller could construct for code — merges
    // as a new version. This pins the contract the panel's diff relies on.
    const v0 = extractArtifacts(fenced(BIG), [], "m1");
    const edited = BIG.replace("x0 = 0", "x0 = 999");
    const sameIdDiffContent = [{ ...v0[0], history: [{ content: edited, messageId: "m2", version: 1 }] }];
    const merged = mergeArtifacts(v0, sameIdDiffContent);
    expect(merged[0].history).toHaveLength(2);
    expect(merged[0].history[1].content).toContain("x0 = 999");
  });
});

describe("isSubstantialCodeBlock / extractCodeBlocks", () => {
  it("extracts the language and content of a fenced block", () => {
    const [blk] = extractCodeBlocks(fenced("hello", "python"));
    expect(blk.language).toBe("python");
    expect(blk.content).toBe("hello");
  });

  it("isSubstantialCodeBlock is true for big, false for tiny", () => {
    expect(isSubstantialCodeBlock(BIG)).toBe(true);
    expect(isSubstantialCodeBlock(SHORT)).toBe(false);
  });
});
