// The diff view could not be reached, and the guard that made it unreachable was
// added on purpose.
//
// WHY THIS FILE EXISTS
//
// `ViewSwitch` showed the Diff tab when `history.length > 1 && kind !== "file"`.
// The second clause was a real fix for a real bug — a file artifact's per-version
// `content` is `""`, so diffing two versions of `report.xlsx` compared `""` with
// `""` and reported "no changes" between two genuinely different spreadsheets.
//
// What nobody checked is whether anything was left. **A file is the only artifact
// that can ever have two versions.** A code artifact's id is a hash of its
// content, so a regenerated block either hashes the same — and `mergeArtifacts`
// treats identical bytes as the same version, deliberately — or hashes
// differently and is a separate artifact. So `history.length > 1` implies
// `kind === "file"`, the two clauses are mutually exclusive, and the tab could
// never appear. `DiffView`, `diffLines`, `diffSummary` and every test in
// `artifact-diff.test.ts` were dead from the running app's point of view.
//
// That is worse than the bug it fixed, and it is a shape worth naming: **a guard
// that removes the last live path is a deletion, and it does not look like one.**
// The condition still reads plausibly, the tests still pass, and the code it
// protects still typechecks.
//
// The fix is to resolve each version's bytes rather than to refuse the comparison:
// `fetchVersionText` matches a version's producing message to the file that turn
// generated. The tests below drive the real component with the real store, for the
// same reason `artifact-file-versions.test.tsx` does — the defect was in the join.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ArtifactCanvas, type TurnFile } from "@/components/artifacts/ArtifactCanvas";
import {
  resetArtifacts,
  ingestArtifacts,
  openArtifact,
} from "@/components/artifacts/ArtifactProvider";
import { fileArtifactFrom } from "@/lib/artifacts";
import type { MessageFile } from "@/components/chat/types";

const V1_URL = "blob:http://localhost/v1";
const V2_URL = "blob:http://localhost/v2";
const V3_URL = "blob:http://localhost/v3";
const OTHER_URL = "blob:http://localhost/other";

/** What each blob URL serves. `fetch` is stubbed to read from this map. */
const BYTES: Record<string, string> = {
  [V1_URL]: "name,total\nwidgets,10\ngizmos,20",
  [V2_URL]: "name,total\nwidgets,10\ngizmos,25",
  [V3_URL]: "name,total\nwidgets,11\ngizmos,25",
  [OTHER_URL]: "notes for the other file",
};

const file = (filename: string, url: string, messageId: string): TurnFile => ({
  filename,
  url,
  mimeType: "text/csv",
  messageId,
});

/**
 * Register one filename across `urls.length` turns, which is what "make me a
 * spreadsheet" followed by "fix the totals" produces: one artifact id
 * (`file:<name>`), one version per producing message.
 */
function versionsOf(filename: string, urls: string[]): TurnFile[] {
  const files = urls.map((url, i) => file(filename, url, `msg-${i + 1}`));
  for (const f of files) ingestArtifacts([fileArtifactFrom(f as MessageFile, f.messageId)]);
  return files;
}

/** Open the Diff tab, which is the thing that did not exist. */
function openDiffTab() {
  fireEvent.click(screen.getByRole("button", { name: "Diff" }));
}

/**
 * The Code view runs the text through `SyntaxHighlighter`, which tokenises it into
 * per-token spans — so a line of CSV is not any single element's text and
 * `getByText(/widgets,10/)` finds nothing. The diff view needs no such help: a
 * `DiffRowView` puts its whole line in one span, which is why the assertions above
 * read normally.
 */
const panelText = (container: HTMLElement) => container.textContent ?? "";

/**
 * URLs this test wants to arrive late. Only the race test uses it; everywhere else
 * the stub resolves on the microtask queue, which keeps the other seven fast.
 */
const slow = new Set<string>();

beforeEach(() => {
  resetArtifacts();
  slow.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = BYTES[String(url)];
      if (slow.has(String(url))) await new Promise((r) => setTimeout(r, 30));
      if (body === undefined) return new Response("", { status: 404 });
      return new Response(body, { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the diff tab exists at all", () => {
  it("is offered for a file with two versions — the only artifact that can have any", async () => {
    const files = versionsOf("report.csv", [V1_URL, V2_URL]);
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={files} />);

    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument();
  });

  it("is not offered when there is only one version", async () => {
    const files = versionsOf("report.csv", [V1_URL]);
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={files} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Diff" })).not.toBeInTheDocument();
  });
});

describe("what the diff actually compares", () => {
  it("diffs the two versions' real bytes, not two empty strings", async () => {
    const files = versionsOf("report.csv", [V1_URL, V2_URL]);
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={files} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument());

    openDiffTab();

    // The row that changed, both sides of it. Before the fix this pane said
    // "Versions v1 and v2 are identical." about two different spreadsheets.
    await waitFor(() => expect(screen.getByText(/− gizmos,20/)).toBeInTheDocument());
    expect(screen.getByText(/\+ gizmos,25/)).toBeInTheDocument();
    // And the counts in the header, which is what a user skims first.
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });

  it("opens on the newest pair, because that is the change the user came for", async () => {
    const files = versionsOf("report.csv", [V1_URL, V2_URL, V3_URL]);
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={files} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument());

    openDiffTab();

    // `useState(0)` opened on v1 → v2 — "what changed the first time" — on an
    // artifact whose newest change is the reason the panel is open. Two versions
    // cannot tell the two behaviours apart, which is how it survived.
    await waitFor(() => expect(screen.getByText("v2 → v3")).toBeInTheDocument());
    expect(screen.getByText(/− widgets,10/)).toBeInTheDocument();
    expect(screen.getByText(/\+ widgets,11/)).toBeInTheDocument();
  });

  it("steps back to an earlier pair and re-reads both sides", async () => {
    const files = versionsOf("report.csv", [V1_URL, V2_URL, V3_URL]);
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={files} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument());
    openDiffTab();
    await waitFor(() => expect(screen.getByText("v2 → v3")).toBeInTheDocument());

    // By its accessible name — these two chevrons were icon-only and unnamed
    // until §19.1.
    fireEvent.click(screen.getByRole("button", { name: /earlier pair of versions/i }));

    await waitFor(() => expect(screen.getByText("v1 → v2")).toBeInTheDocument());
    expect(screen.getByText(/− gizmos,20/)).toBeInTheDocument();
    expect(screen.getByText(/\+ gizmos,25/)).toBeInTheDocument();
  });

  it("ignores a resolve that lost the race to a later chevron press", async () => {
    // Two presses in quick succession start two reads, and the pane can only show
    // one. Without the effect's `cancelled` flag the *slower* one wins — whichever
    // pair happens to be on the network longer — and it writes its bytes under the
    // header of the pair the user actually selected. Same family as the missing
    // `key`: not an error, not an empty pane, just a diff labelled with the wrong
    // two versions.
    const files = versionsOf("report.csv", [V1_URL, V2_URL, V3_URL]);
    slow.add(V1_URL); // so the v1 → v2 read is still in flight when v2 → v3 lands
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={files} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument());
    openDiffTab();
    await waitFor(() => expect(screen.getByText("v2 → v3")).toBeInTheDocument());

    // Separate `fireEvent` calls, so each one flushes its own effect — batching
    // both into one act would settle `pos` at 1 without ever starting the v1 → v2
    // read, and the race under test would not happen.
    fireEvent.click(screen.getByRole("button", { name: /earlier pair of versions/i }));
    fireEvent.click(screen.getByRole("button", { name: /later pair of versions/i }));

    // Long enough for the abandoned v1 read to come back.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    expect(screen.getByText("v2 → v3")).toBeInTheDocument();
    expect(screen.getByText(/\+ widgets,11/)).toBeInTheDocument();
    // The v1 → v2 change, which the stale resolve would have painted here.
    expect(screen.queryByText(/gizmos,20/)).not.toBeInTheDocument();
  });

  it("says a version's bytes are gone rather than calling the pair identical", async () => {
    // The blob URL of the older turn is not in this session's file list — which is
    // what a download-chip artifact or a dead tab produces. The old code's failure
    // mode here was the dangerous one: `""` on one side compares equal to `""` on
    // the other, so the panel would have claimed the two versions match.
    const files = versionsOf("report.csv", [V1_URL, V2_URL]);
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={[files[1]]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument());

    openDiffTab();

    await waitFor(() =>
      expect(screen.getByText(/no longer in this session/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/are identical/i)).not.toBeInTheDocument();
  });
});

describe("switching artifacts starts the panel over", () => {
  it("shows the second file's bytes, not the first file's", async () => {
    // `PanelBody` held the fetched text in state whose effect refuses to re-fetch
    // once it is non-null, and nothing reset it — so opening a second file showed
    // the first one's content under the second one's name. No error, no empty
    // pane: a wrong answer that looks exactly like a right one.
    const report = versionsOf("report.csv", [V1_URL]);
    const notes = versionsOf("notes.txt", [OTHER_URL]);
    openArtifact("file:report.csv");
    const { container } = render(<ArtifactCanvas filesForTurn={[...report, ...notes]} />);
    await waitFor(() => expect(panelText(container)).toContain("widgets,10"));

    await act(async () => {
      openArtifact("file:notes.txt");
    });

    await waitFor(() => expect(panelText(container)).toContain("notes for the other file"));
    expect(panelText(container)).not.toContain("widgets,10");
  });

  it("does not carry a diff position onto an artifact with fewer versions", async () => {
    const report = versionsOf("report.csv", [V1_URL, V2_URL, V3_URL]);
    const notes = versionsOf("notes.txt", [OTHER_URL, V1_URL]);
    openArtifact("file:report.csv");
    render(<ArtifactCanvas filesForTurn={[...report, ...notes]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument());
    openDiffTab();
    await waitFor(() => expect(screen.getByText("v2 → v3")).toBeInTheDocument());

    await act(async () => {
      openArtifact("file:notes.txt");
    });
    openDiffTab();

    // Two versions, so v1 → v2 is the only pair there is. Unkeyed, `pos` stayed at
    // 1 and the header labelled a two-version artifact "v2 → v3" while the right
    // chevron sat disabled — a coordinate from the previous artifact.
    await waitFor(() => expect(screen.getByText("v1 → v2")).toBeInTheDocument());
    expect(screen.queryByText("v2 → v3")).not.toBeInTheDocument();
  });
});
