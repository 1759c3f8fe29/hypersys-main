// search_images: the executor's job is to never let a failed search become a
// fabricated picture, and to hand the gallery real rows.
//
// The three outcomes the model has to tell apart, same as web_search:
//
//   * service down / not configured → say the search failed, DO NOT generate one
//   * provider answered, nothing usable → offer another query
//   * images found → they are shown; speak about titles, not pixels
//
// The security-adjacent assertion (an unsafe URL never reaching the gallery) is
// also here at the executor boundary, because this is the seam between the
// provider payload and what the UI stores on the message.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolResult } from "@/lib/tools/types";

const imageSearchStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/search", async () => {
  // Keep the real sanitizer: the executor's safety claim is that it runs on the
  // provider's rows, so stubbing it would test nothing.
  const actual = await vi.importActual<typeof import("@/lib/search")>("@/lib/search");
  return { imageSearch: imageSearchStub, sanitizeImages: actual.sanitizeImages };
});

const { executeSearchImages, explainImageSearchError } = await import("@/lib/tools/search-images");

function ctxWith(): ToolContext {
  return { artifacts: {}, modelId: "mistral-large" };
}

beforeEach(() => imageSearchStub.mockReset());

const img = (over: Record<string, unknown> = {}) => ({
  title: "T",
  imageUrl: "https://x/f.png",
  thumbnailUrl: "https://x/t.png",
  pageUrl: "https://x/p",
  source: "x.com",
  ...over,
});

describe("executeSearchImages — argument handling", () => {
  it("rejects a missing query without calling the service", async () => {
    const out = await executeSearchImages({}, ctxWith());
    expect(out.ok).toBe(false);
    expect((out as unknown as { error: string }).error).toMatch(/query/);
    expect(imageSearchStub).not.toHaveBeenCalled();
  });
});

describe("executeSearchImages — refusal never becomes generation", () => {
  it("on a transport failure, tells the model not to generate an image", async () => {
    imageSearchStub.mockResolvedValue(null);
    const out = await executeSearchImages({ query: "cats" }, ctxWith());
    expect(out.ok).toBe(false);
    expect((out as unknown as { error: string }).error).toMatch(/do NOT generate/i);
  });

  it("with no provider configured, reports it and refuses substitution", async () => {
    imageSearchStub.mockResolvedValue({ query: "cats", images: [], error: "image_search_requires_serpapi_key" });
    const ctx = ctxWith();
    const out = await executeSearchImages({ query: "cats" }, ctx);
    expect(out.ok).toBe(false);
    expect((out as unknown as { error: string }).error).toMatch(/not configured/i);
    expect((out as unknown as { error: string }).error).toMatch(/do NOT substitute a generated image/i);
    // Nothing was pushed to the gallery, so the UI cannot show a fake tile.
    expect(ctx.artifacts.imageResults).toBeUndefined();
  });
});

describe("executeSearchImages — success", () => {
  it("pushes real images to the gallery and reports titles, not pixel data", async () => {
    imageSearchStub.mockResolvedValue({ query: "cats", images: [img(), img({ imageUrl: "https://x/f2.png", thumbnailUrl: "https://x/t2.png", title: "T2" })] });
    const ctx = ctxWith();
    const out = await executeSearchImages({ query: "cats" }, ctx);
    expect(out.ok).toBe(true);
    expect((out as unknown as { count: number }).count).toBe(2);
    expect(ctx.artifacts.imageResults).toHaveLength(2);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("https://x/f.png"); // no image bytes/urls leak to the model
    expect(serialized).toContain("T2");
  });

  it("appends across two searches rather than replacing the first gallery", async () => {
    const ctx = ctxWith();
    imageSearchStub.mockResolvedValue({ query: "a", images: [img()] });
    await executeSearchImages({ query: "a" }, ctx);
    imageSearchStub.mockResolvedValue({ query: "b", images: [img({ imageUrl: "https://x/f2.png", thumbnailUrl: "https://x/t2.png" })] });
    await executeSearchImages({ query: "b" }, ctx);
    expect(ctx.artifacts.imageResults).toHaveLength(2);
  });

  it("drops a row with an unsafe URL before it reaches the gallery", async () => {
    imageSearchStub.mockResolvedValue({
      query: "x",
      images: [img({ thumbnailUrl: "javascript:alert(1)", imageUrl: "data:x" }), img({ thumbnailUrl: "https://safe/t.png" })],
    });
    const ctx = ctxWith();
    const out = await executeSearchImages({ query: "x" }, ctx);
    expect(out.ok).toBe(true);
    expect(ctx.artifacts.imageResults).toHaveLength(1);
    expect(JSON.stringify(ctx.artifacts.imageResults)).not.toMatch(/javascript:|data:/);
  });
});

describe("explainImageSearchError", () => {
  it("decodes known reasons and passes unknown ones through for HTTP codes", () => {
    expect(explainImageSearchError("image_search_requires_serpapi_key")).toMatch(/not configured/);
    expect(explainImageSearchError("serpapi_images_http_429")).toMatch(/429/);
    expect(explainImageSearchError("weird_new_reason")).toBe("weird_new_reason");
  });
});
