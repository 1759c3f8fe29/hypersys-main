// The diff has one invariant, and it is worth stating as an assertion rather
// than as a comment: the rows must reconstruct both versions. `equal` + `removed`
// in order is the old text; `equal` + `added` in order is the new text. Every
// path has to hold it — the minimal LCS, the head/tail fast path, and the coarse
// fallback that exists so a 20k-line artefact cannot freeze the tab.
//
// The reconstruction check is what makes the size guards safe to add: they change
// which rows come out, so a test that pinned exact rows would have to be rewritten
// alongside them and would prove nothing about correctness.

import { describe, it, expect } from "vitest";
import { diffLines, diffSummary, type DiffRow } from "@/lib/artifact-diff";

const oldFrom = (rows: DiffRow[]) =>
  rows.filter((r) => r.kind !== "added").flatMap((r) => r.lines).join("\n");
const newFrom = (rows: DiffRow[]) =>
  rows.filter((r) => r.kind !== "removed").flatMap((r) => r.lines).join("\n");

function roundTrips(a: string, b: string) {
  const rows = diffLines(a, b);
  expect(oldFrom(rows)).toBe(a);
  expect(newFrom(rows)).toBe(b);
  return rows;
}

describe("diffLines reconstructs both versions", () => {
  it("on a one-line change in the middle", () => {
    roundTrips("a\nb\nc", "a\nB\nc");
  });

  it("on an insertion", () => {
    roundTrips("a\nc", "a\nb\nc");
  });

  it("on a deletion", () => {
    roundTrips("a\nb\nc", "a\nc");
  });

  it("with nothing in common", () => {
    roundTrips("x\ny", "p\nq");
  });

  it("from empty to content and back", () => {
    roundTrips("", "a\nb");
    roundTrips("a\nb", "");
  });

  it("when the versions are identical", () => {
    const rows = roundTrips("a\nb", "a\nb");
    expect(rows.every((r) => r.kind === "equal")).toBe(true);
  });

  it("when only the last line changed", () => {
    roundTrips("a\nb\nc", "a\nb\nC");
  });

  it("when only the first line changed", () => {
    roundTrips("a\nb\nc", "A\nb\nc");
  });

  it("on trailing blank lines, which split() makes visible", () => {
    roundTrips("a\n", "a\n\n");
  });
});

describe("diffLines row shape", () => {
  it("coalesces an equal run into one row", () => {
    const rows = diffLines("a\nb\nc\nd", "a\nb\nc\nD");
    const equal = rows.filter((r) => r.kind === "equal");
    expect(equal).toHaveLength(1);
    expect(equal[0].lines).toEqual(["a", "b", "c"]);
  });

  it("numbers lines from 1, and keeps old and new numbering independent", () => {
    // One line inserted at the top: every following line is +1 in the new file.
    const rows = diffLines("a\nb", "x\na\nb");
    const added = rows.find((r) => r.kind === "added");
    const equal = rows.find((r) => r.kind === "equal");
    expect(added?.newLine).toBe(1);
    expect(equal?.oldLine).toBe(1);
    expect(equal?.newLine).toBe(2);
  });

  it("keeps numbering correct after the head trim", () => {
    // The trim emits the head as one row and starts the LCS mid-file; the line
    // numbers on the middle rows have to continue from there, not restart at 1.
    const rows = diffLines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
    expect(rows.find((r) => r.kind === "removed")?.oldLine).toBe(3);
    expect(rows.find((r) => r.kind === "added")?.newLine).toBe(3);
    // And the tail is still numbered as the tail.
    const equals = rows.filter((r) => r.kind === "equal");
    const tail = equals[equals.length - 1];
    expect(tail?.lines).toEqual(["d", "e"]);
    expect(tail?.newLine).toBe(4);
  });

  it("summarises added and removed by line, not by row", () => {
    const rows = diffLines("a\nb\nc", "a\nX\nY\nZ");
    const { added, removed } = diffSummary(rows);
    expect(added).toBe(3);
    expect(removed).toBe(2);
    expect(diffSummary([])).toEqual({ added: 0, removed: 0 });
  });
});

describe("diffLines stays affordable on large artifacts", () => {
  it("diffs a long file with one changed line quickly, and still minimally", () => {
    // 20k lines: the un-trimmed DP table would be 4×10^8 cells. The head/tail
    // trim leaves a 1×1 middle, so this must be both fast and exact — a coarse
    // fallback here would report 20k lines changed.
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const before = lines.join("\n");
    const changed = lines.slice();
    changed[10_000] = "CHANGED";
    const after = changed.join("\n");

    const started = performance.now();
    const rows = roundTrips(before, after);
    expect(performance.now() - started).toBeLessThan(1000);

    const { added, removed } = diffSummary(rows);
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it("degrades to a block replacement rather than allocating the table", () => {
    // Two large files that share no lines at all: nothing to trim, and the LCS
    // is not worth 10^8 cells. The rows must still reconstruct both versions.
    const before = Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join("\n");

    const started = performance.now();
    const rows = roundTrips(before, after);
    expect(performance.now() - started).toBeLessThan(2000);

    // Coarse: one removed block and one added block, not 6000 single-line rows.
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe("removed");
    expect(rows[1].kind).toBe("added");
    expect(diffSummary(rows)).toEqual({ added: 3_000, removed: 3_000 });
  });
});
