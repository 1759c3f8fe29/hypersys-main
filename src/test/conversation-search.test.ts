// Conversation search (§8 Part F: "Search across message bodies, not just
// titles"), red-first.
//
// The contract under test: a conversation matches the history filter when its
// title matches OR its message bodies contain the needle. Message bodies are
// NOT in the conversation list payload — ChatSidebar fetches them lazily via
// firestoreDb.getMessages — so the matching logic lives in a pure module here,
// pinned without a DOM, a Firestore mock, or React.
//
// The fixtures mirror the real shapes: titles are model-generated summaries
// (arbitrary capitalisation), bodies are raw user/assistant text (any case),
// and the needle is whatever the user typed (may carry surrounding whitespace
// from a paste). Case-insensitivity in both directions is the contract the
// title filter already has; the body half must match it exactly or search
// would feel inconsistent between the two halves of the same field.

import { describe, it, expect } from "vitest";

import {
  countBodyHits,
  matchesConversation,
  matchesTitle,
  type SearchableMessage,
} from "@/lib/conversation-search";

const msg = (id: string, content: string): SearchableMessage => ({ id, content });

describe("matchesTitle", () => {
  it("matches case-insensitively and ignores surrounding whitespace in the needle", () => {
    expect(matchesTitle("Bridge inspection notes", "  BRIDGE ")).toBe(true);
  });

  it("does not match a title the needle is absent from", () => {
    // Control: this is the branch that must stay false — otherwise body search
    // never adds anything and the field silently regresses to title-only.
    expect(matchesTitle("Sourdough starter schedule", "bridge")).toBe(false);
  });

  it("treats an empty needle as a match, mirroring the empty-query shows-all rule", () => {
    expect(matchesTitle("Anything", "")).toBe(true);
    expect(matchesTitle("", "")).toBe(true);
  });
});

describe("countBodyHits", () => {
  const BODIES: SearchableMessage[] = [
    msg("m1", "Let's inspect the BRIDGE cables tomorrow."),
    msg("m2", "The bridge load report is attached."),
  ];

  it("counts every message whose body contains the needle, case-insensitively", () => {
    expect(countBodyHits(BODIES, "bridge")).toBe(2);
  });

  it("returns 0 when no body contains the needle", () => {
    expect(countBodyHits(BODIES, "sourdough")).toBe(0);
  });

  it("handles an empty body list without inventing a hit", () => {
    expect(countBodyHits([], "bridge")).toBe(0);
  });
});

describe("matchesConversation", () => {
  // The load-bearing case, and the whole point of §8 Part F: the title is a
  // short model-written summary, and the phrase the user remembers typing is
  // usually inside the conversation, not the summary. Before this change that
  // conversation was invisible to the filter.
  it("matches on the body alone when the title does not match", () => {
    expect(
      matchesConversation("Bridge inspection notes", 1, "cable tension"),
    ).toBe(true);
  });

  it("matches on the title alone when the body has no hits", () => {
    expect(matchesConversation("Sourdough starter schedule", 0, "sourdough")).toBe(true);
  });

  it("matches when both title and body match", () => {
    expect(matchesConversation("Bridge inspection notes", 3, "bridge")).toBe(true);
  });

  it("does not match when neither the title nor any body matches", () => {
    // Control for the OR: an AND-shaped matcher would fail this.
    expect(matchesConversation("Bridge inspection notes", 0, "sourdough")).toBe(false);
  });

  it("is case-insensitive through the title, mirroring the existing title filter", () => {
    expect(matchesConversation("Refactor the BRIDGE loader", 0, "bridge")).toBe(true);
    expect(matchesConversation("refactor the bridge loader", 0, "BRIDGE")).toBe(true);
  });

  it("treats an empty needle as a match so the unfiltered list stays whole", () => {
    // Empty query shows ALL conversations today (`: conversations`); the
    // module must agree or wiring it in would hide everything the moment the
    // field was cleared.
    expect(matchesConversation("Anything", 0, "")).toBe(true);
    expect(matchesConversation("", 0, "   ")).toBe(true);
  });
});
