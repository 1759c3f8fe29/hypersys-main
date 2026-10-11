// Tavily, the provider that took the primary slot on 2026-10-11 — asserted against
// recorded responses.
//
// WHY A SEPARATE FILE
//
// search-providers.test.ts asserts the CHAIN: which provider answers, in what order, and
// what the response says when one of them fails. This file asserts the ADAPTER: the exact
// request body sent, the mapping from Tavily's fields onto ours, and the reason each
// failure shape produces. The split matters for the body in particular — Tavily rate-limits
// and bills per request, and this is the one place where a stray field is a real cost
// rather than a style question.
//
// The fixtures are recordings of api.tavily.com/search, taken 2026-10-11 via
// `node scripts/probe-search-backends.mjs "Lenovo G500 laptop"`, which prints both bodies.
// The absences are kept because they are what the live endpoint actually returned:
// `follow_up_questions` came back `null` rather than `[]`, no row carried
// `published_date`, `title`/`description` on image rows are frequently null, and `images`
// held exactly five entries for a `max_results: 12` request.
//
// Three things are pinned here that nothing else pins, and each is a one-character edit
// away from breaking:
//   • `include_images: false` on the text call (images are a second billed request),
//   • the keyless header, which is not "no auth" — omitting it answers 401,
//   • `pageUrl: ""` on image rows, where the tempting fallback (the first result's URL)
//     would be a fabricated attribution on a real picture.

import { describe, it, expect, vi, afterEach } from "vitest";

import * as providers from "../../api/_search-providers.js";

const { searchTavily, searchTavilyImages, hostOf } = providers as {
  searchTavily: (
    q: string,
    num: number,
    key: string,
  ) => Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; reason: string }>;
  searchTavilyImages: (
    q: string,
    num: number,
    key: string,
  ) => Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; reason: string }>;
  hostOf: (u: unknown) => string | null;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Record every request and answer with one fixed response. */
function stubTavily(respond: () => Response) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        headers: (init?.headers || {}) as Record<string, string>,
        body: JSON.parse(String(init?.body || "{}")),
      });
      return respond();
    }),
  );
  return sent;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Trimmed recording of a real text response (2026-10-11). */
const TEXT_OK = {
  query: "lenovo g500",
  answer: 'The Lenovo G500 is a 15.6" laptop with Intel Pentium or Celeron processors.',
  follow_up_questions: null,
  results: [
    {
      url: "https://pcsupport.lenovo.com/us/en/products/laptops-and-netbooks/20236",
      title: "G500 Laptop (Lenovo) - Type 20236",
      content: "> Laptops > G Series laptops (Lenovo) > G500 Laptop (Lenovo) - Type 20236",
      score: 0.8252664,
      id: "d69375-00",
    },
    {
      url: "https://www.flipkart.com/lenovo-essential-g500/p/itmdhz5gty8cmbzt",
      title: "Lenovo Essential G500 Laptop - Flipkart.com",
      content: "NVIDIA GeForce\n\n2.5 kg",
      score: 0.8025714,
      id: "6eb6bb-02",
    },
  ],
  response_time: 2.08,
};

const failed = (out: unknown) => (out as { reason: string }).reason;
const okPayload = (out: unknown) => (out as { payload: Record<string, unknown> }).payload;
const rowsOf = (out: unknown) => okPayload(out).results as Array<Record<string, unknown>>;

describe("searchTavily — the request it sends", () => {
  it("sends the key as a bearer token, and keyless as a header rather than nothing", async () => {
    const sent = stubTavily(() => json(TEXT_OK));
    await searchTavily("q", 6, "tvly-dev-abc");
    expect(sent[0].headers.Authorization).toBe("Bearer tvly-dev-abc");
    // The keyed call must NOT claim keyless mode: that header tells Tavily to accept the
    // request without checking a credential, which is the opposite of what a keyed install
    // is asking for.
    expect(sent[0].headers["X-Tavily-Access-Mode"]).toBeUndefined();

    await searchTavily("q", 6, "");
    // Keyless is not "no auth". Omitting the header answers 401 — the header is what tells
    // Tavily to accept the request at all, so dropping it silently removes the one keyless
    // provider in this file that returns real web results.
    expect(sent[1].headers.Authorization).toBeUndefined();
    expect(sent[1].headers["X-Tavily-Access-Mode"]).toBe("keyless");
  });

  it("asks for a synthesised answer, basic depth, and NOT for images", async () => {
    const sent = stubTavily(() => json(TEXT_OK));
    await searchTavily("lenovo g500", 6, "k");
    const body = sent[0].body;

    // The answer is why Tavily is primary: spec §4's synthesis as a field.
    expect(body.include_answer).toBe(true);
    // Images are a separate tier with their own rules, fetched by their own request. Asking
    // for them here would bill a second image search on every text turn — and it is a
    // one-word edit that no other test would notice.
    expect(body.include_images).toBe(false);
    // Measured: `basic` 0.6-1.2s against `advanced` 5.99s for the same top-three results.
    expect(body.search_depth).toBe("basic");
    // clampNum(6) + 2 — spare rows so merging and dedup are not handed exactly the count.
    expect(body.max_results).toBe(8);
    expect(body.query).toBe("lenovo g500");
    expect(sent[0].url).toBe("https://api.tavily.com/search");
  });

  it("clamps a caller asking for more rows than the route will ever use", async () => {
    const sent = stubTavily(() => json(TEXT_OK));
    await searchTavily("q", 500, "k");
    expect(sent[0].body.max_results).toBe(12); // clampNum caps at 10, plus 2
  });
});

describe("searchTavily — the mapping", () => {
  it("maps content, host and date onto the row shape the model reads", async () => {
    stubTavily(() => json(TEXT_OK));
    const rows = rowsOf(await searchTavily("lenovo g500", 6, "k"));

    expect(rows).toHaveLength(2);
    // `content` is a real page excerpt, so it becomes the snippet the model grounds on.
    expect(rows[0].snippet).toContain("G500 Laptop (Lenovo) - Type 20236");
    expect(rows[0].source).toBe("pcsupport.lenovo.com");
    // The recording has no `published_date` at all — Tavily omits it rather than sending
    // null — so an undated row is the normal case and must not become "undefined".
    expect(rows[0].date).toBeNull();
    expect(rows[1].source).toBe("flipkart.com"); // `www.` stripped, not copied
  });

  it("builds an answer box from `answer` and nothing when it is absent", async () => {
    stubTavily(() => json(TEXT_OK));
    expect(okPayload(await searchTavily("q", 6, "k")).answerBox).toEqual({
      title: "Answer",
      answer: expect.stringContaining("15.6"),
    });

    stubTavily(() => json({ ...TEXT_OK, answer: null }));
    // Not `{title: "Answer", answer: null}` — the truthy-but-empty shape that bug 2 in
    // search-providers.test.ts exists to keep out of every caller's `if (answerBox)`.
    expect(okPayload(await searchTavily("q", 6, "k")).answerBox).toBeNull();
  });

  it("treats null follow-ups as none, and caps a real list at four", async () => {
    // Null is what the live endpoint returned for this query. A `.slice` on it throws,
    // and the throw is inside the try block, so the failure would surface as
    // `tavily_fetch_failed` — a working provider reported as unreachable.
    stubTavily(() => json(TEXT_OK));
    expect(okPayload(await searchTavily("q", 6, "k")).related).toEqual([]);

    stubTavily(() =>
      json({ ...TEXT_OK, follow_up_questions: ["a", "b", "c", "d", "e", null] }),
    );
    // Capped at four, matching the chips the UI renders, and the null is filtered rather
    // than rendered as an empty chip.
    expect(okPayload(await searchTavily("q", 6, "k")).related).toEqual(["a", "b", "c", "d"]);
  });
});

describe("searchTavily — every failure shape names itself", () => {
  // One reason per failure, because they need opposite responses: a bad key is the
  // operator's problem, an empty index is worth a broader query. A provider that reports
  // all four as "tavily_error" makes the model apologise for the wrong thing.
  const CASES: Array<[string, () => Response, string]> = [
    ["an HTTP refusal keeps the status", () => new Response("nope", { status: 429 }), "tavily_http_429"],
    ["a 200 carrying an error field", () => json({ error: "invalid api key" }), "tavily_error"],
    ["a 200 with neither rows nor an answer", () => json({ results: [], answer: null }), "tavily_zero_results"],
  ];

  for (const [label, respond, reason] of CASES) {
    it(label, async () => {
      stubTavily(respond);
      expect(failed(await searchTavily("q", 6, "k"))).toBe(reason);
    });
  }

  it("a transport failure, without throwing into the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    // The contract every provider in this file shares: the caller's job is to try the next
    // tier, and an exception escaping here takes the whole route down instead of degrading it.
    expect(failed(await searchTavily("q", 6, "k"))).toBe("tavily_fetch_failed");
  });
});

describe("searchTavilyImages — the shape rules", () => {
  const IMAGE_OBJECTS = {
    query: "lenovo g500",
    images: [
      { url: "https://www.bhphotovideo.com/images/fb/g500.jpg", title: "Lenovo Essential G500 15.6\" Laptop", description: null },
      { url: "https://media.officedepot.com/images/g500.png", title: "", description: "A black Lenovo G500 laptop." },
    ],
  };

  it("asks for descriptions, which is what makes a row carry a title", async () => {
    const sent = stubTavily(() => json(IMAGE_OBJECTS));
    await searchTavilyImages("lenovo g500", 12, "k");
    // The flag decides the row shape: with it, `images` is objects; without it, bare URL
    // strings. Both are handled, but this is the one that gives the gallery captions.
    expect(sent[0].body.include_image_descriptions).toBe(true);
    expect(sent[0].body.include_images).toBe(true);
  });

  it("uses the original as its own thumbnail and falls back to the description for a title", async () => {
    stubTavily(() => json(IMAGE_OBJECTS));
    const images = okPayload(await searchTavilyImages("q", 12, "k")).images as Array<Record<string, unknown>>;

    // No thumbnail exists on this tier, so the original stands in for itself rather than
    // the row being dropped: a five-row contribution is the whole reason it is in the tier.
    expect(images[0].thumbnailUrl).toBe(images[0].imageUrl);
    expect(images[0].source).toBe("bhphotovideo.com");
    // `title` is frequently null and `description` frequently is not, so the caption comes
    // from whichever is present.
    expect(images[1].title).toBe("A black Lenovo G500 laptop.");
  });

  it("leaves pageUrl empty rather than attributing the picture to a page Tavily did not name", async () => {
    stubTavily(() =>
      json({
        ...IMAGE_OBJECTS,
        // A results array is present and tempting: the first result's URL is a page the
        // query matched. Inventing it as the image's source page would put a real
        // attribution on the wrong picture, and the UI already renders an empty pageUrl
        // as plain text instead of a link.
        results: [{ url: "https://pcsupport.lenovo.com/20236", title: "G500", content: "..." }],
      }),
    );
    const images = okPayload(await searchTavilyImages("q", 12, "k")).images as Array<Record<string, unknown>>;
    expect(images[0].pageUrl).toBe("");
  });

  it("drops a row whose URL is not http(s) instead of rendering it", async () => {
    stubTavily(() =>
      json({
        query: "q",
        images: [
          "javascript:alert(1)",
          "data:image/png;base64,AAAA",
          { url: "not a url", title: "relative" },
          { url: null, title: "missing" },
          { url: "https://ok.example.com/a.png", title: "keep" },
        ],
      }),
    );
    const out = await searchTavilyImages("q", 12, "k");
    const images = okPayload(out).images as Array<Record<string, unknown>>;
    // The safe row survives and the payload never contains a scheme that would execute in
    // an `<img src>` — same allowlist as SerpApi's rows, applied at the same boundary.
    expect(images).toHaveLength(1);
    expect(images[0].imageUrl).toBe("https://ok.example.com/a.png");
    expect(JSON.stringify(images)).not.toMatch(/javascript:|data:/);
  });

  it("names its own failures, distinctly from the text tier's", async () => {
    stubTavily(() => new Response("nope", { status: 403 }));
    expect(failed(await searchTavilyImages("q", 12, "k"))).toBe("tavily_images_http_403");

    stubTavily(() => json({ error: "bad request" }));
    expect(failed(await searchTavilyImages("q", 12, "k"))).toBe("tavily_images_error");

    stubTavily(() => json({ images: [] }));
    expect(failed(await searchTavilyImages("q", 12, "k"))).toBe("tavily_images_zero_results");
  });
});

describe("hostOf", () => {
  it("reads the host and strips a leading www", () => {
    expect(hostOf("https://www.flipkart.com/lenovo-essential-g500/p/x")).toBe("flipkart.com");
    expect(hostOf("https://pcsupport.lenovo.com/a/b?c=1#d")).toBe("pcsupport.lenovo.com");
  });

  it("returns null rather than a guess when the input is not an absolute URL", () => {
    // Every one of these would otherwise reach a source chip as a bogus hostname:
    // a bare path, a protocol with no host, a non-URL string, and nothing at all.
    expect(hostOf("/local/path")).toBeNull();
    expect(hostOf("javascript:alert(1)")).toBeNull(); // parses, but has no host
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});
