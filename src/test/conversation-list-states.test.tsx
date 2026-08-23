// The sidebar's history list has four states, and three of them used to be one
// (§14 item #10).
//
// WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE
//
// Before this change, `conversations.length === 0` rendered "No conversations yet"
// — full stop. That single branch was doing the work of three different states:
//
//   in flight  → a returning user with fifty chats was told they had none, for as
//                long as the Firestore read took
//   failed     → an errored read was indistinguishable from a brand-new account
//   empty      → the only case where the sentence was actually true
//
// A false empty state is a specific and nasty kind of bug: nothing throws, nothing
// looks broken, and the app confidently states something untrue. It is also exactly
// the kind of thing a refactor silently reintroduces — collapse the ternary back to
// `length === 0` and every gate in this repo still passes. Hence behaviour tests.
//
// The fourth case is the one that is easy to get wrong in the other direction.
// loadConversations() re-runs after every turn to pick up the new title, so a slow
// or failing *refresh* must not replace a list the user is already reading with
// skeletons or with an error panel. Stale rows beat a spinner over content that is
// already on screen — that is what separates a refresh from a load.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ChatSidebar reaches Firebase two ways: useAuth directly, and MemoriesPanel via
// firestore-db. Both are mocked because src/lib/firebase.ts calls initializeApp,
// getAuth, getFirestore and getDatabase at module scope — importing it in jsdom
// spins up a real client for a real project, which a unit test has no business
// doing and which fails in CI with no network.
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

const EMPTY_TEXT = /No conversations yet/i;
const ERROR_TEXT = /Couldn't load your chats/i;
const SKELETONS = "conversation-skeletons";

type Props = Parameters<typeof ChatSidebar>[0];

const onRetryConversations = vi.fn();

function props(overrides: Partial<Props> = {}): Props {
  return {
    conversations: [],
    activeConversationId: null,
    onSelectConversation: vi.fn(),
    onNewConversation: vi.fn(),
    onDeleteConversation: vi.fn(),
    isCollapsed: false,
    onToggleCollapse: vi.fn(),
    selectedModel: "nvidia/llama-3.3-nemotron-super-49b-v1",
    onSelectModel: vi.fn(),
    onRetryConversations,
    ...overrides,
  };
}

// An ISO timestamp for "now", built without Date.now() so the suite does not drift
// against the date-fns grouping (isToday/isYesterday) that decides the row's
// heading. A fixed literal would land in "Older" once and pass anyway, but a row
// under the wrong heading is a different assertion failing for the right reason,
// and that is confusing to debug later.
const nowIso = () => new Date().toISOString();

const oneConversation = [
  { id: "c1", title: "Bridge inspection notes", created_at: nowIso(), updated_at: nowIso() },
];

const threeConversations = [
  { id: "c1", title: "Bridge inspection notes", created_at: nowIso(), updated_at: nowIso() },
  { id: "c2", title: "Sourdough starter schedule", created_at: nowIso(), updated_at: nowIso() },
  { id: "c3", title: "Refactor the BRIDGE loader", created_at: nowIso(), updated_at: nowIso() },
];

const SEARCH_LABEL = /search conversations/i;
const NO_MATCH_TEXT = /No chats match/i;

beforeEach(() => {
  onRetryConversations.mockReset();
});

describe("history list states", () => {
  it("does not claim the account is empty while the read is in flight", () => {
    render(<ChatSidebar {...props({ conversationsStatus: "loading" })} />);
    expect(screen.getByTestId(SKELETONS)).toBeTruthy();
    // The assertion that actually encodes the bug.
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it("does not claim the account is empty when the read failed", () => {
    render(<ChatSidebar {...props({ conversationsStatus: "error" })} />);
    expect(screen.getByText(ERROR_TEXT)).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.queryByTestId(SKELETONS)).toBeNull();
  });

  it("still shows the empty state when the list is genuinely empty", () => {
    render(<ChatSidebar {...props({ conversationsStatus: "ready" })} />);
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryByTestId(SKELETONS)).toBeNull();
    expect(screen.queryByText(ERROR_TEXT)).toBeNull();
  });

  // The default has to be 'ready', not 'loading'. A caller that forgets the prop
  // gets today's behaviour; the other default would render placeholder rows
  // forever, and the symptom (a permanently loading sidebar) would look like a
  // hung fetch rather than a missing prop.
  it("treats a missing status prop as ready rather than as loading", () => {
    const { conversationsStatus: _omitted, ...rest } = props();
    render(<ChatSidebar {...(rest as Props)} />);
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryByTestId(SKELETONS)).toBeNull();
  });

  it("offers a retry that calls back", () => {
    render(<ChatSidebar {...props({ conversationsStatus: "error" })} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetryConversations).toHaveBeenCalledTimes(1);
  });

  // Without onRetryConversations the panel must still render — a dead-end message
  // is worse than a live one, but it is far better than a false empty state, so the
  // prop is optional and the button is what disappears.
  it("renders the failure without a retry button when no handler is given", () => {
    const { onRetryConversations: _none, ...rest } = props({ conversationsStatus: "error" });
    render(<ChatSidebar {...(rest as Props)} />);
    expect(screen.getByText(ERROR_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});

describe("history list refreshes", () => {
  it("keeps existing rows visible while a refresh is in flight", () => {
    render(
      <ChatSidebar {...props({ conversationsStatus: "loading", conversations: oneConversation })} />,
    );
    expect(screen.getByText("Bridge inspection notes")).toBeTruthy();
    expect(screen.queryByTestId(SKELETONS)).toBeNull();
  });

  it("keeps existing rows visible when a refresh fails", () => {
    render(
      <ChatSidebar {...props({ conversationsStatus: "error", conversations: oneConversation })} />,
    );
    expect(screen.getByText("Bridge inspection notes")).toBeTruthy();
    // No error panel either: the list on screen is still valid data, and a failure
    // notice above it would be claiming the rows are suspect when they are not.
    expect(screen.queryByText(ERROR_TEXT)).toBeNull();
  });
});

// ---- filtering the history --------------------------------------------------
//
// The no-match state is the reason these are here. It is the same false-empty trap
// as #10 arriving by a different route: if a filtered-to-nothing list fell through
// to "No conversations yet", the app would tell a user with fifty chats that they
// have none at the exact moment they are typing to find one. That is a worse lie
// than the loading version, because the user's own keystrokes caused it and the
// obvious reading is "my history was just deleted".
describe("history filtering", () => {
  it("offers no search field when there is nothing to filter", () => {
    // A field above "No conversations yet" is furniture offering to search nothing.
    render(<ChatSidebar {...props()} />);
    expect(screen.queryByLabelText(SEARCH_LABEL)).toBeNull();
  });

  it("offers a search field once there is history", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    expect(screen.getByLabelText(SEARCH_LABEL)).toBeTruthy();
  });

  it("narrows the list to matching titles and hides the rest", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: "sourdough" } });
    expect(screen.getByText("Sourdough starter schedule")).toBeTruthy();
    expect(screen.queryByText("Bridge inspection notes")).toBeNull();
  });

  it("matches case-insensitively, in both directions", () => {
    // Titles are model-written, so their capitalisation is not something the user
    // is in a position to reproduce. Both rows match "bridge": one title is
    // lower-case there and the other is shouting.
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: "BRIDGE" } });
    expect(screen.getByText("Bridge inspection notes")).toBeTruthy();
    expect(screen.getByText("Refactor the BRIDGE loader")).toBeTruthy();
    expect(screen.queryByText("Sourdough starter schedule")).toBeNull();
  });

  it("ignores surrounding whitespace rather than matching nothing", () => {
    // Pasting a remembered phrase in brings a trailing space with it more often
    // than not, and "no results" for a query that visibly matches is the kind of
    // thing that gets filed as a broken search.
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: "  sourdough " } });
    expect(screen.getByText("Sourdough starter schedule")).toBeTruthy();
  });

  it("says nothing matched instead of claiming the account is empty", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: "zzzz" } });
    expect(screen.getByText(NO_MATCH_TEXT)).toBeTruthy();
    // The assertion that encodes the bug this branch exists to prevent.
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it("echoes the query back so it is obvious what matched nothing", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: "zzzz" } });
    expect(screen.getByText(/zzzz/)).toBeTruthy();
  });

  it("restores the full list when the search is cleared", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    const field = screen.getByLabelText(SEARCH_LABEL);
    fireEvent.change(field, { target: { value: "zzzz" } });
    fireEvent.click(screen.getByRole("button", { name: /clear search/i }));
    expect(screen.queryByText(NO_MATCH_TEXT)).toBeNull();
    expect(screen.getByText("Sourdough starter schedule")).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("clears the filter on Escape while the field has text", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    const field = screen.getByLabelText(SEARCH_LABEL);
    fireEvent.change(field, { target: { value: "zzzz" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Sourdough starter schedule")).toBeTruthy();
  });

  // The badge is small but it is a factual claim about the list below it, and a
  // count that keeps reading "3" beside one visible row is the kind of detail that
  // makes an interface feel careless.
  it("reports matches against the total while filtering", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    expect(screen.getByText("3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: "sourdough" } });
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  // Carries the shortcut contract: Chat.tsx's mod+K handler finds this field with
  // exactly this selector. Renaming the attribute breaks the accelerator silently,
  // because a querySelector that matches nothing throws nothing.
  it("exposes the data attribute the mod+K handler queries for", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    expect(document.querySelector("input[data-flyer-history-search]")).toBeTruthy();
  });
});

// ---- a closed drawer must not be tabbable -----------------------------------
//
// Collapsing the sidebar animates it to width 0 and translates it off the left
// edge under overflow-hidden. That is a purely visual hide: before this fix every
// control inside stayed in the tab order and stayed in the accessibility tree, so
// tabbing out of the chat header walked into sixteen invisible controls with the
// focus ring being painted 280px off-screen. `visibility: hidden` is what actually
// removes them — aria-hidden covers only the screen reader, and tabIndex does not
// cascade to children — which is why these assertions use toBeVisible() rather
// than querying for the node.
describe("collapsed sidebar", () => {
  it("hides its controls from focus and assistive tech when collapsed", () => {
    render(<ChatSidebar {...props({ isCollapsed: true, conversations: threeConversations })} />);
    // Two different claims, deliberately asserted two different ways.
    //
    // queryByRole ignores anything hidden from the accessibility tree, so a null
    // here *is* the screen-reader half of the fix: the drawer's controls are no
    // longer announced. (getByLabelText does not apply that filter, which is why
    // the field below is still findable.)
    expect(screen.queryByRole("button", { name: /new chat/i })).toBeNull();
    // And not visible, which is the half that governs the tab order — a
    // visibility: hidden element cannot be focused or tabbed to.
    expect(screen.getByLabelText(SEARCH_LABEL)).not.toBeVisible();
  });

  it("keeps them reachable when open", () => {
    render(<ChatSidebar {...props({ conversations: threeConversations })} />);
    expect(screen.getByRole("button", { name: /new chat/i })).toBeVisible();
    expect(screen.getByLabelText(SEARCH_LABEL)).toBeVisible();
  });

  // The assertion that encodes the ordering bug. The hide is cleared from an
  // effect, which runs *after* the commit that re-rendered with isCollapsed:
  // false — so a naive `offscreen && 'invisible'` leaves the panel opening and
  // still unfocusable for one commit, and mod+K expands the sidebar without
  // landing the cursor. Reading isCollapsed directly is what makes this
  // synchronous, and this test fails if that guard is dropped.
  it("becomes focusable in the same render that opens it", () => {
    const { rerender } = render(
      <ChatSidebar {...props({ isCollapsed: true, conversations: threeConversations })} />,
    );
    expect(screen.getByLabelText(SEARCH_LABEL)).not.toBeVisible();
    rerender(<ChatSidebar {...props({ isCollapsed: false, conversations: threeConversations })} />);
    expect(screen.getByLabelText(SEARCH_LABEL)).toBeVisible();
  });
});

// ---- walking the results from the search field -------------------------------
//
// These assert the *outcome* (which conversation gets opened) rather than which
// row carries the highlight class, for the same reason the collapsed-drawer tests
// use toBeVisible(): jsdom loads no stylesheet, so `ring-2` is an inert string
// here. It is also the better assertion — the ring is how the position is drawn,
// but the contract is which chat Enter opens.
//
// Focus stays in the field throughout by design (see the long note on the keydown
// handler): if ArrowDown moved real focus into the list, the next character typed
// would go to a row instead of refining the query.
describe("keyboard navigation of the history", () => {
  function renderWithSearch(overrides: Partial<Props> = {}) {
    const onSelectConversation = vi.fn();
    render(
      <ChatSidebar
        {...props({ conversations: threeConversations, onSelectConversation, ...overrides })}
      />,
    );
    return { field: screen.getByLabelText(SEARCH_LABEL), onSelectConversation };
  }

  it("opens the first match on Enter when nothing is highlighted yet", () => {
    // The fast path: type a couple of characters, press Enter, done.
    const { field, onSelectConversation } = renderWithSearch();
    fireEvent.change(field, { target: { value: "sourdough" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith("c2");
  });

  it("walks down the displayed order", () => {
    const { field, onSelectConversation } = renderWithSearch();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith("c2");
  });

  it("wraps to the top when it walks off the bottom", () => {
    const { field, onSelectConversation } = renderWithSearch();
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith("c1");
  });

  it("starts at the bottom when the first key is ArrowUp", () => {
    // The asymmetry is deliberate and is Spotlight's: "up from nowhere" has no
    // other sensible answer than the last row.
    const { field, onSelectConversation } = renderWithSearch();
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith("c3");
  });

  it("walks only the rows that survived the filter", () => {
    // The bug this prevents: walking `conversations` instead of the displayed,
    // grouped, filtered order. Both surviving rows are BRIDGE matches and the
    // second of them is c3 — index 1 of the *full* list is c2, which is filtered
    // out.
    const { field, onSelectConversation } = renderWithSearch();
    fireEvent.change(field, { target: { value: "bridge" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith("c3");
  });

  it("abandons the highlight when the query is edited", () => {
    // Otherwise the highlight sits on whatever row happens to land at that slot in
    // the new results — an arbitrary row the user never chose, one Enter away.
    const { field, onSelectConversation } = renderWithSearch();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.change(field, { target: { value: "bridge" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith("c1");
  });

  it("does nothing on Enter when nothing matched", () => {
    const { field, onSelectConversation } = renderWithSearch();
    fireEvent.change(field, { target: { value: "zzzz" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectConversation).not.toHaveBeenCalled();
  });

  // Carries the second selector contract in this file: the scroll-into-view effect
  // finds the highlighted row by this attribute, and — like the mod+K hook above —
  // a querySelector that matches nothing fails silently.
  it("labels rows with the attribute the scroll effect queries for", () => {
    renderWithSearch();
    expect(document.querySelectorAll("[data-flyer-conv-id]").length).toBe(3);
  });
});
