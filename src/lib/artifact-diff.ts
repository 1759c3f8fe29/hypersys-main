// ---------------------------------------------------------------------------
// Line-level diff for artifact version history
// ---------------------------------------------------------------------------
// The brief asks for diff between turns. We do not add a diff dependency: a
// classic LCS over lines is ~40 lines, runs on the artefact sizes a chat ever
// holds (at most a few hundred lines), and keeps the bundle small. The output
// is a flat list of rows the panel renders as a two-up added/removed view.
//
// This is line-level, not word-level, on purpose. Chat artifacts change in
// whole blocks between turns (you reworked a function); a word-level diff of
// that is noisier than a line-level diff and harder to read in a side panel.
//
// Two guards keep the LCS affordable, because "the artefact sizes a chat ever
// holds" is an assumption and not a constraint — a `create_file` CSV or a pasted
// log can be tens of thousands of lines, and the panel diffs on the main thread
// inside a useMemo:
//
//   1. Identical head and tail lines are trimmed before the table is allocated.
//      This is the shape of a real edit (one function changed in a long file),
//      so it usually removes almost all of the cost, and it cannot change the
//      answer: lines that match in order are in every LCS.
//   2. Whatever middle survives is still bounded. Past MAX_CELLS the table would
//      be hundreds of megabytes of nested arrays, so the diff degrades to
//      "this block became that block" rather than freezing the tab. The rows
//      still reconstruct both versions exactly; they are just coarse.

export type DiffRowKind = "equal" | "added" | "removed";

export interface DiffRow {
  kind: DiffRowKind;
  lines: string[];
  oldLine?: number; // 1-indexed line in the previous version, when present
  newLine?: number; // 1-indexed line in the new version, when present
}

/** m * n cells above which we stop building a DP table. ~4M ints is already a
 *  visible stall; beyond it the allocation itself is the problem. */
const MAX_CELLS = 4_000_000;

/**
 * LCS over two line arrays -> a minimal edit script as DiffRows.
 *
 * Equal runs are coalesced (one row spanning many lines); added and removed
 * runs are kept separate so the UI can paint them in its own two columns.
 *
 * Invariant every path must hold, minimal or degraded: the `equal` + `removed`
 * rows in order reproduce `oldText`, and the `equal` + `added` rows in order
 * reproduce `newText`.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // ── Guard 1: trim the identical head and tail ────────────────────────────
  let head = 0;
  const maxHead = Math.min(oldLines.length, newLines.length);
  while (head < maxHead && oldLines[head] === newLines[head]) head++;

  let tail = 0;
  const maxTail = maxHead - head;
  while (
    tail < maxTail &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }

  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);

  const rows: DiffRow[] = [];
  if (head > 0) {
    rows.push({ kind: "equal", lines: newLines.slice(0, head), oldLine: 1, newLine: 1 });
  }

  // Line numbers for the middle continue from the trimmed head.
  const midRows =
    oldMid.length * newMid.length > MAX_CELLS
      ? coarse(oldMid, newMid, head + 1, head + 1)
      : lcsRows(oldMid, newMid, head + 1, head + 1);
  rows.push(...midRows);

  if (tail > 0) {
    rows.push({
      kind: "equal",
      lines: newLines.slice(newLines.length - tail),
      oldLine: oldLines.length - tail + 1,
      newLine: newLines.length - tail + 1,
    });
  }

  return rows;
}

/** Guard 2's fallback: one removed block, one added block. Coarse, never wrong. */
function coarse(oldMid: string[], newMid: string[], oldStart: number, newStart: number): DiffRow[] {
  const rows: DiffRow[] = [];
  if (oldMid.length) rows.push({ kind: "removed", lines: oldMid, oldLine: oldStart });
  if (newMid.length) rows.push({ kind: "added", lines: newMid, newLine: newStart });
  return rows;
}

function lcsRows(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (!m && !n) return [];
  if (!m || !n) return coarse(oldLines, newLines, oldStart, newStart);

  // dp table: length of LCS of oldLines[0..i) and newLines[0..j).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Backtrack to emit the script.
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = oldStart;
  let newNo = newStart;

  const pushEqual = (count: number) => {
    rows.push({
      kind: "equal",
      lines: newLines.slice(j, j + count),
      oldLine: oldNo,
      newLine: newNo,
    });
    oldNo += count;
    newNo += count;
  };

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      // Coalesce consecutive equal lines into one row.
      let run = 0;
      while (i + run < m && j + run < n && oldLines[i + run] === newLines[j + run]) run++;
      pushEqual(run);
      i += run;
      j += run;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "removed", lines: [oldLines[i]], oldLine: oldNo });
      oldNo++;
      i++;
    } else {
      rows.push({ kind: "added", lines: [newLines[j]], newLine: newNo });
      newNo++;
      j++;
    }
  }
  while (i < m) {
    rows.push({ kind: "removed", lines: [oldLines[i]], oldLine: oldNo });
    oldNo++;
    i++;
  }
  while (j < n) {
    rows.push({ kind: "added", lines: [newLines[j]], newLine: newNo });
    newNo++;
    j++;
  }

  return rows;
}

/** A compact summary for a header or subtitle: "+3 / −1". */
export function diffSummary(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "added") added += row.lines.length;
    else if (row.kind === "removed") removed += row.lines.length;
  }
  return { added, removed };
}
