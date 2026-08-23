// Threading survives a reload (§16.8).
//
// WHY THIS FILE EXISTS
//
// `parentMessageId` is written by the client, which knows only its own ids — the
// UUIDs it minted when it put each message on screen. The document id came from
// `addDoc`, which generates its own. So every parent pointer read back from Firestore
// named an id that did not exist in the batch.
//
// Nothing crashed and nothing was lost, which is why it survived so long:
// `buildMessageForest` promotes an unresolvable parent to a root by design, and a
// forest of roots linearizes back into createdAt order. The history looked right.
// What was gone was the *tree* — three regenerations of one turn came back as three
// consecutive replies with no branch switcher, and the next branch created after that
// reload started its sibling numbering from zero, because `saveMessage` counts
// existing children by querying `parentMessageId` and the ids no longer matched.
//
// WHY IT NEEDS THIS SHAPE OF TEST
//
// No single-layer test could see it. `message-tree.test.ts` builds forests from
// hand-written ids that resolve by construction. `firestore-reads.test.ts` asserts on
// reads in isolation. The defect lived in the *seam*: a write in one id namespace and
// a read in another, correct on both sides of the boundary. So this file fakes enough
// of Firestore to run the whole cycle — save, read back, build the tree — because the
// round trip is the unit.
//
// The fake honours `where(...)` equality filters rather than returning everything,
// which matters: `saveMessage`'s sibling-index computation is a real query, and the
// numbering restart was half the bug. A fake that ignored the filter would report
// sibling indices that no deployment would produce.

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  docs: [] as Array<{ id: string; data: Record<string, unknown> }>,
  // Separate counters. One shared counter made the auto-id depend on how many
  // serverTimestamp() sentinels the write path happened to evaluate first, which is a
  // detail of the fake leaking into what the tests can assert.
  ids: 0,
  clock: 0,
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  doc: vi.fn(() => ({})),
  addDoc: vi.fn(async (coll: { name: string }, data: Record<string, unknown>) => {
    store.ids += 1;
    // Deliberately unlike any client id. This is the mismatch the bug was made of,
    // and a fake that echoed the client's id back would make every assertion below
    // pass for free.
    const id = `firestore-autoid-${store.ids}`;
    if (coll.name === "messages") store.docs.push({ id, data });
    return { id };
  }),
  getDoc: vi.fn(),
  getDocs: vi.fn(async (q: { coll: { name: string }; wheres: Array<{ f: string; v: unknown }> }) => {
    const rows = q.coll.name === "messages" ? store.docs : [];
    const matched = rows.filter((r) => q.wheres.every((w) => r.data[w.f] === w.v));
    return {
      size: matched.length,
      docs: matched.map((r) => ({ id: r.id, data: () => r.data })),
    };
  }),
  query: vi.fn((coll: unknown, ...wheres: unknown[]) => ({ coll, wheres })),
  where: vi.fn((f: string, _op: string, v: unknown) => ({ f, v })),
  orderBy: vi.fn(() => ({})),
  updateDoc: vi.fn(async () => undefined),
  deleteDoc: vi.fn(async () => undefined),
  // getMessages reads `data.createdAt?.toDate?.()`. Monotonic so the createdAt sort
  // reflects write order, which is what a real serverTimestamp would give here.
  serverTimestamp: vi.fn(() => {
    store.clock += 1;
    return { toDate: () => new Date(1_700_000_000_000 + store.clock * 1000) };
  }),
  writeBatch: vi.fn(),
  setDoc: vi.fn(async () => undefined),
}));

import { firestoreDb } from "@/lib/firestore-db";
import { buildMessageForest, linearizeForest, toTreeMessages } from "@/lib/message-tree";

const CONV = "conv-1";
const UID = "user-1";

/** Save as the app does: the on-screen id goes out as `clientId`. */
function save(role: "user" | "assistant", content: string, clientId: string, parentMessageId: string | null) {
  return firestoreDb.saveMessage(CONV, UID, role, content, undefined, [], parentMessageId, clientId);
}

/**
 * Everything a reload does with what came back.
 *
 * `toTreeMessages` is the *same* function Chat.tsx's load path calls, not a copy of it.
 * That matters here specifically: the `createdAt` defect below was an omission in that
 * mapping, and a test with its own hand-written mapping would have been written
 * correctly and stayed green while the app's copy stayed wrong. Which is what happened.
 */
async function reload() {
  const flat = await firestoreDb.getMessages(CONV);
  const forest = buildMessageForest(toTreeMessages(flat));
  return { flat, forest, linear: linearizeForest(forest) };
}

beforeEach(() => {
  store.docs = [];
  store.ids = 0;
  store.clock = 0;
});

describe("a message keeps its identity across a reload", () => {
  it("reads back under the id the client wrote, not the Firestore auto-id", async () => {
    const docId = await save("user", "hello", "client-uuid-1", null);
    const { flat } = await reload();

    // Asserted explicitly, because it is what makes the rest of this file meaningful:
    // the two namespaces really are different. If the fake ever started echoing the
    // client id back as the document id, every test here would pass without measuring
    // anything — the §14.3 failure mode. Stated as an invariant rather than as a
    // literal id, which would couple the assertion to the fake's counter.
    expect(docId).toMatch(/^firestore-autoid-/);
    expect(flat[0].id).toBe("client-uuid-1");
    expect(flat[0].id).not.toBe(docId);
  });

  it("falls back to the document id for messages written before clientId existed", async () => {
    // Every message already in production. `saveMessage` is bypassed here on purpose:
    // the point is a stored document with no clientId field at all, which is not
    // something the current write path can produce.
    store.docs.push({
      id: "legacy-doc-id",
      data: {
        conversationId: CONV,
        role: "assistant",
        content: "from before",
        parentMessageId: null,
        siblingIndex: 0,
        createdAt: { toDate: () => new Date(1_600_000_000_000) },
      },
    });

    const { flat, linear } = await reload();

    expect(flat[0].id).toBe("legacy-doc-id");
    // And it still renders. Legacy history is all-roots, which linearizes back to the
    // original flat order — the behaviour buildMessageForest documents.
    expect(linear).toHaveLength(1);
  });
});

describe("a branched turn reloads as a branch", () => {
  it("rebuilds the parent/child edges", async () => {
    await save("user", "question", "c-u1", null);
    await save("assistant", "first answer", "c-a1", "c-u1");

    const { forest } = await reload();

    expect(forest).toHaveLength(1);
    expect(forest[0].id).toBe("c-u1");
    expect(forest[0].children.map((c) => c.id)).toEqual(["c-a1"]);
  });

  it("shows one regeneration with a switcher, not three replies in a row", async () => {
    await save("user", "question", "c-u1", null);
    await save("assistant", "first", "c-a1", "c-u1");
    await save("assistant", "second", "c-a2", "c-u1");
    await save("assistant", "third", "c-a3", "c-u1");

    const { forest, linear } = await reload();

    // One root, three siblings under it. Before the fix this was four roots.
    expect(forest).toHaveLength(1);
    expect(forest[0].children).toHaveLength(3);

    // The rendered thread: the question and the newest sibling. "Latest regenerate
    // wins" is what buildMessageForest defaults activeChildIndex to, and it is what a
    // user expects on reopening a branched conversation.
    expect(linear.map((m) => m.id)).toEqual(["c-u1", "c-a3"]);
    expect(linear[1].__branchIndex).toBe(3);
    expect(linear[1].__branchCount).toBe(3);
  });

  it("numbers siblings from the count already stored, not from zero", async () => {
    await save("user", "question", "c-u1", null);
    await save("assistant", "first", "c-a1", "c-u1");
    await save("assistant", "second", "c-a2", "c-u1");

    // The compounding half of the bug, and the reason the sibling query is really run
    // by the fake. `saveMessage` counts existing children by querying
    // `where('parentMessageId','==',...)`. When the parent id written after a reload
    // no longer matched the one written before it, that count came back 0 and every
    // post-reload branch was sibling 0 — so a conversation could hold several
    // "first" siblings and their order was undefined.
    const { flat: afterReload } = await reload();
    const parentId = afterReload.find((m) => m.role === "user")!.id;
    await save("assistant", "third, after a reload", "c-a3", parentId);

    const { forest } = await reload();
    const indices = forest[0].children.map((c) => c.siblingIndex);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("orders siblings by createdAt when their indices collide", async () => {
    // Colliding indices are reachable in production: `saveMessage` computes
    // siblingIndex with a read-then-write that its own comment calls deliberately
    // non-transactional, so two branches created close together can share one.
    //
    // Fed to `toTreeMessages` directly, deliberately OUT of createdAt order, rather
    // than through `reload()`. That is not a shortcut — it is the only shape that can
    // fail. `getMessages` sorts its rows by createdAt before returning them and
    // `Array.prototype.sort` is stable, so via the read path the input is already
    // correctly ordered and the tiebreak has nothing left to decide: the first draft of
    // this test passed identically with `createdAt` removed from the mapping, which
    // means it was measuring nothing (§14.3). Unsorted input is legitimate — nothing in
    // `buildMessageForest`'s contract requires sorted input, and the tiebreak exists
    // precisely for callers that do not pre-sort.
    const rows = [
      { id: "c-u1", role: "user" as const, content: "question", parentMessageId: null, siblingIndex: 0, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c-late", role: "assistant" as const, content: "late", parentMessageId: "c-u1", siblingIndex: 0, createdAt: "2026-01-01T00:00:03.000Z" },
      { id: "c-early", role: "assistant" as const, content: "early", parentMessageId: "c-u1", siblingIndex: 0, createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "c-mid", role: "assistant" as const, content: "mid", parentMessageId: "c-u1", siblingIndex: 0, createdAt: "2026-01-01T00:00:02.000Z" },
    ];

    const forest = buildMessageForest(toTreeMessages(rows));

    // Needs `createdAt` to survive `toTreeMessages`. Without it `nodeTime()` returns 0
    // for every node, the `||` second term can never decide anything, and these come
    // back in the order they were passed: late, early, mid.
    expect(forest[0].children.map((c) => c.id)).toEqual(["c-early", "c-mid", "c-late"]);
  });
});
