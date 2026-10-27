// The turn's attribution, from the router's headers to the stored row.
//
// WHY THIS FILE EXISTS
//
// The other three files in this unit test each half in isolation:
// api-wire-headers.test.ts pins that the server sends the pair,
// served-attribution.test.ts that the client derives a name from it, and
// served-byline-chip.test.tsx that the chip renders when handed the props. None
// of them can see the middle: that Chat.tsx actually computes the attribution
// and puts it on the turn.
//
// That middle is exactly where a silent regression lands. Deleting the
// `...turnAttribution` spread from the two setMessages updates and the two
// saveMessage metas leaves every other test in the suite green — the helpers all
// still work, they are simply never called with anything. This file drives one
// real turn through the page and reads the row that came out the far side, so
// the wiring is the subject rather than an assumption.
//
// `runAgentTurn` is stubbed (it is the network). Everything between the stub and
// Firestore is real: the send path, the route headers' client-side derivation,
// and the meta the page hands saveMessage.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

// `user` is hoisted and shared by every call, which is load-bearing rather than
// tidiness. Chat.tsx holds `loadConversations` in a useCallback keyed on `user`
// and runs it from an effect keyed on that callback; a mock returning a fresh
// user object each render gives the callback a new identity on every render, so
// the effect re-runs, its `setConversationsStatus('loading')` re-renders, and the
// page loops until React trips "Maximum update depth exceeded". The real hook
// reads a stable object out of context, so the stable reference is also the
// faithful mock — the loop was the test's bug, not the app's.
const USER = vi.hoisted(() => ({ uid: "u1", email: "a@b.c", displayName: "A" }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: USER, isGuest: false, loading: false, signOut: vi.fn() }),
}));

/** Every saveMessage call, in order, as its argument list. */
const fs = vi.hoisted(() => ({ saves: [] as unknown[][] }));
vi.mock("@/lib/firestore-db", () => ({
  firestoreDb: {
    getConversations: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    getMemories: vi.fn(async () => []),
    getUserSettings: vi.fn(async () => null),
    createConversation: vi.fn(async () => "c1"),
    saveMessage: vi.fn(async (...args: unknown[]) => {
      fs.saves.push(args);
      return "m1";
    }),
    addMemory: vi.fn(async () => "mem1"),
    deleteConversation: vi.fn(async () => {}),
    updateConversationTitle: vi.fn(async () => {}),
    updateConversationModel: vi.fn(async () => {}),
  },
}));

/** What the routing layer would have reported for this turn. */
const agent = vi.hoisted(() => ({
  served: null as { provider: string; modelId: string } | null,
  calls: 0,
}));

// The real module is kept (AGENT_TOOLS_ENABLED decides whether this path runs at
// all, and a hand-written copy of that constant would make this test describe a
// build that does not exist); only the network call is replaced.
vi.mock("@/lib/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent")>()),
  runAgentTurn: vi.fn(async (opts: { onChunk?: (d: string) => void }) => {
    agent.calls += 1;
    opts.onChunk?.("The answer.");
    return { artifacts: {}, steps: 0, hitStepLimit: false, served: agent.served };
  }),
}));

vi.mock("@/lib/ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai")>();
  return {
    ...real,
    generateSmartChatTitle: vi.fn(async () => null),
    generateChatResponse: vi.fn(async () => ({ text: "", finishReason: "stop" })),
    generateVisionResponse: vi.fn(async () => ({ text: "", finishReason: "stop" })),
  };
});

vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

/** How many times the composer stub handed the page something to send. */
const stub = vi.hoisted(() => ({ sends: 0 }));

vi.mock("@/components/chat/ChatInput", async () => {
  const { createElement: h } = await import("react");
  return {
    default: (props: { onSend: (t: string) => void }) =>
      h("button", {
        "aria-label": "stub send",
        // Recorded before the call, so a click that throws still counts as a
        // click — the counter is there to say whether the page was asked to
        // send at all, not whether the send survived.
        onClick: () => {
          stub.sends += 1;
          props.onSend("hello");
        },
      }),
  };
});

import Chat from "@/pages/Chat";
import { resetArtifacts } from "@/components/artifacts/ArtifactProvider";

/**
 * The assistant rows written for the turn — the message the user sees on reload.
 *
 * The argument list read here is the FIRESTORE one, not the page's wrapper:
 * `firestoreDb.saveMessage(conversationId, userId, role, content, modelName,
 * attachments, parentMessageId, clientId, meta)`. Chat.tsx's own `saveMessage`
 * takes eight arguments and prepends the uid on its way through, so this mock —
 * which sits behind that wrapper — sees nine. Reading `a[1]` for the role (the
 * uid slot) is the mistake this comment exists to prevent, and it fails as "the
 * turn never happened" rather than as anything that mentions a signature.
 */
function assistantRows() {
  return fs.saves.filter((a) => a[2] === "assistant").map((a) => a[8] as Record<string, unknown> | undefined);
}

async function sendOneTurn() {
  render(
    <MemoryRouter>
      <Chat />
    </MemoryRouter>,
  );
  const send = await screen.findByRole("button", { name: /stub send/i });
  // Deliberately NOT `await act(async () => fireEvent.click(send))`. That form
  // waits for the entire promise chain the click starts, so a turn that stalls
  // on any await inside handleSendMessage hangs the test until the global
  // timeout instead of failing at the assertion that was watching for it.
  // Firing and then polling keeps the failure where it belongs.
  fireEvent.click(send);
  try {
    await waitFor(() => expect(assistantRows().length).toBeGreaterThan(0), { timeout: 8000 });
  } catch (e) {
    // A failure here must say what DID happen, because the middle of this
    // pipeline is the whole subject. "0 assistant rows" cannot distinguish a
    // turn that never started from one that died at the save from one whose row
    // this file read out of the wrong slot — and the last of those is a mistake
    // this file has already made once.
    throw new Error(
      `${(e as Error).message}\n` +
        `  every saveMessage call: ${JSON.stringify(fs.saves.map((a) => [a[2], String(a[3]).slice(0, 24)]))}\n` +
        `  runAgentTurn calls: ${agent.calls}, stub sends: ${stub.sends}\n` +
        `  toast.error: ${JSON.stringify(toast.error.mock.calls.map((c) => c[0]))}`,
    );
  }
}

beforeEach(() => {
  fs.saves.length = 0;
  agent.served = null;
  agent.calls = 0;
  stub.sends = 0;
});
afterEach(() => resetArtifacts());

describe("a turn the picked model answered", () => {
  it("stores no attribution at all", async () => {
    // The default's first leg. Nothing to explain, and — more importantly —
    // nothing to explain LATER: a stamp written here would be a stored claim that
    // the reply came from somewhere else, which survives reloads and is then
    // wrong for the life of the conversation.
    agent.served = { provider: "nvidia", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" };
    await sendOneTurn();

    for (const meta of assistantRows()) {
      expect(meta?.servedName).toBeUndefined();
      expect(meta?.servedBy).toBeUndefined();
      expect(meta?.toolsWithheld).toBeUndefined();
    }
  });

  it("stores nothing when the server reported no route at all", async () => {
    // An older deployment, or a proxy that dropped the headers. Silence must
    // stay silence rather than becoming a guess at which model answered.
    agent.served = null;
    await sendOneTurn();

    for (const meta of assistantRows()) {
      expect(meta?.servedName).toBeUndefined();
      expect(meta?.servedBy).toBeUndefined();
    }
  });
});

describe("a turn a backup answered", () => {
  it("stores the backup's own name, its provider, and the explanation", async () => {
    // The misattribution this whole unit exists to end: the row used to say
    // "Flyer" and nothing else, whatever wrote it.
    agent.served = { provider: "groq", modelId: "qwen/qwen3.8-27b" };
    await sendOneTurn();

    const rows = assistantRows();
    expect(rows.length, "the turn wrote no assistant row").toBeGreaterThan(0);
    const withAttribution = rows.filter((m) => m?.servedName);
    expect(withAttribution.length, "no assistant row carried an attribution").toBeGreaterThan(0);
    for (const meta of withAttribution) {
      expect(meta.servedBy).toBe("groq");
      expect(meta.servedName).toBe("Qwen 3.8 27B");
      // The provider's name, not the entry's: "Flyer" here would be the same lie
      // in a new field.
      expect(meta.servedName).not.toBe("Flyer");
      expect(String(meta.servedNote)).toContain("Qwen 3.8 27B");
    }
  });

  it("marks the capability the turn lost on the way", async () => {
    // Pollinations cannot accept tools (api/_providers.js drops them at the
    // payload gate), so this turn could not search, read a file or run code. The
    // flag is the only thing standing between that and a reply that reads as if
    // the model chose not to. It is derived, so it also proves the page passed
    // `toolsAdvertised: true` — the agent path is on for the default model.
    agent.served = { provider: "pollinations", modelId: "openai" };
    await sendOneTurn();

    const flagged = assistantRows().filter((m) => m?.toolsWithheld);
    expect(flagged.length, "toolsWithheld was never set on a tool-less route").toBeGreaterThan(0);
    expect(flagged[0].servedBy).toBe("pollinations");
  });

  it("does not flag a backup that could have taken tools", async () => {
    // Control for the assertion above: a different route, tools intact, so
    // toolsWithheld is false rather than merely attached to any failover.
    agent.served = { provider: "groq", modelId: "qwen/qwen3.8-27b" };
    await sendOneTurn();

    for (const meta of assistantRows()) {
      expect(meta?.toolsWithheld).toBeUndefined();
    }
  });
});
