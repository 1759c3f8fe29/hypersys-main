// Tests for the assistant-message sanitiser in api/_messages.js.
//
// WHY THIS FILE EXISTS
//
// Mistral answers 400 code 3240 — "Assistant message must have either content
// or tool_calls, but not none" — to a history containing an empty assistant
// message. The client produces those legitimately: the bubble is created empty
// before streaming starts, and a turn that fails before its first token
// (all-providers-failed, a stall, an abort) can leave one saved. On the next
// turn the whole stored history is replayed, so one failed turn poisoned every
// later turn of the conversation — and because 400 is deliberately not a
// failover status, no backup was ever tried. The conversation was dead.
//
// The distinction that matters most in these tests, and the easiest to get
// wrong: `content: null` WITH `tool_calls` is the agent loop's own message
// shape (src/lib/agent.ts pushes exactly that after every tool step). A
// sanitiser that dropped it would delete the model's tool REQUEST from the
// history — the model would lose the ability to see what it asked for, and
// providers validate tool_call_id pairing, so the turn would 400 a second way.

import { describe, it, expect } from "vitest";
import { sanitiseMessages } from "../../api/_messages.js";

describe("sanitiseMessages", () => {
  it("returns the same array reference when nothing is poison", () => {
    const messages = [
      { role: "system", content: "You are Flyer." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = sanitiseMessages(messages);
    expect(result.dropped).toBe(0);
    expect(result.messages).toBe(messages); // identity, not just equality
  });

  it("drops an assistant message with empty-string content", () => {
    const result = sanitiseMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "again" },
    ]);
    expect(result.dropped).toBe(1);
    expect(result.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "user",
    ]);
  });

  it("drops an assistant message with null content and no tool_calls", () => {
    const result = sanitiseMessages([{ role: "assistant", content: null }]);
    expect(result.dropped).toBe(1);
    expect(result.messages).toHaveLength(0);
  });

  it("KEEPS null-content assistant messages that carry tool_calls", () => {
    const withTools = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: "{}" } }],
    };
    const result = sanitiseMessages([{ role: "user", content: "hi" }, withTools]);
    expect(result.dropped).toBe(0);
    expect(result.messages).toContain(withTools);
  });

  it("keeps whitespace-only content out but counts it as dropped", () => {
    // The failure this guards: a stall-path save that persisted "   "
    const result = sanitiseMessages([{ role: "assistant", content: "   " }]);
    expect(result.dropped).toBe(1);
    expect(result.messages).toHaveLength(0);
  });

  it("keeps empty messages from OTHER roles (they are not the poison shape)", () => {
    // A tool result can legitimately be empty JSON-ish content; a user turn
    // with empty content is wrong but is not what Mistral 400s on. The
    // sanitiser must not grow a second job.
    const result = sanitiseMessages([
      { role: "user", content: "" },
      { role: "tool", tool_call_id: "call_1", content: "{}" },
    ]);
    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(2);
  });

  it("drops several poison messages and reports the count", () => {
    const result = sanitiseMessages([
      { role: "assistant", content: "" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null },
      { role: "assistant", content: "I answered." },
      { role: "assistant", content: "" },
    ]);
    expect(result.dropped).toBe(3);
    expect(result.messages.map((m: { role: string; content: string }) => m.content)).toEqual([
      "hi",
      "I answered.",
    ]);
  });

  it("keeps multimodal (array) content parts", () => {
    const vision = { role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] };
    const result = sanitiseMessages([vision]);
    expect(result.dropped).toBe(0);
    expect(result.messages).toEqual([vision]);
  });
});
