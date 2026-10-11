// Client side of image search: the sanitizer that guards the DOM, and the
// transport's error contract.
//
// WHY THIS FILE EXISTS, SEPARATE FROM THE PROVIDER TEST
//
// `src/test/image-search-providers.test.ts` proves the *server* refuses a row whose
// URL is `javascript:`. That protects the payload. This file proves the *client*
// refuses one too — because the response crosses a network boundary the client did
// not author, and a `javascript:` thumbnail that reached `<img src>` or an anchor
// `href` executes. The two checks are the same rule at two trust levels, and the
// server one going missing must not be the only thing standing between a hostile
// provider row and the DOM.
//
// `buildImageContext` is here because it is the model's ONLY view of the images: it
// gets titles and sources, never pixel data, and must not be handed anything that
// invites it to invent visual detail.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai", () => ({
  apiPath: (p: string) => p,
  fetchAsUser: vi.fn(),
}));

import { fetchAsUser } from "@/lib/ai";
import { imageSearch, sanitizeImages, buildImageContext } from "@/lib/search";

const fetchMock = fetchAsUser as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock.mockReset();
});

const reply = (body: unknown, ok = true, status = 200) => ({
  response: { ok, status, json: async () => body },
  errText: ok ? "" : "err",
});

describe("sanitizeImages", () => {
  it("drops rows whose thumbnail is not http(s) and keeps the safe ones", () => {
    const out = sanitizeImages([
      { title: "evil", thumbnailUrl: "javascript:alert(1)", imageUrl: "data:x", pageUrl: "https://x" },
      { title: "safe", thumbnailUrl: "https://x/t.png", imageUrl: "https://x/f.png", pageUrl: "https://x/p" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("safe");
    expect(JSON.stringify(out)).not.toMatch(/javascript:|data:/);
  });

  it("falls back to the thumbnail when the full image URL is missing or unsafe", () => {
    const out = sanitizeImages([
      { title: "a", thumbnailUrl: "https://x/t.png" },
      { title: "b", thumbnailUrl: "https://x/t2.png", imageUrl: "javascript:alert(1)" },
    ]);
    expect(out[0].imageUrl).toBe("https://x/t.png");
    expect(out[1].imageUrl).toBe("https://x/t2.png");
  });

  it("drops a row with no usable thumbnail rather than showing a broken tile", () => {
    expect(sanitizeImages([{ title: "x", imageUrl: "https://x/f.png" }])).toHaveLength(0);
  });

  it("returns [] for a non-array payload (a failed proxy can answer {error} only)", () => {
    expect(sanitizeImages(undefined)).toEqual([]);
    expect(sanitizeImages({ error: "boom" })).toEqual([]);
  });
});

describe("imageSearch transport", () => {
  it("returns null on a non-ok response instead of a fabricated empty result", async () => {
    fetchMock.mockResolvedValue(reply({}, false, 500));
    expect(await imageSearch("cats")).toBeNull();
  });

  it("sanitizes the response and surfaces the provider error", async () => {
    fetchMock.mockResolvedValue(
      reply({
        query: "cats",
        images: [{ title: "k", thumbnailUrl: "https://x/t.png", imageUrl: "https://x/f.png" }],
        error: "serpapi_images_http_429",
      }),
    );
    const out = await imageSearch("cats");
    expect(out?.images).toHaveLength(1);
    expect(out?.error).toBe("serpapi_images_http_429");
  });

  it("requests the images mode from the proxy", async () => {
    fetchMock.mockResolvedValue(reply({ query: "q", images: [] }));
    await imageSearch("q");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.mode).toBe("images");
  });
});

describe("buildImageContext", () => {
  it("gives the model titles and sources but no pixel data, and forbids invention", () => {
    const ctx = buildImageContext({
      query: "cats",
      images: [
        { title: "Tabby", imageUrl: "https://x/f.png", thumbnailUrl: "https://x/t.png", pageUrl: "https://x/p", source: "wiki.org" },
      ],
    });
    expect(ctx).toContain("Tabby");
    expect(ctx).toContain("wiki.org");
    expect(ctx).toMatch(/never invent visual detail/i);
    expect(ctx).not.toContain("https://x/f.png");
  });

  it("is null when there are no images", () => {
    expect(buildImageContext({ query: "q", images: [] })).toBeNull();
    expect(buildImageContext(null)).toBeNull();
  });
});
