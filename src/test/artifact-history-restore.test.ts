// Reopening a conversation restores its canvas.
//
// WHY THIS FILE EXISTS
//
// The canvas was built as a listener: `ingestArtifacts` runs when a turn
// completes, so the store filled up as you talked and emptied when you switched
// conversations. Reopening one therefore showed the transcript with the canvas
// claiming it held nothing — and every affordance that asks the store went with
// it. The "open in canvas" button on a block was absent, the toggle shortcut
// reported "nothing to show" over a conversation full of code, and the collapse
// in `CodeBlock` inverted, so history rendered every block full-height inline
// while a live session showed cards.
//
// Nothing was lost, which is why it went unnoticed: the code was still in the
// message text and still rendered. It was the *canvas* that was gone, and only
// until some later reply happened to regenerate the same block.
//
// WHAT THESE TESTS ARE ACTUALLY PINNING
//
// The restore is not "scan everything and lift whatever qualifies" — it is
// "produce what the live path would have produced for these messages". Two of the
// tests below are about the things it must therefore *refuse* to lift (a user's
// pasted code, a file whose blob URL died with its tab). Those are the assertions
// that stop this from drifting into a second, subtly different extractor, which
// would show up to a user as a canvas that changes shape when you refresh.

import { describe, it, expect, beforeEach } from "vitest";
import { artifactsFromHistory, artifactIdForCode, type Artifact } from "@/lib/artifacts";
import { buildMessageForest, linearizeForest, toTreeMessages } from "@/lib/message-tree";
import {
  ingestArtifacts,
  resetArtifacts,
  readArtifactState,
} from "@/components/artifacts/ArtifactProvider";

/** 16 lines is `MIN_CODE_LINES`; anything shorter stays inline. */
function codeBlock(lang: string, marker: string, lines = 20): string {
  const body = Array.from({ length: lines }, (_, i) => `const v${i} = "${marker}";`).join("\n");
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

const msg = (id: string, role: "user" | "assistant", content: string) => ({ id, role, content });

describe("artifactsFromHistory", () => {
  it("lifts an assistant turn's substantial code block under that turn's id", () => {
    const content = `Here you go:\n\n${codeBlock("ts", "alpha")}\n\nThat should do it.`;
    const out = artifactsFromHistory([msg("m1", "assistant", content)]);

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("code");
    expect(out[0].language).toBe("ts");
    // The message id has to be the *stored* one, which after §16.8 is the client
    // id that survived the reload. It is what the panel shows as the producing
    // turn and what `mergeArtifacts` compares for file versions.
    expect(out[0].history[0].messageId).toBe("m1");
  });

  it("gives a restored block the same id the live ingest gave it", () => {
    // The load path and the streaming path must agree byte-for-byte, because
    // `CodeBlock` looks itself up by this id to decide whether to collapse. A
    // divergence here is invisible in isolation and reads as "the canvas is
    // docked but blank" / "the card never appears" — see artifactIdForCode.
    const block = Array.from({ length: 18 }, (_, i) => `line ${i}`).join("\n");
    const out = artifactsFromHistory([msg("m1", "assistant", `\`\`\`python\n${block}\n\`\`\``)]);

    expect(out[0].id).toBe(artifactIdForCode("python", block));
  });

  it("keeps conversation order, so the canvas lists oldest first", () => {
    const out = artifactsFromHistory([
      msg("m1", "user", "first question"),
      msg("m2", "assistant", codeBlock("ts", "first")),
      msg("m3", "user", "and again"),
      msg("m4", "assistant", codeBlock("ts", "second")),
    ]);

    // Order is the whole assertion: a live session accumulates turn by turn, so a
    // reload that listed them newest-first would visibly reshuffle the panel.
    expect(out.map((a) => a.history[0].messageId)).toEqual(["m2", "m4"]);
  });

  it("ignores a code block the user pasted", () => {
    // Consistency with the live path, which only ever ingests assistant text.
    // Lifting this would make a refresh *add* an entry to the canvas that talking
    // never produced — a difference visible only after a reload, which is the
    // shape of a bug rather than a feature.
    const out = artifactsFromHistory([
      msg("u1", "user", `Fix this please:\n\n${codeBlock("ts", "mine")}`),
    ]);

    expect(out).toEqual([]);
  });

  it("never restores a file artifact, even when the row still carries files", () => {
    // A MessageFile is a blob URL scoped to the tab that made it, which is why
    // firestore-db does not persist them. If someone later passes `m.files`
    // through to keep the download chips, this test is the tripwire: the chip
    // would list a filename whose content can never load.
    //
    // Passed as a variable rather than an inline literal on purpose — that is the
    // real shape, since `getMessages` rows carry every persisted field and flow in
    // structurally. (An inline literal would not even compile: the parameter type
    // names only id/role/content, so excess-property checking rejects `files` and
    // the function body cannot reach it either. That narrowness is the first line
    // of the same defence; this test is the second, for a caller like this one.)
    const row = {
      id: "m1",
      role: "assistant",
      content: "Created app.ts.",
      files: [{ filename: "app.ts", url: "blob:dead", mimeType: "text/plain" }],
    };
    const out = artifactsFromHistory([row]);

    expect(out.filter((a) => a.kind === "file")).toEqual([]);
    expect(out).toEqual([]);
  });

  it("leaves a short snippet inline", () => {
    const out = artifactsFromHistory([
      msg("m1", "assistant", "Just run:\n\n```sh\nnpm ci\nnpm test\n```"),
    ]);

    expect(out).toEqual([]);
  });

  it("skips a turn with no content instead of throwing", () => {
    // Reachable: a stalled stream persists a partial, and a Firestore row can
    // come back with content missing.
    const out = artifactsFromHistory([
      { id: "m1", role: "assistant", content: "" },
      { id: "m2", role: "assistant", content: null },
      { id: "m3", role: "assistant" },
      msg("m4", "assistant", codeBlock("ts", "real")),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].history[0].messageId).toBe("m4");
  });
});

describe("what the store holds after a conversation loads", () => {
  beforeEach(() => {
    resetArtifacts();
  });

  it("holds the conversation's code, addressable by the id a block computes", () => {
    const block = Array.from({ length: 17 }, (_, i) => `row ${i}`).join("\n");
    ingestArtifacts(
      artifactsFromHistory([msg("m1", "assistant", `see:\n\n\`\`\`go\n${block}\n\`\`\``)]),
    );

    const { artifacts } = readArtifactState();
    expect(artifacts).toHaveLength(1);
    // Asked the way `useHasArtifact` asks it. This is the end-to-end claim of the
    // whole change: a block rendered from loaded history finds itself in the store.
    expect(artifacts.some((a) => a.id === artifactIdForCode("go", block))).toBe(true);
  });

  it("does not open the panel", () => {
    ingestArtifacts(artifactsFromHistory([msg("m1", "assistant", codeBlock("ts", "alpha"))]));

    // Guarded against passing for the wrong reason: `openId` is null on an empty
    // store too, so without this line the assertion below would hold just as well
    // if the restore had lifted nothing at all.
    expect(readArtifactState().artifacts).toHaveLength(1);

    // Deliberate. Reopening a conversation must not seize 520px of the window for
    // a panel the user did not ask for; restoring the canvas means making it
    // *available*, not making it appear. `ingestArtifacts` never touches openId,
    // and this pins that — it is a claim about the store, since the load path's
    // own restraint is only observable by rendering Chat.
    expect(readArtifactState().openId).toBeNull();
  });

  it("collapses the same block appearing in two turns into one entry, not two versions", () => {
    // A regenerate that produced identical bytes, then a reload. `mergeArtifacts`
    // dedupes same-id-same-content, so the panel must not show a phantom "version
    // 2" whose diff against version 1 is empty.
    const same = codeBlock("ts", "identical");
    ingestArtifacts(
      artifactsFromHistory([msg("m1", "assistant", same), msg("m2", "assistant", same)]),
    );

    const { artifacts } = readArtifactState();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].history).toHaveLength(1);
    expect(artifacts[0].history[0].messageId).toBe("m1");
  });

  it("adds to the canvas when a second load brings new code, and re-adds nothing", () => {
    // Two ingests against one store: switching branches after a load runs the
    // same additive merge, which is what a live regenerate has always done.
    const first: Artifact[] = artifactsFromHistory([msg("m1", "assistant", codeBlock("ts", "one"))]);
    ingestArtifacts(first);
    ingestArtifacts(first);
    expect(readArtifactState().artifacts).toHaveLength(1);

    ingestArtifacts(artifactsFromHistory([msg("m2", "assistant", codeBlock("ts", "two"))]));
    expect(readArtifactState().artifacts).toHaveLength(2);
  });
});

describe("a branched conversation restores every branch", () => {
  // The load path hands `artifactsFromHistory` the flat stored list, not the
  // linearized visible branch, and this is the test that says why. Composed here
  // out of the same three functions Chat.tsx composes, so the branch selection is
  // real rather than assumed: buildMessageForest → linearizeForest decides what is
  // on screen, and the restore deliberately does not follow it.

  beforeEach(() => {
    resetArtifacts();
  });

  const rows = [
    { id: "u1", role: "user" as const, content: "write it", parentMessageId: null, siblingIndex: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "a1", role: "assistant" as const, content: codeBlock("ts", "first"), parentMessageId: "u1", siblingIndex: 0, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "a2", role: "assistant" as const, content: codeBlock("ts", "second"), parentMessageId: "u1", siblingIndex: 1, createdAt: "2026-01-01T00:00:02.000Z" },
    { id: "a3", role: "assistant" as const, content: codeBlock("ts", "third"), parentMessageId: "u1", siblingIndex: 2, createdAt: "2026-01-01T00:00:03.000Z" },
  ];

  it("shows one reply but canvases all three regenerations", () => {
    // What the user sees: the newest sibling only. Asserted so the next line means
    // something — the restore is being compared against a genuinely smaller set.
    const visible = linearizeForest(buildMessageForest(toTreeMessages(rows)));
    expect(visible.map((m) => m.id)).toEqual(["u1", "a3"]);

    ingestArtifacts(artifactsFromHistory(rows));

    // All three, in stored order — the order they were ingested when they were
    // written. Feeding `visible` here instead would give exactly one.
    const { artifacts } = readArtifactState();
    expect(artifacts.map((a) => a.history[0].messageId)).toEqual(["a1", "a2", "a3"]);
  });

  it("leaves every sibling's block collapsible, not just the visible one", () => {
    ingestArtifacts(artifactsFromHistory(rows));

    // The consequence that matters at the UI. `CodeBlock` collapses on the store
    // holding its id, so a sibling missing from the store renders full-height
    // inline while its neighbour shows a card — and the user meets that seam by
    // clicking the branch arrow, where it looks like the switcher broke rendering.
    for (const row of rows.filter((r) => r.role === "assistant")) {
      const body = row.content.split("\n").slice(1, -1).join("\n");
      expect(readArtifactState().artifacts.some((a) => a.id === artifactIdForCode("ts", body))).toBe(true);
    }
  });
});
