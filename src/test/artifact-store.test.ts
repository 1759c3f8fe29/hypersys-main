// The canvas width is shared state, and that is the whole point of these tests.
// The bug they guard against was not a bad number — it was two numbers: the
// panel sized itself from local component state while the message column
// reserved a hardcoded 34rem, so dragging the panel wider slid it over the text.
// Keeping the width in the store makes "the panel and the gutter agree" a
// property of one value; these tests pin the invariants that value has to hold.

import { describe, it, expect, beforeEach } from "vitest";
import {
  setCanvasWidth,
  resetArtifacts,
  ingestArtifacts,
  openArtifact,
  closeArtifact,
  openFirstArtifact,
  openCodeArtifact,
  openFileArtifact,
  readArtifactState,
  CANVAS_MIN_W,
  CANVAS_MAX_W,
} from "@/components/artifacts/ArtifactProvider";
import { artifactIdForCode, codeArtifactFrom, extractArtifacts, type Artifact } from "@/lib/artifacts";

const artifact = (id: string, content = "x"): Artifact => ({
  id,
  language: "ts",
  kind: "code",
  title: id,
  downloadable: false,
  history: [{ content, messageId: "m1", version: 0 }],
});

describe("artifact store — canvas width", () => {
  beforeEach(() => {
    resetArtifacts();
    setCanvasWidth(520);
  });

  it("clamps a drag past either edge instead of storing it", () => {
    setCanvasWidth(-400);
    expect(readArtifactState().canvasWidth).toBe(CANVAS_MIN_W);
    setCanvasWidth(99999);
    expect(readArtifactState().canvasWidth).toBe(CANVAS_MAX_W);
  });

  it("rounds to whole pixels", () => {
    setCanvasWidth(521.7);
    expect(readArtifactState().canvasWidth).toBe(522);
  });

  it("keeps the width across a conversation reset but drops artifacts and selection", () => {
    setCanvasWidth(700);
    ingestArtifacts([artifact("code:a")]);
    openArtifact("code:a");
    expect(readArtifactState().openId).toBe("code:a");

    resetArtifacts();
    const after = readArtifactState();
    // The width is a display preference the user set by dragging; switching
    // conversations must not silently undo it.
    expect(after.canvasWidth).toBe(700);
    expect(after.artifacts).toHaveLength(0);
    expect(after.openId).toBeNull();
  });
});

describe("artifact store — selection", () => {
  beforeEach(() => resetArtifacts());

  it("openFirstArtifact opens the newest ingested artifact", () => {
    ingestArtifacts([artifact("code:a")]);
    ingestArtifacts([artifact("code:b", "y")]);
    openFirstArtifact();
    expect(readArtifactState().openId).toBe("code:b");
  });

  it("openFirstArtifact is a no-op with nothing ingested", () => {
    openFirstArtifact();
    expect(readArtifactState().openId).toBeNull();
  });

  it("close clears the selection without discarding the artifacts", () => {
    ingestArtifacts([artifact("code:a")]);
    openArtifact("code:a");
    closeArtifact();
    const after = readArtifactState();
    expect(after.openId).toBeNull();
    expect(after.artifacts).toHaveLength(1);
  });
});

// The measured failure: the canvas docked, reserved its gutter, and rendered
// nothing, because the button passed an id the store had never ingested. Opening
// by content removes the possibility — whatever the extractor did or did not do
// with this turn's text, the artifact exists before it is opened.
describe("artifact store — opening a code block from the conversation", () => {
  beforeEach(() => resetArtifacts());

  const SCRIPT = "def f(x):\n    return x * 2\n";

  it("registers a block the turn's ingest never saw, then opens it", () => {
    expect(readArtifactState().artifacts).toHaveLength(0);
    openCodeArtifact("python", SCRIPT);

    const { artifacts, openId } = readArtifactState();
    expect(artifacts).toHaveLength(1);
    expect(openId).toBe(artifacts[0].id);
    expect(artifacts[0].history[0].content).toBe(SCRIPT);
  });

  it("opens the id the extractor would have assigned, not a second copy", () => {
    ingestArtifacts([codeArtifactFrom("python", SCRIPT, "m1")]);
    openCodeArtifact("python", SCRIPT);

    const { artifacts, openId } = readArtifactState();
    expect(artifacts).toHaveLength(1); // merged, not duplicated
    expect(openId).toBe(artifactIdForCode("python", SCRIPT));
  });

  it("treats a language spelled differently as the same block", () => {
    // A model that writes ```Python in one turn and ```python in the next is
    // describing one script, and the canvas should not accumulate both.
    openCodeArtifact("Python", SCRIPT);
    openCodeArtifact("python", SCRIPT);
    expect(readArtifactState().artifacts).toHaveLength(1);
  });

  it("always leaves something for the panel to render", () => {
    // The invariant that the blank-canvas bug violated, stated directly.
    openCodeArtifact("python", SCRIPT);
    const { artifacts, openId } = readArtifactState();
    expect(artifacts.find((a) => a.id === openId)).toBeDefined();
  });
});

// The same hazard on the file path, where it read worse: the chip's Download
// button proves the file is live, so an Open beside it that lands on an id the
// store never ingested makes the panel say "no longer in this session" about a
// file the user can save right now.
describe("artifact store — opening a generated file from its chip", () => {
  beforeEach(() => resetArtifacts());

  const FILE = { filename: "report.csv", url: "blob:report", mimeType: "text/csv" };

  it("registers a file the turn's ingest never saw, then opens it", () => {
    openFileArtifact(FILE);
    const { artifacts, openId } = readArtifactState();
    expect(openId).toBe("file:report.csv");
    expect(artifacts.find((a) => a.id === openId)).toBeDefined();
  });

  it("opens the id the extractor assigns, so an ingested file is not duplicated", () => {
    ingestArtifacts(extractArtifacts("no code here", [FILE], "m1"));
    openFileArtifact(FILE);
    const { artifacts, openId } = readArtifactState();
    expect(artifacts).toHaveLength(1);
    expect(openId).toBe("file:report.csv");
  });

  it("does not append a phantom version to a file it already holds", () => {
    // A file's new-version signal is a different producing message, so a
    // click-registered copy merging into an ingested one would show the user a
    // diff between a file and itself.
    ingestArtifacts(extractArtifacts("", [FILE], "m1"));
    openFileArtifact(FILE);
    openFileArtifact(FILE);
    const held = readArtifactState().artifacts.find((a) => a.id === "file:report.csv");
    expect(held?.history).toHaveLength(1);
    expect(held?.history[0].messageId).toBe("m1");
  });

  it("keeps the panel-renderable invariant for files too", () => {
    openFileArtifact(FILE);
    const { artifacts, openId } = readArtifactState();
    expect(artifacts.find((a) => a.id === openId)).toBeDefined();
  });
});
