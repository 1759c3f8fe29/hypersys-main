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

export type DiffRowKind = "equal" | "added" | "removed";

export interface DiffRow {
  kind: DiffRowKind;
  lines: string[];
  oldLine?: number; // 1-indexed line in the previous version, when present
  newLine?: number; // 1-indexed line in the new version, when present
}

/**
 * LCS over two line arrays -> a minimal edit script as DiffRows.
 *
 * Equal runs are coalesced (one row spanning many lines); added and removed
 * runs are kept separate so the UI can paint them in its own two columns.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

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
  let oldNo = 1;
  let newNo = 1;

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
