// The retrieved-image gallery has to survive a reload — and a stored row is
// untrusted input.
//
// WHY THIS FILE EXISTS
//
// The gallery is the one part of the reply that renders strings from an external
// source straight into `<img src>` and an `<a href>`. Nothing else on a message
// does that: text is markdown with raw HTML inert, attachments come from the local
// picker, and a generated image is a URL this app produced. So the persisted image
// row is the interesting boundary in both directions:
//
//   write — a turn that found pictures must store them, or the reload shows a reply
//           that talks about images with no images in it (spec §8: a later turn
//           saying "explain the third image" needs the third image to still be
//           there);
//   read  — a document written by an older client, or edited by hand, must not be
//           able to put a `javascript:` URL into either surface. React 18 warns
//           about that href and renders it anyway.
//
// The read side is deliberately NOT a private copy of the sanitizer: it calls the
// transport layer's own `sanitizeImages`, so these tests exercise the same rule the
// live capture path uses. A mutant that drops that call (trusting the document)
// must fail here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getDocs, addDoc } = vi.hoisted(() => ({
  getDocs: vi.fn(),
  // Declared as variadic so `mock.calls[0][1]` is the document the route wrote rather
  // than a tuple TS believes is empty — the assertion below reads that argument.
  addDoc: vi.fn(async (..._args: unknown[]) => ({ id: "doc-1" })),
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  addDoc,
  getDoc: vi.fn(),
  getDocs,
  query: vi.fn(() => ({})),
  where: vi.fn(() => ({})),
  orderBy: vi.fn(() => ({})),
  updateDoc: vi.fn(async () => undefined),
  deleteDoc: vi.fn(async () => undefined),
  serverTimestamp: vi.fn(() => ({ __sentinel: "ts" })),
  writeBatch: vi.fn(),
  setDoc: vi.fn(async () => undefined),
}));

import { firestoreDb } from "@/lib/firestore-db";
import { toTreeMessages, buildMessageForest, linearizeForest } from "@/lib/message-tree";

const STORED = [
  {
    title: "Lenovo G500 front",
    imageUrl: "https://www.lenovo.com/medias/g500-front.jpg",
    thumbnailUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:AAA",
    pageUrl: "https://www.lenovo.com/us/en/p/laptops/g-series/g500/",
    source: "lenovo.com",
  },
  {
    title: "Lenovo G500 review",
    imageUrl: "https://m.media-amazon.com/images/I/71example.jpg",
    thumbnailUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn=BBB",
    pageUrl: "https://www.amazon.com/dp/B00EXAMPLE",
    source: "amazon.com",
  },
];

function doc(id: string, data: Record<string, unknown>): { id: string; data: () => Record<string, unknown> } {
  return { id, data: () => ({ role: "assistant", content: "hi", ...data }) };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getDocs.mockReset();
  addDoc.mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

async function read(rows: Array<{ id: string; data: () => Record<string, unknown> }>) {
  getDocs.mockResolvedValueOnce({ docs: rows });
  return firestoreDb.getMessages("c1");
}

describe("the gallery survives a reload", () => {
  it("reads back the rows a search_images turn stored", async () => {
    const [msg] = await read([doc("m1", { imageResults: STORED })]);
    expect(msg.imageResults).toHaveLength(2);
    // The four fields the gallery needs, per row, in order. Asserted field-wise
    // rather than as whole objects: the validator also passes provider dimensions
    // through, and pinning the exact object shape here would make an added field a
    // test failure instead of a test the field flows through.
    expect(msg.imageResults![0]).toMatchObject(STORED[0]);
    expect(msg.imageResults![1]).toMatchObject(STORED[1]);
  });

  it("carries them through the tree so the rendered forest keeps them", async () => {
    const [stored] = await read([doc("m1", { imageResults: STORED })]);
    const flat = linearizeForest(buildMessageForest(toTreeMessages([stored as never])));
    expect(flat[0].imageResults).toHaveLength(2);
  });

  it("is undefined, not an empty gallery, when the turn found nothing", async () => {
    // undefined vs [] matters: an empty gallery would render as a bordered empty
    // grid, and the message's own render gates on `imageResults?.length`.
    const [msg] = await read([doc("m1", {})]);
    expect(msg.imageResults).toBeUndefined();
    const [nulled] = await read([doc("m1", { imageResults: null })]);
    expect(nulled.imageResults).toBeUndefined();
  });

  it("ignores a non-array (a hand-edited string) without failing the whole read", async () => {
    const [msg] = await read([doc("m1", { imageResults: "https://x/one.png" })]);
    expect(msg.imageResults).toBeUndefined();
    expect(msg.content).toBe("hi");
  });
});

describe("a stored row is untrusted input", () => {
  it("drops a row with a javascript: pageUrl rather than rendering a click-XSS link", async () => {
    const [msg] = await read([
      doc("m1", {
        imageResults: [
          { ...STORED[0], pageUrl: "javascript:alert(document.cookie)" },
          { ...STORED[1], pageUrl: "data:text/html,<script>alert(1)</script>" },
        ],
      }),
    ]);
    // The tiles stay — the pictures are real — but neither link can be followed
    // anywhere but the page it did not name.
    expect(msg.imageResults).toHaveLength(2);
    for (const r of msg.imageResults!) expect(r.pageUrl).toBe("");
    expect(JSON.stringify(msg.imageResults)).not.toMatch(/javascript:|data:/);
  });

  it("drops a row whose thumbnail is not http(s), and keeps the rest", async () => {
    const [msg] = await read([
      doc("m1", {
        imageResults: [
          { ...STORED[0], thumbnailUrl: "javascript:alert(1)", imageUrl: "javascript:alert(1)" },
          STORED[1],
        ],
      }),
    ]);
    expect(msg.imageResults).toHaveLength(1);
    expect(msg.imageResults![0].thumbnailUrl).toBe(STORED[1].thumbnailUrl);
  });

  it("falls back to the thumbnail when only the full-size image is unsafe", async () => {
    const [msg] = await read([doc("m1", { imageResults: [{ ...STORED[0], imageUrl: "data:image/png;base64,AAA" }] })]);
    expect(msg.imageResults).toHaveLength(1);
    expect(msg.imageResults![0].imageUrl).toBe(STORED[0].thumbnailUrl);
  });

  it("caps the stored list so a doctored document cannot render an unbounded grid", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...STORED[0],
      thumbnailUrl: `https://x/${i}.png`,
      imageUrl: `https://x/${i}-full.png`,
    }));
    const [msg] = await read([doc("m1", { imageResults: many })]);
    expect(msg.imageResults).toHaveLength(20);
  });
});

describe("the write channel", () => {
  it("stores the gallery on the message document", async () => {
    await firestoreDb.saveMessage("c1", "u1", "assistant", "here you go", "m", [], "p1", "m1", {
      imageResults: STORED,
    });
    const written = addDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(written.imageResults).toEqual(STORED);
  });

  it("writes null rather than leaving the field off a turn with no gallery", async () => {
    await firestoreDb.saveMessage("c1", "u1", "assistant", "hello", "m", [], "p1", "m1", {});
    const written = addDoc.mock.calls[0][1] as Record<string, unknown>;
    // Same shape for every message, so a reader never has to distinguish "absent"
    // from "empty" — the same discipline as reasoning/thinkSeconds/taskList.
    expect(written).toHaveProperty("imageResults");
    expect(written.imageResults).toBeNull();
  });
});
