// The guest half of bug 20, measured at last — and the fourth unnamed button.
//
// WHY THIS FILE EXISTS
//
// Bug 20 was Ctrl+B doing nothing for a signed-out user: `ChatSidebar` renders
// behind `isAuthenticated &&`, so the handler's `setSidebarCollapsed` flipped a
// boolean with no reader while the shortcut sheet two keystrokes away promised
// "Show or hide conversations". The fix routes the three shortcuts whose target can
// be absent through `CONDITIONAL_ACTIONS` → `UNAVAILABLE_REASONS` → `toast`.
//
// What was checked, and what was not. `shortcut-availability.test.ts` reads
// `Chat.tsx` as *text* and asserts every conditional action references its reason —
// indirection-proof, and it cannot see whether the branch is ever reached. The live
// CDP measurement pressed Ctrl+Shift+E and Ctrl+B in the running desktop app, but
// on a signed-**in** profile: it proved the mechanism on a sibling member of the
// class and proved nothing about the `isAuthenticated` branch, which is the actual
// reported bug. §14.2 #20 records that gap in those words. This file closes it by
// rendering the real page as a guest and pressing the key.
//
// It also asserts both directions, because a fix of this shape fails just as easily
// by speaking *too much*: an inverted condition gives every signed-in user a toast
// about a shortcut that works perfectly well, which is more annoying than the
// silence it replaced. So: guest gets the sentence and no sidebar; signed-in gets
// the sidebar moving and no toast.
//
// And the press found a fourth unlabelled icon-only button — the header's sidebar
// toggle. §19.1's sweep missed it twice over: it grepped for `<button`, and this is
// a `motion.button` that framer-motion renders as a real one. Re-swept across
// `<button`, `<motion.button` and `<Button` with attributes stripped before looking
// for a text child, which found this one and the memories panel's add button and
// nothing else.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

/** Flipped per test. `useAuth` reads it at render, so setting it before `render` is enough. */
const auth = vi.hoisted(() => ({
  state: { user: null as unknown, isGuest: true, loading: false },
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ ...auth.state, signOut: vi.fn() }),
}));

// `src/lib/firebase.ts` calls initializeApp/getAuth/getFirestore at module scope, so
// importing the real db in jsdom spins up a live client for a real project. Same
// reasoning as conversation-list-states.test.tsx.
vi.mock("@/lib/firestore-db", () => ({
  firestoreDb: {
    getConversations: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    getMemories: vi.fn(async () => []),
    getUserSettings: vi.fn(async () => null),
    createConversation: vi.fn(async () => "c1"),
    saveMessage: vi.fn(async () => "m1"),
    addMemory: vi.fn(async () => "mem1"),
    deleteConversation: vi.fn(async () => {}),
    updateConversationTitle: vi.fn(async () => {}),
    updateConversationModel: vi.fn(async () => {}),
  },
}));

// Nothing here sends a message; the mock is so that a stray call cannot reach a
// provider, and so the ~10 MB Pyodide download can never start.
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

import Chat from "@/pages/Chat";
import { UNAVAILABLE_REASONS } from "@/lib/shortcuts";
import { resetArtifacts } from "@/components/artifacts/ArtifactProvider";

const SIGNED_IN = { user: { uid: "u1", email: "a@b.c", displayName: "A" }, isGuest: false, loading: false };
const GUEST = { user: null, isGuest: true, loading: false };

const mount = () =>
  render(
    <MemoryRouter>
      <Chat />
    </MemoryRouter>,
  );

/** Ctrl+B, on `document` — `useKeyboardShortcuts` attaches one document listener. */
const pressCtrlB = () =>
  fireEvent.keyDown(document, { key: "b", code: "KeyB", ctrlKey: true });

beforeEach(() => {
  toast.mockReset();
  resetArtifacts();
  auth.state = { ...GUEST };
  // The collapsed state is remembered in localStorage, so without this the second
  // test inherits the first one's panel position.
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a guest presses the shortcut the help sheet advertises", () => {
  it("has no conversations sidebar to toggle", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());

    // The precondition the whole bug rests on, asserted rather than assumed: with
    // no sidebar there is no toggle, so a handler that only flips the boolean has
    // nothing to show for it.
    expect(screen.queryByRole("button", { name: /conversations/i })).not.toBeInTheDocument();
  });

  it("is told why, in the sentence a signed-out user needs", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());

    pressCtrlB();

    // The literal string, not `UNAVAILABLE_REASONS['toggle-sidebar']` — asserting
    // against the constant the code reads is a tautology that passes for any
    // sentence, including "no chats yet", which is the wrong fact: a guest's
    // history is not empty, it is not *kept*, and telling someone who has just had
    // a long conversation that they have no chats reads as data loss.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Sign in to keep a history of your chats.");
    // Belt and braces: the sentence the code ships is the sentence asserted above.
    expect(UNAVAILABLE_REASONS["toggle-sidebar"]).toBe("Sign in to keep a history of your chats.");
  });
});

describe("a signed-in user presses the same shortcut", () => {
  it("moves the sidebar and says nothing about it", async () => {
    auth.state = { ...SIGNED_IN };
    mount();
    // jsdom's viewport is 1024px, which is the `lg` breakpoint, so the remembered
    // default resolves to open.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Hide conversations" })).toBeInTheDocument(),
    );

    pressCtrlB();

    // The accessible name tracks the state, so this is the toggle observed from
    // outside rather than a boolean read back. The name flipping is also the whole
    // point of naming it: one control doing both jobs with a fixed label announces
    // the opposite of what the press will do.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show conversations" })).toBeInTheDocument(),
    );
    // The direction the text-scraping test cannot see. An inverted condition, or a
    // reason attached unconditionally, toasts here — at a user for whom the
    // shortcut works.
    expect(toast).not.toHaveBeenCalled();
  });
});
