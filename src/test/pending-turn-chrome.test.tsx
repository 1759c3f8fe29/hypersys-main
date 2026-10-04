// The chrome of a turn that has produced nothing yet.
//
// THE BUG, AS REPORTED: "when user send any message it show the like unlike,
// copy or other btn then after sometime show the generating".
//
// Both halves of that are one ordering mistake. `handleSendMessage` renders the
// user message and an empty assistant placeholder immediately (the comment there
// calls it the INSTANT UI UPDATE), and only *after* two awaited Firestore
// round-trips — `createConversation` then `saveMessage` — does it call
// `setIsLoading(true)`. Everything the reply's chrome keys on is derived from that
// flag:
//
//   isStreaming   = isLoading && last message && assistant      -> false
//   canRegenerate = last message && assistant && !isLoading     -> TRUE
//
// So for as long as those two network writes take, the placeholder is an assistant
// message that is not streaming: the footer renders in full — Retry, Copy, thumbs
// up/down, read aloud — over an empty bubble, and the content area renders `null`
// because the "Generating response…" branch is gated on `isStreaming`. When the
// writes land, the flag flips, the actions vanish and the dots appear. The user
// reads that as the buttons coming first and the thinking state coming late,
// which is exactly what happens.
//
// Two defects, so two fixes, and they are independent on purpose:
//
//   1. The actions that act on *text* (Copy, rate, read aloud) must require a
//      reply to act on, not merely the absence of a streaming flag. That is the
//      durable guard: it holds no matter when any future flag arrives.
//   2. The turn must be in flight from the frame the placeholder appears. That is
//      what makes the thinking state immediate — and it closes a second hole in
//      the same window, since `handleSendMessage` returns early on `isLoading`,
//      so a second Enter during those writes started a second turn.
//
// Retry deliberately stays outside gate 1. It acts on the turn, not on the text,
// and a turn stopped before its first token is exactly when the user needs it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { toast } = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const auth = vi.hoisted(() => ({
  state: { user: { uid: "u1", email: "a@b.c", displayName: "A" } as unknown, isGuest: false, loading: false },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ ...auth.state, signOut: vi.fn() }) }));

// `saveMessage` is a hand-held deferred: the window between the placeholder and
// the in-flight flag is exactly as long as this promise stays pending, which is
// what makes the race deterministic instead of network-dependent.
const fs = vi.hoisted(() => {
  let release: (v: string) => void = () => {};
  const pending = new Promise<string>((res) => { release = res; });
  return { pending, release: () => release("m1"), saveCalls: { n: 0 } };
});
vi.mock("@/lib/firestore-db", () => ({
  firestoreDb: {
    getConversations: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    getMemories: vi.fn(async () => []),
    getUserSettings: vi.fn(async () => null),
    createConversation: vi.fn(async () => "c1"),
    saveMessage: vi.fn(() => { fs.saveCalls.n += 1; return fs.pending; }),
    addMemory: vi.fn(async () => "mem1"),
    deleteConversation: vi.fn(async () => {}),
    updateConversationTitle: vi.fn(async () => {}),
    updateConversationModel: vi.fn(async () => {}),
  },
}));

// No provider call may leave this file. The agent turn never settles, which is
// the steady state the assertions read: a turn genuinely in flight.
vi.mock("@/lib/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent")>()),
  runAgentTurn: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/lib/ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai")>();
  return {
    ...real,
    generateChatResponse: vi.fn(() => new Promise(() => {})),
    generateVisionResponse: vi.fn(() => new Promise(() => {})),
    generateSmartChatTitle: vi.fn(async () => null),
  };
});
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

// The composer, stubbed down to the two things this assertion needs: a way to
// send, and a readout of the in-flight flag the page hands it.
//
// The real ChatInput would work too, but reading the flag off its Send/Stop swap
// means reading it through framer-motion and a virtualised list in jsdom — a lot
// of machinery between the state under test and the assertion, any of which can
// fail for reasons that have nothing to do with the ordering bug. The stub makes
// the subject exactly the subject: what `isLoading` is while the write is pending.
vi.mock("@/components/chat/ChatInput", async () => {
  const { createElement: h } = await import("react");
  return {
    default: (props: { onSend: (t: string) => void; isLoading?: boolean }) =>
      h("div", null, [
        h("button", { key: "s", "aria-label": "stub send", onClick: () => props.onSend("hello") }),
        h("span", { key: "f", "data-testid": "in-flight" }, String(Boolean(props.isLoading))),
      ]),
  };
});

import Chat from "@/pages/Chat";
import ChatMessage from "@/components/chat/ChatMessage";
import { resetArtifacts } from "@/components/artifacts/ArtifactProvider";

/** Every control in the post-reply footer, by the name a user (or a reader) sees. */
const CONTENT_ACTIONS = [/^Copy$/i, /Rate this response as good/i, /Rate this response as bad/i, /Read aloud/i];

function mountReply(props: Partial<React.ComponentProps<typeof ChatMessage>> = {}) {
  return render(
    <ChatMessage
      role="assistant"
      content=""
      modelName="Flyer"
      onRate={vi.fn()}
      onRegenerate={vi.fn()}
      canRegenerate
      {...props}
    />,
  );
}

describe("an assistant turn with nothing in it yet", () => {
  afterEach(() => resetArtifacts());

  it("offers no Copy, no rating and no read-aloud — there is nothing to act on", () => {
    // The exact pre-flight state: the placeholder exists, the in-flight flag has
    // not arrived. Before the fix every one of these rendered.
    mountReply({ isStreaming: false });
    for (const name of CONTENT_ACTIONS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("still offers Retry, which acts on the turn rather than on the text", () => {
    // Control, and a deliberate hole in the gate above: a turn stopped before its
    // first token has nothing to copy and everything to re-roll. A blanket
    // has-a-body gate would have removed the one control that recovers it.
    mountReply({ isStreaming: false });
    expect(screen.getByRole("button", { name: /Retry/i })).toBeTruthy();
  });

  it("shows the thinking state, and no actions, while it streams", () => {
    mountReply({ isStreaming: true, statusText: "Understanding your request..." });
    expect(screen.getByRole("status").textContent).toContain("Understanding your request");
    for (const name of CONTENT_ACTIONS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("brings every action back once there is a reply", () => {
    // Control: the gate must key on the reply existing, not on some narrower
    // condition that quietly removes the footer from finished turns.
    mountReply({ isStreaming: false, content: "Here is the answer." });
    for (const name of CONTENT_ACTIONS) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("counts a generated image as a reply, so an image turn can still be rated", () => {
    // An image turn's text is often empty — the picture is the answer. Keying the
    // footer on text alone would strip rating and download-adjacent affordances
    // from every one of them.
    mountReply({
      isStreaming: false,
      content: "",
      imageUrl: "https://image.pollinations.ai/prompt/a%20car?nologo=true",
    });
    expect(screen.getByRole("button", { name: /Rate this response as good/i })).toBeTruthy();
  });
});

describe("the send that has not reached Firestore yet", () => {
  beforeEach(() => { fs.saveCalls.n = 0; });
  afterEach(() => { resetArtifacts(); fs.release(); });

  it("is already in flight before the first write resolves", async () => {
    // The parent half. While `saveMessage` is pending the page must already be in
    // flight: `isLoading` is what the reply's thinking state and its hidden footer
    // both hang from, and it is what makes `handleSendMessage`'s own
    // `if (… || isLoading) return;` guard real — before the fix a second Enter
    // inside this window started a second turn.
    render(
      <MemoryRouter>
        <Chat />
      </MemoryRouter>,
    );

    const send = await screen.findByRole("button", { name: /stub send/i });
    expect(screen.getByTestId("in-flight").textContent).toBe("false");

    await act(async () => {
      fireEvent.click(send);
    });

    // The write has been issued and is still pending — this is the window.
    await waitFor(() => expect(fs.saveCalls.n).toBe(1));
    expect(screen.getByTestId("in-flight").textContent).toBe("true");
  });
});
