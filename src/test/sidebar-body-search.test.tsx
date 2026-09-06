// Sidebar body search wiring (§8 Part F): typing in the history filter must
// match message *contents*, not just titles — the pure predicate is tested in
// conversation-search.test.ts; this file proves the sidebar actually calls
// the fetch, feeds it to the predicate, and repaints the list when bodies
// land. Written red-first: before the wiring, the row with a body-only match
// stayed hidden and both assertions below failed.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Same Firebase double as conversation-list-states.test.tsx — see that file
// for why initializing a real client in jsdom is wrong.
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { uid: "u1", email: "test@example.com", displayName: "Test" },
    signOut: vi.fn(),
    isGuest: false,
    loading: false,
  }),
}));

vi.mock("@/lib/firestore-db", () => ({
  firestoreDb: {
    getMemories: vi.fn(async () => []),
    getUserSettings: vi.fn(async () => null),
  },
}));

import ChatSidebar from "@/components/chat/ChatSidebar";

type Props = Parameters<typeof ChatSidebar>[0];

const nowIso = () => new Date().toISOString();

// One conversation whose TITLE does not contain the needle and whose BODY
// does — the case the title-only filter could never show, and the whole
// reason this feature exists. The second conversation matches on neither and
// must stay hidden; a single-conversation fixture could pass by accident
// (every row shown) and prove nothing.
const conversations = [
  {
    id: "c-body",
    title: "Bridge inspection notes",
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: "c-none",
    title: "Sourdough starter schedule",
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

const bodies: Record<string, { id: string; content: string }[]> = {
  "c-body": [
    { id: "m1", content: "We discussed the suspension cable tension figures at length." },
    { id: "m2", content: "Nothing relevant to the needle here." },
  ],
  "c-none": [{ id: "m3", content: "Feeding schedule at 8am and 8pm daily." }],
};

function props(overrides: Partial<Props> = {}): Props {
  return {
    conversations,
    activeConversationId: null,
    onSelectConversation: vi.fn(),
    onNewConversation: vi.fn(),
    onDeleteConversation: vi.fn(),
    isCollapsed: false,
    onToggleCollapse: vi.fn(),
    selectedModel: "nvidia/llama-3.3-nemotron-super-49b-v1",
    onSelectModel: vi.fn(),
    ...overrides,
  };
}

// The input is addressed by its data- attribute via querySelector — the same
// hook Chat.tsx's mod+K handler uses — because getByTestId matches the
// data-testid attribute only, and this field deliberately carries a different
// hook (see the comment on the input itself).
const searchInput = () =>
  document.querySelector("input[data-flyer-history-search]") as HTMLInputElement;

describe("sidebar body search wiring", () => {
  it("shows a body-only match after the fetch resolves, and not before", async () => {
    const fetchConversationBodies = vi.fn(
      async (id: string) => bodies[id] ?? [],
    );
    render(<ChatSidebar {...props({ fetchConversationBodies })} />);

    // Pre-query: both conversations visible.
    expect(screen.getByText("Bridge inspection notes")).toBeTruthy();
    expect(screen.getByText("Sourdough starter schedule")).toBeTruthy();

    // Type the needle: "suspension cable" is in c-body's messages and in
    // neither title. c-body's title pass fails, so immediately after the
    // keystroke the row must be gone — the bodies have not landed.
    fireEvent.change(searchInput(), {
      target: { value: "suspension cable" },
    });

    // Not-before: the body-only match is hidden until the fetch resolves.
    // waitFor's default timeout is generous; here we assert the transient
    // state synchronously — the fetch is a microtask away, but React batches
    // it, and the row only reappears when the cache write repaints.
    expect(screen.queryByText("Bridge inspection notes")).toBeNull();
    expect(screen.queryByText("Sourdough starter schedule")).toBeNull();

    // The fetch happened, for BOTH conversations (the uncached set), and
    // exactly once each — the cache means a second keystroke must not
    // re-fetch what is already in hand.
    await waitFor(() => {
      expect(fetchConversationBodies).toHaveBeenCalledTimes(2);
    });

    // After the bodies land: the body match is back, the non-match is not.
    await waitFor(() => {
      expect(screen.getByText("Bridge inspection notes")).toBeTruthy();
    });
    expect(screen.queryByText("Sourdough starter schedule")).toBeNull();

    // Cache check: editing the needle (still body-matching, different word)
    // does not hit the fetch again — the cached messages are re-counted, not
    // re-fetched.
    fireEvent.change(searchInput(), {
      target: { value: "tension figures" },
    });
    await waitFor(() => {
      expect(screen.getByText("Bridge inspection notes")).toBeTruthy();
    });
    expect(fetchConversationBodies).toHaveBeenCalledTimes(2);
  });

  it("falls back to title-only matching when no fetch is supplied", () => {
    // No fetchConversationBodies prop: the sidebar degrades to today's
    // behaviour rather than breaking — titles still filter.
    render(<ChatSidebar {...props()} />);
    fireEvent.change(searchInput(), {
      target: { value: "bridge" },
    });
    expect(screen.getByText("Bridge inspection notes")).toBeTruthy();
    expect(screen.queryByText("Sourdough starter schedule")).toBeNull();
  });
});
