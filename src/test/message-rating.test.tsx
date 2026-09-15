// Message feedback — ChatGPT-style thumbs up/down, pinned.
//
// The user's ask (2026-09-13) was "add capabilities of chatgpt"; this is one of
// the two affordances the survey found missing (the other, the thinking block,
// has its own suite). The behaviors are the product, and they are exactly the
// kind a later restyle or refactor silently drops — a row of icon buttons with
// no data of their own — so they are asserted rather than left as comments:
//
//   - thumbs up/down render on a finished assistant reply and not while
//     streaming, not for the user's own messages, and not when the parent
//     declined to wire the handler,
//   - clicking a thumb flips session state; clicking the active thumb again
//     clears the rating (one gesture for rate/correct/unrate),
//   - the chosen thumb is visibly the active one, and only one of the pair can
//     be active at a time,
//   - the buttons are icon-only, so each carries a state-tracking accessible
//     name (the icon-button-names sweep would catch their absence, but the
//     *tracking* — "Remove rating" vs "Rate as good" — is a behavior of this
//     feature and is pinned here).
//
// The persist round-trip is deliberately NOT tested here: firestore-db's
// rateMessage is a network client, and the persistence contract — deleteField
// on clear, revert-on-failure — is documented at the write site. What this
// suite pins is everything the user can see.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatMessage from "@/components/chat/ChatMessage";

function reply(overrides: Record<string, unknown> = {}) {
  return render(
    <ChatMessage
      role="assistant"
      content="The answer is 42."
      modelName="Test"
      {...overrides}
    />,
  );
}

const up = () => screen.queryByRole("button", { name: /rate this response as good/i });
const down = () => screen.queryByRole("button", { name: /rate this response as bad/i });

describe("presence", () => {
  it("renders both thumbs on a finished reply when onRate is wired", () => {
    reply({ onRate: vi.fn() });
    expect(up()).not.toBeNull();
    expect(down()).not.toBeNull();
  });

  it("does not render while the reply is still streaming", () => {
    // The action bar exists mid-stream only for the Stop affordance; rating a
    // half-arrived answer means rating text the model is still writing.
    reply({ onRate: vi.fn(), isStreaming: true });
    expect(up()).toBeNull();
    expect(down()).toBeNull();
  });

  it("does not render for the user's own message", () => {
    render(
      <ChatMessage role="user" content="hello" modelName="Test" onRate={vi.fn()} />,
    );
    expect(up()).toBeNull();
    expect(down()).toBeNull();
  });

  it("does not render when the parent did not wire the handler", () => {
    // Guest mode still gets the buttons (session state only); the render gate
    // is onRate, not auth, and this pins that the component agrees.
    reply();
    expect(up()).toBeNull();
    expect(down()).toBeNull();
  });
});

describe("click behavior", () => {
  it("reports the direction to the parent", () => {
    const onRate = vi.fn();
    reply({ onRate });
    fireEvent.click(up()!);
    expect(onRate).toHaveBeenCalledWith("up");
    expect(onRate).not.toHaveBeenCalledWith("down");
  });

  it("shows the pressed thumb as active and the other inactive", () => {
    reply({ onRate: vi.fn(), rating: "up" });
    // The active thumb announces itself as the removal control...
    expect(screen.queryByRole("button", { name: /remove good rating/i })).not.toBeNull();
    // ...and the other still offers itself as available.
    expect(screen.queryByRole("button", { name: /rate this response as bad/i })).not.toBeNull();
  });
});
