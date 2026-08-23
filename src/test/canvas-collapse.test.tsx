// A code block that is in the side canvas must not also fill the chat.
//
// The report was that generated file/code content shows up twice: once in the
// canvas the panel exists for, and once in full inside the message bubble. Both
// halves of that were true by construction — `extractArtifacts` lifts every block
// of 16+ lines into the store, and `CodeBlock` rendered the whole body through
// Prism regardless — so the reply to "write me a component" was the component,
// twice, and the chat became unscrollable.
//
// This is tested as behaviour rather than reviewed, because the condition is a
// *coincidence between two modules*: the collapse fires on the store holding the
// id that `artifactIdForCode` derives, and the store gets its ids from the
// extractor walking raw markdown. Those two agreeing is what makes the body safe
// to hide, and nothing in either file's types would notice them drifting apart.
// artifact-id-agreement.test.ts pins the ids themselves; this pins that the UI
// actually acts on them.
//
// The invariants, in the order they matter:
//
//   1. Nothing is hidden before it is safely elsewhere. While the turn streams,
//      the store is empty and the body renders in full.
//   2. Once ingested, the body is gone and replaced by a reference to it.
//   3. Copy and Run do not move. "donot run codes until user click run btn
//      located in side of copy btn" is a standing requirement, so the collapse
//      must not put that button further away — or fire it.
//   4. The collapse is reversible. The panel shows one artifact at a time, so
//      reading two blocks against each other has to stay possible.
//   5. Short blocks never collapse — a six-line example is not a document.
//   6. Clearing the store un-collapses. The collapse defers to a side-panel copy,
//      so with no copy to defer to it would hide the code outright. (This used to
//      double as "and that is what a reload does". It no longer is: the load path
//      refills the store from the history — see artifactsFromHistory — so a
//      reopened conversation shows cards, as a live one does. The invariant here is
//      unchanged and deliberately says nothing about reloads; it is about the store
//      being empty, whatever emptied it.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";

import ChatMessage from "@/components/chat/ChatMessage";
import { extractArtifacts } from "@/lib/artifacts";
import { ingestArtifacts, resetArtifacts } from "@/components/artifacts/ArtifactProvider";
import { resetRunsForTest } from "@/lib/code-runs";

// Same reason code-runner.test.tsx mocks it: the bridge downloads ~10 MB of WASM
// on first call, and one of the assertions below is that it is never called.
const runCodeStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: runCodeStub }));

// 18 lines: over the 16-line bar, so the extractor lifts it. The first two lines
// are deliberately a comment and an import, because those are what a model
// actually opens with and the collapsed card must skip both to say anything
// useful about which block this is.
const BIG_PY = [
  "# scheduler.py",
  "import asyncio",
  "",
  "async def drain_queue(queue, worker_count=4):",
  "    workers = [asyncio.create_task(_worker(queue)) for _ in range(worker_count)]",
  "    await queue.join()",
  "    for w in workers:",
  "        w.cancel()",
  "    return len(workers)",
  "",
  "async def _worker(queue):",
  "    while True:",
  "        job = await queue.get()",
  "        try:",
  "            await job()",
  "        finally:",
  "            queue.task_done()",
  "",
].join("\n");

const SHORT_PY = ["import math", "", "def area(r):", "    return math.pi * r * r"].join("\n");

const fence = (body: string, lang = "python") => `Here it is.\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`;

function mount(markdown: string) {
  return render(<ChatMessage role="assistant" content={markdown} modelName="Test" />);
}

/** Prism splits a line into a span per token, so assert on flattened text. */
const bodyIsVisible = (root: HTMLElement) => root.textContent?.includes("task_done") ?? false;

/**
 * The code block's own subtree. Scoped deliberately: the message bubble carries a
 * Copy button of its own for the whole reply, so an unscoped `getByRole(/copy/i)`
 * matches two buttons and the assertion below would be about the wrong one.
 */
const codeBlock = (root: HTMLElement) =>
  within(root.querySelector("[data-code-block]") as HTMLElement);

beforeEach(() => {
  resetArtifacts();
  resetRunsForTest();
  runCodeStub.mockReset();
});

describe("a block that is not in the canvas yet", () => {
  it("renders in full, which is what the whole stream is", () => {
    const { container } = mount(fence(BIG_PY));
    expect(bodyIsVisible(container)).toBe(true);
    // No card, because there is nothing to point at yet.
    expect(screen.queryByText(/open in the canvas/)).toBeNull();
  });
});

describe("a block the canvas holds", () => {
  const markdown = fence(BIG_PY);

  function mountIngested() {
    // Ingest first: mounting and then ingesting exercises the same store read,
    // and doing it in this order keeps the assertions about one render.
    ingestArtifacts(extractArtifacts(markdown, [], "m1"));
    return mount(markdown);
  }

  it("does not render the body in the chat", () => {
    const { container } = mountIngested();
    expect(bodyIsVisible(container)).toBe(false);
  });

  it("replaces it with a reference naming the size and where it went", () => {
    mountIngested();
    expect(screen.getByText(/18 lines · open in the canvas/)).toBeInTheDocument();
  });

  it("previews the first line that says something, not the comment or the import", () => {
    mountIngested();
    expect(screen.getByText(/async def drain_queue/)).toBeInTheDocument();
    expect(screen.queryByText(/^# scheduler\.py$/)).toBeNull();
    expect(screen.queryByText(/^import asyncio$/)).toBeNull();
  });

  it("keeps Copy and Run reachable, and does not run anything", () => {
    const { container } = mountIngested();
    const block = codeBlock(container);
    expect(block.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    expect(block.getByRole("button", { name: /^run$/i })).toBeInTheDocument();
    // The gate, restated at the one place that could newly have broken it: the
    // collapse changed what mounts, and a body that mounts differently is exactly
    // where an eager effect would hide.
    expect(runCodeStub).not.toHaveBeenCalled();
  });

  it("opens the canvas when the card is clicked", () => {
    const { container } = mountIngested();
    // Two of them — the header's Open and the card itself — and both must work,
    // so the assertion is on the count rather than on one of them.
    const openers = container.querySelectorAll("[data-open-in-canvas]");
    expect(openers).toHaveLength(2);
  });

  it("puts the code back inline on Show, and folds it again on Hide", () => {
    const { container } = mountIngested();
    fireEvent.click(codeBlock(container).getByRole("button", { name: /show/i }));
    expect(bodyIsVisible(container)).toBe(true);

    fireEvent.click(codeBlock(container).getByRole("button", { name: /hide/i }));
    expect(bodyIsVisible(container)).toBe(false);
  });
});

describe("what never collapses", () => {
  it("leaves a short block alone even after a turn ingests", () => {
    const markdown = fence(SHORT_PY);
    ingestArtifacts(extractArtifacts(markdown, [], "m1"));
    const { container } = mount(markdown);
    expect(container.textContent).toContain("math.pi");
    expect(screen.queryByText(/open in the canvas/)).toBeNull();
    // And no Show/Hide toggle, which would be a control over nothing.
    expect(codeBlock(container).queryByRole("button", { name: /show|hide/i })).toBeNull();
  });

  it("un-collapses when the store is cleared, because then there is no copy", () => {
    const markdown = fence(BIG_PY);
    ingestArtifacts(extractArtifacts(markdown, [], "m1"));
    const { container } = mount(markdown);
    expect(bodyIsVisible(container)).toBe(false);

    // What switching conversations does — `loadMessages` resets the store before
    // it reads the new conversation, and there is a window in between. (Not "what
    // a reload does" any more: the load path now refills the store from the loaded
    // history, so a reopened conversation collapses again. The property under test
    // is narrower than that and unaffected by it: an empty store means no copy to
    // defer to, so the body must come back.)
    // Wrapped in act() because this is a store write from outside React: the
    // subscribers do re-render, but not before the next assertion unless flushed.
    act(() => resetArtifacts());
    expect(bodyIsVisible(container)).toBe(true);
  });
});
