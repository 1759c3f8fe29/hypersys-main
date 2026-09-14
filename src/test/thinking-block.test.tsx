// The thinking block — ChatGPT-style chain-of-thought, pinned.
//
// The user's ask (2026-09-13) was "add capabilities of chatgpt"; the concrete
// defect behind it was measured: reasoning models (kimi, nemotron, minimax,
// glm-5.3-free) spend tens of seconds in `reasoning_content`, and the app
// showed nothing — a stalled-looking empty bubble — then deleted the thinking
// wholesale. The block is the fix, and its behaviors are the product here, so
// they are asserted against the rendered DOM rather than left as comments:
//
//   - reasoning renders as a block, above the answer, and is NOT markdown,
//   - "Thinking…" while live, "Thought for Ns" once the answer has started,
//   - auto-open while there is no answer, auto-collapse once there is,
//   - a manual click outranks both rules from then on,
//   - no reasoning field, no block.
//
// The assertions read the DOM rather than computed styles, the same honest
// trick the typography contract uses: jsdom does not apply stylesheets, and
// the behaviors above are presence/absence and text, not geometry.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import ChatMessage from "@/components/chat/ChatMessage";

const markdown = "# Result\n\nThe answer is ready.";

function assistant(overrides: Record<string, unknown> = {}) {
  return render(
    <ChatMessage
      role="assistant"
      content={markdown}
      modelName="Test"
      {...overrides}
    />,
  );
}

// The block, or null. `?.closest` alone returns undefined on a miss, which is
// neither null nor truthy-safe for toBeNull() assertions.
const block = () =>
  screen.queryByText(/Thinking|Thought/)?.closest('[data-thinking-block]') ?? null;
// The collapsed/expanded toggle inside a rendered block.
const blockToggle = () => within(block()! as HTMLElement).getByRole("button");

describe("the thinking block's presence", () => {
  it("renders when the reply carries reasoning", () => {
    assistant({ reasoning: "I considered two approaches." });
    // A finished reply carries the block collapsed (auto-collapse once the
    // answer exists — see the open/collapse suite), so presence is the label
    // and the body is one click away.
    expect(block()).not.toBeNull();
    fireEvent.click(blockToggle());
    expect(screen.getByText("I considered two approaches.")).toBeDefined();
  });

  it("does not render for a reply that never reasoned", () => {
    assistant();
    expect(block()).toBeNull();
  });

  it("shows the reasoning as plain text, not markdown", () => {
    // A `#` scratch note is a heading glyph, not a heading. Asserted by tag:
    // rendered markdown would come out in an <h*> element.
    assistant({ reasoning: "# not a heading\n- scratch thought" });
    fireEvent.click(blockToggle());
    expect(screen.getByText(/not a heading/).tagName).toBe("DIV");
  });
});

describe("the label", () => {
  it("says Thinking… while streaming and no answer has started", () => {
    assistant({ reasoning: "mid-deliberation", isStreaming: true, content: "" });
    expect(screen.getByText("Thinking…")).toBeDefined();
  });

  it("collapses to Thought for Ns once the answer has arrived", () => {
    assistant({ reasoning: "done deliberating", thinkSeconds: 12, isStreaming: true });
    expect(screen.getByText("Thought for 12s")).toBeDefined();
  });

  it("reads Thought process when no duration was recorded", () => {
    // Reloaded history from before thinkSeconds existed, or a turn that
    // never stamped one: the block still opens, with the plain label.
    assistant({ reasoning: "recovered from history" });
    expect(screen.getByText("Thought process")).toBeDefined();
  });
});

describe("open/collapse", () => {
  it("starts collapsed when the answer is present", () => {
    // The reader's attention has a new object; auto-open applies only while
    // there is no answer to show.
    assistant({ reasoning: "considered", thinkSeconds: 3 });
    expect(screen.queryByText("considered")).toBeNull();
  });

  it("starts open while thinking", () => {
    assistant({ reasoning: "still going", isStreaming: true, content: "" });
    expect(screen.getByText("still going")).toBeDefined();
  });

  it("honors a manual click over the stream's own state", () => {
    // Once the reader has chosen, the stream may not re-close (or re-open)
    // the block on their behalf. The choosing that matters is a click on a
    // COLLAPSED block: auto-collapse had already closed it once the answer
    // started, and the reader re-opens it to read the thinking — the exact
    // re-open the stream must not take back on its next update.
    const { rerender } = render(
      <ChatMessage
        role="assistant"
        content={markdown}
        modelName="Test"
        reasoning="opening this myself"
        isStreaming
      />,
    );
    // Answer present → auto-collapsed. The reader re-opens it themselves.
    fireEvent.click(blockToggle());
    expect(screen.getByText("opening this myself")).toBeDefined();
    // The stream continues (more answer, thinkSeconds stamped). The block's
    // own auto rule now says closed — the reader's click outranks it.
    rerender(
      <ChatMessage
        role="assistant"
        content={markdown + " And more."}
        modelName="Test"
        reasoning="opening this myself"
        isStreaming
        thinkSeconds={2}
      />,
    );
    expect(screen.getByText("opening this myself")).toBeDefined();
  });
});
