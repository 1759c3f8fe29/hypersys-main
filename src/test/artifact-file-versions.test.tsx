// Which bytes does the canvas actually serve? (§14.2 #18)
//
// WHY THIS FILE EXISTS
//
// A file artifact's id is `file:<filename>` — the filename and nothing else. So
// two turns that both generate `report.xlsx` produce the *same* artifact id, and
// `mergeArtifacts` treats that deliberately: for files, a different producing
// message is the new-version signal, so turn 2's file becomes version 1 of the
// `file:report.xlsx` artifact and the header renders "v2".
//
// Both resolvers in `ArtifactCanvas` then looked the file up like this:
//
//     filesForTurn.find((f) => `file:${f.filename}` === artifact.id)
//
// `find` returns the **first** match, and `filesForTurn` is
// `messages.flatMap(m => m.files)` — conversation order. So the first match is
// the *oldest* file with that name. The panel said v2 and previewed, and
// downloaded, version 1's bytes.
//
// That is the §14.2 #16 shape rather than the #6/#7 shape: nothing fails, nothing
// is empty, no error appears. The user asks the model to fix the spreadsheet,
// sees the version badge tick to v2, clicks Download, and gets a file that opens
// perfectly and contains the unfixed data. Two turns of "make me a spreadsheet"
// in one conversation is an ordinary session, and models name generated files
// predictably (`report.xlsx`, `data.csv`, `chart.png`), so the collision is the
// common case and not an edge one.
//
// These tests drive the real component with a real store, because the defect was
// in the join between them — the artifact knew its version and the file list knew
// its order, and nothing put the two together. A unit test of either half alone
// would have passed, which is §14.2 #14's lesson applied before the fact.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArtifactCanvas, type TurnFile } from "@/components/artifacts/ArtifactCanvas";
import {
  resetArtifacts,
  ingestArtifacts,
  openArtifact,
} from "@/components/artifacts/ArtifactProvider";
import { fileArtifactFrom } from "@/lib/artifacts";
import type { MessageFile } from "@/components/chat/types";

const OLD_URL = "blob:http://localhost/old-bytes";
const NEW_URL = "blob:http://localhost/new-bytes";

const file = (filename: string, url: string, messageId: string): TurnFile => ({
  filename,
  url,
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  messageId,
});

/**
 * Register `report.xlsx` twice, from two different messages — exactly what two
 * "make me a spreadsheet" turns produce. Returns the file list in conversation
 * order, oldest first, which is the order `messages.flatMap` yields.
 */
function twoVersionsOfTheSameFilename(): TurnFile[] {
  const older = file("report.xlsx", OLD_URL, "msg-1");
  const newer = file("report.xlsx", NEW_URL, "msg-2");

  // Ingested as two separate turns, because that is what makes them versions
  // rather than duplicates — mergeArtifacts keys the decision on messageId.
  ingestArtifacts([fileArtifactFrom(older as MessageFile, "msg-1")]);
  ingestArtifacts([fileArtifactFrom(newer as MessageFile, "msg-2")]);
  openArtifact("file:report.xlsx");

  return [older, newer];
}

/** Capture every anchor the download handler clicks, without navigating. */
function captureDownloadClicks(): { href: string; download: string }[] {
  const clicks: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download });
  });
  return clicks;
}

beforeEach(() => {
  resetArtifacts();
  // jsdom implements no fetch; the preview path calls it on open.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("spreadsheet text", { status: 200 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("two turns, one filename", () => {
  it("registers them as two versions of one artifact", () => {
    const files = twoVersionsOfTheSameFilename();
    render(<ArtifactCanvas filesForTurn={files} />);
    // The precondition for the whole bug: the UI announces a second version.
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("downloads the newest version's bytes, not the first match by name", async () => {
    const clicks = captureDownloadClicks();
    const files = twoVersionsOfTheSameFilename();
    render(<ArtifactCanvas filesForTurn={files} />);

    fireEvent.click(screen.getByTitle("Download"));

    expect(clicks).toHaveLength(1);
    // The assertion that encodes the bug: this used to be OLD_URL.
    expect(clicks[0].href).toBe(NEW_URL);
    expect(clicks[0].download).toBe("report.xlsx");
  });

  it("previews the newest version's bytes too", async () => {
    const files = twoVersionsOfTheSameFilename();
    render(<ArtifactCanvas filesForTurn={files} />);

    // The preview fetch is fired from an effect on open.
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(NEW_URL);
  });

  it("offers no Diff tab for a versioned file", async () => {
    const files = twoVersionsOfTheSameFilename();
    render(<ArtifactCanvas filesForTurn={files} />);

    // Waiting for the tab row is load-bearing, and finding that out was worth
    // more than the assertion. A file artifact renders "Loading…" with *no tabs
    // at all* until its object URL resolves, so asserting "no Diff tab" on the
    // first frame passes whether the fix is present or not — the same
    // false-confidence shape as §14.2 #14, caught here by the test failing on
    // its own control assertion rather than on the one it was written for.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
    });

    // A file artifact's per-version `content` is "" — files defer their bytes to
    // an object URL, and only the newest is ever fetched. So the diff view had
    // "" on both sides and reported no changes between two different
    // spreadsheets. Offering a comparison the data cannot support is worse than
    // offering none, because an empty diff reads as "these are identical".
    expect(screen.queryByRole("button", { name: "Diff" })).toBeNull();
  });
});

describe("the unambiguous case still works", () => {
  it("resolves a single file by name", async () => {
    const clicks = captureDownloadClicks();
    const only = file("notes.txt", OLD_URL, "msg-1");
    ingestArtifacts([fileArtifactFrom(only as MessageFile, "msg-1")]);
    openArtifact("file:notes.txt");

    render(<ArtifactCanvas filesForTurn={[only]} />);
    fireEvent.click(screen.getByTitle("Download"));

    expect(clicks[0].href).toBe(OLD_URL);
  });

  it("keeps the Diff tab for a versioned code artifact", () => {
    // The narrowing is `kind !== "file"`, so code artifacts — whose history
    // genuinely carries content — must be unaffected. Without this, "hide the
    // diff" would be satisfiable by hiding it always.
    ingestArtifacts([
      {
        id: "code:demo",
        language: "ts",
        kind: "code",
        title: "demo",
        downloadable: false,
        history: [
          { content: "const a = 1;", messageId: "msg-1", version: 0 },
          { content: "const a = 2;", messageId: "msg-2", version: 1 },
        ],
      },
    ]);
    openArtifact("code:demo");

    render(<ArtifactCanvas filesForTurn={[]} />);
    expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument();
  });
});

describe("a file that is no longer in the session", () => {
  it("says so instead of doing nothing", async () => {
    // `resetArtifacts` does not clear blob urls, and a reloaded conversation has
    // artifacts with no files at all (object urls live only as long as the tab
    // that made them). Download used to `return` silently here, while
    // `fetchFileText` threw a reported error for the identical condition two
    // functions away — so the same missing file was explained on the preview path
    // and not on the download path.
    const clicks = captureDownloadClicks();
    ingestArtifacts([
      fileArtifactFrom(file("gone.xlsx", OLD_URL, "msg-1") as MessageFile, "msg-1"),
    ]);
    openArtifact("file:gone.xlsx");

    render(<ArtifactCanvas filesForTurn={[]} />);
    fireEvent.click(screen.getByTitle("Download"));

    // Nothing downloaded, and crucially the click was not a no-op: the user is
    // told, so they do not press it again expecting a different outcome.
    expect(clicks).toHaveLength(0);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no longer available/i),
      expect.anything(),
    );
  });
});

// Declared after the describes that use it only for reading order; vi.mock is
// hoisted above the imports, so the factory cannot close over a plain const.
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastSpy }));
