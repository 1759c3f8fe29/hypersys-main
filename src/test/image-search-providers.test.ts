// Image search at the provider layer, asserted against a saved SerpApi response.
//
// WHY THIS FILE EXISTS
//
// The app could retrieve web pages but never pictures: `web_search` returns text
// rows and the only image path in the repo was `generate_image`, which *makes* an
// image rather than finding one. The spec's headline feature is that "search images
// of X" must return REAL retrieved images, and that generated pictures must never be
// substituted for search results.
//
// The load-bearing claim of that feature is exactly the one this file pins: every
// row handed to the UI carries provider-returned URLs, and a row with no real image
// is dropped rather than shown as a broken tile or backfilled with something else.
// Two mutants must fail here:
//
//   - dropping the http(s) allowlist turns `javascript:`/`data:` URLs into live
//     `src`/`href` values in the gallery (the security half, spec §10);
//   - dropping the "no thumbnail" drop leaves placeholder rows the UI cannot render.
//
// No network: the fixture is a trimmed recording of SerpApi's `google_images`
// response shape (`images_results`).

import { describe, it, expect, vi, afterEach } from "vitest";

import * as providers from "../../api/_search-providers.js";

const { searchSerpApiImages, runImageSearch, condenseImages } = providers as {
  searchSerpApiImages: (
    q: string,
    num?: number,
    key?: string,
  ) => Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; reason: string }>;
  runImageSearch: (
    q: string,
    num: number,
    env: Record<string, string | undefined>,
    log?: (m: string) => void,
  ) => Promise<Record<string, unknown>>;
  condenseImages: (rows: unknown[], limit?: number) => Array<Record<string, unknown>>;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(routes: Array<[RegExp, () => Response]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      for (const [pattern, respond] of routes) if (pattern.test(url)) return respond();
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Trimmed from SerpApi google_images. Note each row's `thumbnail` and `original`
// are distinct provider URLs, and the row carries source-page `link` + dimensions.
const IMAGES_OK = {
  images_results: [
    {
      position: 1,
      thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=tbn:AAA",
      source: "lenovo.com",
      title: "Lenovo G500 15.6-inch Laptop",
      link: "https://www.lenovo.com/us/en/p/laptops/lenovo/g-series/g500/",
      original: "https://www.lenovo.com/medias/g500-front.jpg",
      original_width: 1200,
      original_height: 800,
    },
    {
      position: 2,
      thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=tbn:BBB",
      source: "amazon.com",
      title: "Lenovo G500 review",
      link: "https://www.amazon.com/dp/B00EXAMPLE",
      original: "https://m.media-amazon.com/images/I/71example.jpg",
      original_width: 500,
      original_height: 500,
    },
    // Exact duplicate of row 1's image — must collapse.
    {
      position: 3,
      thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=tbn=AAA-colour-variant",
      title: "Lenovo G500 (mirror)",
      link: "https://mirror.example.com/g500",
      original: "https://www.lenovo.com/medias/g500-front.jpg",
    },
    // No thumbnail at all: unrenderable, must be dropped.
    {
      position: 4,
      title: "Lenovo G500 orphan",
      link: "https://example.com/orphan",
      original: "https://example.com/orphan.jpg",
    },
  ],
};

describe("SerpApi image search", () => {
  it("maps images_results to real provider URLs, title, source and dimensions", async () => {
    const calls = stubFetch([[/serpapi\.com/, () => json(IMAGES_OK)]]);
    const out = await searchSerpApiImages("Lenovo G500", 12, "k");
    expect(out.ok).toBe(true);
    const images = (out as unknown as { payload: { images: Array<Record<string, unknown>> } }).payload.images;
    expect(images).toHaveLength(2); // duplicate collapsed, orphan dropped
    expect(images[0]).toMatchObject({
      title: "Lenovo G500 15.6-inch Laptop",
      thumbnailUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:AAA",
      imageUrl: "https://www.lenovo.com/medias/g500-front.jpg",
      pageUrl: "https://www.lenovo.com/us/en/p/laptops/lenovo/g-series/g500/",
      source: "lenovo.com",
      width: 1200,
      height: 800,
    });
    // The image engine was actually requested — a `google` request would return no
    // images_results at all, so this is the difference between the feature working
    // and silently returning nothing.
    expect(calls.some((u) => /engine=google_images/.test(u))).toBe(true);
  });

  it("every returned URL is http(s) — a javascript: or data: row is dropped", async () => {
    const attacker = {
      images_results: [
        {
          position: 1,
          thumbnail: "javascript:alert(1)",
          title: "x",
          link: "https://ok.example.com",
          original: "data:text/html;base64,PHNjcmlwdD4=",
        },
        {
          position: 2,
          thumbnail: "https://safe.example.com/thumb.png",
          title: "safe",
          link: "https://safe.example.com/page",
          original: "https://safe.example.com/full.png",
        },
      ],
    };
    stubFetch([[/serpapi\.com/, () => json(attacker)]]);
    const out = await searchSerpApiImages("q", 12, "k");
    const images = (out as unknown as { payload: { images: Array<Record<string, string>> } }).payload.images;
    expect(images).toHaveLength(1);
    expect(images[0].thumbnailUrl).toBe("https://safe.example.com/thumb.png");
    // The dangerous row's URLs never survive into the payload at all.
    expect(JSON.stringify(images)).not.toMatch(/javascript:|data:/);
  });

  it("reports SerpApi's HTTP failure instead of an empty success", async () => {
    stubFetch([[/serpapi\.com/, () => json({}, 429)]]);
    const out = await searchSerpApiImages("q", 12, "k");
    expect(out.ok).toBe(false);
    expect((out as unknown as { reason: string }).reason).toBe("serpapi_images_http_429");
  });
});

describe("runImageSearch", () => {
  it("returns a configuration error and calls nothing when there is no key", async () => {
    const calls = stubFetch([[/serpapi\.com/, () => json(IMAGES_OK)]]);
    const logs: string[] = [];
    const out = await runImageSearch("cats", 12, {}, (m) => logs.push(m));
    // Not a fake success: no images, and an error the UI can render as a capability
    // message (spec Test H). And crucially no request was made.
    expect(out.images).toEqual([]);
    expect(out.error).toBe("image_search_requires_serpapi_key");
    expect(calls).toEqual([]);
    expect(logs.join(" ")).toMatch(/SERPAPI_API_KEY/);
  });

  it("returns the provider's images on success", async () => {
    stubFetch([[/serpapi\.com/, () => json(IMAGES_OK)]]);
    const out = await runImageSearch("Lenovo G500", 12, { SERPAPI_API_KEY: "k" });
    expect((out.images as unknown[]).length).toBe(2);
    expect(out.error).toBeUndefined();
  });

  it("surfaces the provider reason when the key is present but the call fails", async () => {
    stubFetch([[/serpapi\.com/, () => json({ error: "quota" })]]);
    const out = await runImageSearch("cats", 12, { SERPAPI_API_KEY: "k" });
    expect(out.images).toEqual([]);
    expect(out.error).toBe("serpapi_images_error");
  });
});

describe("condenseImages", () => {
  it("drops rows with no thumbnail and caps the list", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      title: `t${i}`,
      thumbnailUrl: `https://x/${i}.png`,
      imageUrl: `https://x/${i}-full.png`,
    }));
    rows.splice(3, 0, { title: "no thumb", thumbnailUrl: "", imageUrl: "https://x/full.png" });
    const out = condenseImages(rows, 12);
    expect(out).toHaveLength(12);
    expect(out.every((r) => (r as { thumbnailUrl: string }).thumbnailUrl)).toBe(true);
  });
});
