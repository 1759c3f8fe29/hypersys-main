// The two Firestore reads that must NOT swallow their failures — and the ones
// that still should.
//
// WHY THIS FILE EXISTS
//
// §14.2 bugs 6 and 7 were both "a failed read renders as a reassuring empty
// state". The fixes went into Chat.tsx: a try/catch that sets
// conversationsStatus('error') so the sidebar can show a failure panel and Retry,
// and setMessagesError(true) plus `disabled` on the composer so a thread whose
// history failed to load cannot be sent from.
//
// Neither fix could ever run. `firestoreDb.getConversations` and `getMessages`
// each ended in `catch { return [] }`, so a rejected read arrived at the caller
// as a *successful empty one*. The catch blocks in Chat.tsx were unreachable,
// conversation-list-states.test.tsx passed because it drives `conversationsStatus`
// as a prop directly, and the dangerous half of bug 7 — sending a mid-thread
// follow-up to the model with no prior turns, then persisting the reply into the
// middle of a thread it never saw — was still live in production with the fix
// shipped, tested, and inert.
//
// That is a worse position than not having fixed it, because the tests said it
// was handled. Hence these tests, which pin the layer the other file cannot see:
// the read *rejects*, and an empty result still means empty.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted so the factory below can close over it — vi.mock is lifted above the
// imports, so a plain `const` declared here would not exist yet when it runs.
const { getDocs } = vi.hoisted(() => ({ getDocs: vi.fn() }));

// src/lib/firebase.ts calls initializeApp/getAuth/getFirestore/getDatabase at
// module scope, so importing it in jsdom spins up a real client for a real
// project. firestore-db.ts imports it as './firebase'; this alias resolves to the
// same file, and vitest keys mocks by resolved path.
vi.mock("@/lib/firebase", () => ({ db: {} }));

// Every value import in firestore-db.ts, stubbed. The query builders return a
// sentinel rather than undefined so that `query(collection(...), where(...))`
// composes without throwing before getDocs is reached.
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  addDoc: vi.fn(async () => ({ id: "new" })),
  getDoc: vi.fn(),
  getDocs,
  query: vi.fn(() => ({})),
  where: vi.fn(() => ({})),
  orderBy: vi.fn(() => ({})),
  updateDoc: vi.fn(async () => undefined),
  deleteDoc: vi.fn(async () => undefined),
  serverTimestamp: vi.fn(() => ({})),
  writeBatch: vi.fn(),
  setDoc: vi.fn(async () => undefined),
}));

import { firestoreDb } from "@/lib/firestore-db";

const BOOM = new Error("permission-denied");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getDocs.mockReset();
  // These paths log on the way out and the log is deliberate — silenced here so a
  // passing run does not look like a failing one.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("reads that drive primary UI must reject", () => {
  it("getConversations rejects rather than reporting an empty account", async () => {
    getDocs.mockRejectedValueOnce(BOOM);
    await expect(firestoreDb.getConversations("u1")).rejects.toThrow("permission-denied");
  });

  it("getMessages rejects rather than reporting an empty thread", async () => {
    // The dangerous one. An empty resolve here reaches the model as "no prior
    // turns" and the reply is persisted mid-thread.
    getDocs.mockRejectedValueOnce(BOOM);
    await expect(firestoreDb.getMessages("c1")).rejects.toThrow("permission-denied");
  });

  it("still logs the failure on the way out", async () => {
    // The rethrow replaced a `return []`, not the logging: the console line is the
    // only place the underlying Firestore error text survives, since the caller
    // turns it into a status flag.
    getDocs.mockRejectedValueOnce(BOOM);
    await expect(firestoreDb.getConversations("u1")).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("an empty result still means empty", () => {
  // Without these, "rejects on failure" could be satisfied by a function that
  // always rejects, and the genuine empty state — a new account, a new
  // conversation — is a real case the sidebar and the WelcomeScreen exist for.
  it("getConversations resolves to an empty list for a new account", async () => {
    getDocs.mockResolvedValueOnce({ docs: [] });
    await expect(firestoreDb.getConversations("u1")).resolves.toEqual([]);
  });

  it("getMessages resolves to an empty list for a fresh conversation", async () => {
    getDocs.mockResolvedValueOnce({ docs: [] });
    await expect(firestoreDb.getMessages("c1")).resolves.toEqual([]);
  });
});

describe("reads the app can do without stay lenient", () => {
  // The asymmetry is the design, not an oversight. A swallowed read is fine when
  // there is no UI state that "no data" could be confused with — nothing in the
  // app claims "you have no memories" as a fact the user would act on, and
  // settings have defaults. It is only wrong when a reassuring empty state exists
  // to be shown by mistake.
  it("getMemories degrades to an empty list", async () => {
    getDocs.mockRejectedValueOnce(BOOM);
    await expect(firestoreDb.getMemories("u1")).resolves.toEqual([]);
  });
});
