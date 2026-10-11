// The search provider chain, asserted against saved real responses.
//
// WHY THIS FILE EXISTS
//
// The report was "fix websearch". What was actually wrong was not one bug:
//
//   1. HTTP 202 passes `res.ok` (true for anything 200-299), so the DuckDuckGo
//      fallback accepted the anti-bot challenge page, parsed zero results out of it,
//      and reported that as "the web returned nothing". Those need opposite responses
//      from the model — "I could not check" versus "there is nothing to find" — and
//      the whole error-code taxonomy in _search-providers.js exists to keep them
//      apart. This bug made the taxonomy lie.
//
//   2. `answerBox` could be `{title: null, answer: null}`: truthy, and empty. Any
//      caller writing `if (search.answerBox)` gets the wrong answer. Verified live
//      against the deployment, which returned exactly that for a sports query where
//      SerpApi sent a `sports_results` block with none of the fields we read.
//
//   3. When SerpApi has no key or no quota left, the only remaining provider was a
//      scraper that is rate limited by IP — permanently so on Vercel, where the
//      outbound address is shared with every other tenant. So "no key" meant "no
//      search", which is the state every fresh clone of this repo starts in.
//
// WHAT IS ASSERTED, AND WHY IT IS SHAPED THIS WAY
//
// No network. Each provider is driven against a captured response, so these run
// offline and deterministically. That is a deliberate limit: it cannot tell you
// whether DuckDuckGo is up today. `scripts/probe-search.mjs` and
// `scripts/probe-search-backends.mjs` answer that question live, and the fixtures
// below are recordings of what those probes actually returned on 2026-08-22.
//
// THE CHAIN CHANGED ON 2026-10-11, and the tests that pin it changed with it.
//
// Tavily is now the primary text engine and half the image tier, because it returns
// things SerpApi does not: a synthesised `answer`, `follow_up_questions`, real page
// excerpts, and — the one that matters most here — a documented KEYLESS mode. Before
// it, "no key" meant "no web search": a fresh clone fell straight through to Wikipedia
// and Stack Exchange and reported `degraded: true`, and image search did not work at
// all. It now answers from a real web index, which is why the old assertions that
// pinned `error: "serpapi_key_missing"` and `degraded: true` on a keyless install are
// gone rather than adjusted: that state no longer exists, and a test that kept them
// would be asserting the behaviour this change removed.
//
// The two Tavily fixtures are recordings too, taken 2026-10-11 with
// `scripts/probe-search-backends.mjs --tavily` against api.tavily.com.

import { describe, it, expect, vi, afterEach } from "vitest";

// No `@ts-expect-error` here, and none needed: `noImplicitAny` is off in
// tsconfig.app.json, so an untyped `.js` import resolves to `any` silently. A
// directive would be an *error* under `--noEmit` ("unused '@ts-expect-error'"),
// which is how it read before — green under `npx tsc --noEmit` (root config is
// `files: []`, so it checks nothing) and red under `npm run build`. Same shape as
// the api imports in api-guard.test.ts and providers.test.ts.
import * as providers from "../../api/_search-providers.js";

const {
  condense,
  toAnswerBox,
  parseDuckDuckGoLite,
  isDuckDuckGoBlock,
  searchWikipedia,
  searchStackExchange,
  runSearch,
  runImageSearch,
} = providers as {
  condense: (rows: unknown[], limit?: number) => Array<Record<string, unknown>>;
  toAnswerBox: (raw: unknown, overview?: string) => { title: string | null; answer: string } | null;
  parseDuckDuckGoLite: (html: string, limit?: number) => Array<Record<string, string>>;
  isDuckDuckGoBlock: (status: number, html: string) => boolean;
  searchWikipedia: (q: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
  searchStackExchange: (q: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
  runSearch: (
    q: string,
    num: number,
    env: Record<string, string | undefined>,
    log?: (m: string) => void,
  ) => Promise<Record<string, unknown>>;
  runImageSearch: (
    q: string,
    num: number,
    env: Record<string, string | undefined>,
    log?: (m: string) => void,
  ) => Promise<Record<string, unknown>>;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Every fetch the stub saw in the current test, with the auth it carried.
 *
 * The credential is recorded because after 2026-10-11 the SAME URL is two different
 * tiers of the chain — `api.tavily.com/search` is the keyed primary and, later, the
 * keyless retry. A route table keyed on the URL alone cannot tell those apart, so a
 * test that wanted to assert "the keyless retry never ran" would pass whether it ran
 * or not. Records, not just URLs, is what makes that assertion real.
 */
const requests: Array<{ url: string; auth: string | null; keyless: boolean }> = [];

/** Reply to every fetch by matching the URL against a table of handlers. */
function stubFetch(routes: Array<[RegExp, (init?: RequestInit) => Response]>) {
  requests.length = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers || {}) as Record<string, string>;
      calls.push(url);
      requests.push({ url, auth: headers.Authorization ?? null, keyless: headers["X-Tavily-Access-Mode"] === "keyless" });
      for (const [pattern, respond] of routes) if (pattern.test(url)) return respond(init);
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
  return calls;
}

const tavilyCalls = () => requests.filter((r) => /tavily\.com/.test(r.url));
/** Was this request the keyed one? Used by handlers that must answer differently per tier. */
const authed = (init?: RequestInit) => Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ── fixtures ───────────────────────────────────────────────────────────────

// Trimmed from a real lite.duckduckgo.com 200 response. Note the single-quoted class
// attributes: that is how the page actually ships it, and it is why the parser's
// regexes accept either quote style.
const DDG_RESULTS_HTML = `
<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.espn.com%2Fnfl%2Fstory%2F_%2Fid%2F47822193" class='result-link'>Super Bowl 2026 highlights: Seahawks capture second Lombardi</a></td></tr>
  <tr><td class='result-snippet'>Seattle controlled the game from start to finish, defeating New England 29-13.</td></tr>
  <tr><td><a rel="nofollow" href="https://en.wikipedia.org/wiki/Super_Bowl_LX" class='result-link'>Super Bowl LX - Wikipedia</a></td></tr>
  <tr><td class='result-snippet'>The game took place on February 8, 2026, at Levi&#39;s Stadium.</td></tr>
</table>`;

// The interstitial, as served with HTTP 202. The distinguishing feature is not the
// word "anomaly" but the *absence* of result-link markup.
const DDG_ANOMALY_HTML = `
<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div class="anomaly-modal__description">Please try again.</div></body></html>`;

describe("condense", () => {
  it("drops rows with no title and rows with neither snippet nor link", () => {
    const out = condense([
      { title: "", snippet: "x", link: "https://a" },
      { title: "ok", snippet: "", link: "" },
      { title: "keep", snippet: "s", link: "https://b" },
    ]);
    expect(out.map((r) => r.title)).toEqual(["keep"]);
  });

  // The reason merging happens centrally: the same article legitimately appears in
  // SerpApi's news block and its organic block, and once two providers' results are
  // concatenated the same URL can arrive from both.
  it("deduplicates by link across the whole merged set", () => {
    const out = condense([
      { title: "A", snippet: "s", link: "https://same" },
      { title: "A again", snippet: "s", link: "https://same" },
      { title: "B", snippet: "s", link: "https://other" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("honours the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, snippet: "s", link: `https://x/${i}` }));
    expect(condense(rows, 6)).toHaveLength(6);
  });
});

describe("toAnswerBox", () => {
  // THE regression test for bug 2. The old expression was
  //   ab ? { title: ab.title || ab.name || null, answer: ab.answer || ... || null } : ...
  // which returns a truthy object whenever `ab` is truthy, however empty it is.
  it("returns null rather than an object with a null answer", () => {
    expect(toAnswerBox({ title: null, name: null, answer: null })).toBeNull();
    expect(toAnswerBox({ some_other_field: "value" })).toBeNull();
    expect(toAnswerBox(null)).toBeNull();
  });

  it("keeps a real answer, and a title is optional", () => {
    expect(toAnswerBox({ answer: "29-13" })).toEqual({ title: null, answer: "29-13" });
    expect(toAnswerBox({ name: "Super Bowl LX", snippet: "Seahawks won" })).toEqual({
      title: "Super Bowl LX",
      answer: "Seahawks won",
    });
  });

  it("falls back to the AI overview when there is no answer block", () => {
    expect(toAnswerBox(null, "Seattle beat New England.")).toEqual({
      title: "AI Overview",
      answer: "Seattle beat New England.",
    });
  });
});

describe("the DuckDuckGo block detector", () => {
  // THE regression test for bug 1. `new Response(null, {status: 202}).ok === true`,
  // so the old `if (!res.ok) return null` let this page straight through.
  it("treats 202 as blocked even though res.ok would be true", () => {
    expect(new Response(null, { status: 202 }).ok).toBe(true);
    expect(isDuckDuckGoBlock(202, DDG_ANOMALY_HTML)).toBe(true);
  });

  it("treats an anomaly page as blocked whatever the status", () => {
    expect(isDuckDuckGoBlock(200, DDG_ANOMALY_HTML)).toBe(true);
  });

  // The important negative. A results page that merely *mentions* one of those words
  // must not be discarded, which is why the text check requires result-link to be
  // absent as well.
  it("does not treat a real results page as blocked", () => {
    expect(isDuckDuckGoBlock(200, DDG_RESULTS_HTML)).toBe(false);
    expect(
      isDuckDuckGoBlock(200, DDG_RESULTS_HTML + "<p>captcha research paper</p>"),
      "a results page mentioning captcha is still a results page",
    ).toBe(false);
  });
});

describe("parseDuckDuckGoLite", () => {
  it("pairs each link with the snippet that follows it, and unwraps the redirect", () => {
    const out = parseDuckDuckGoLite(DDG_RESULTS_HTML);
    expect(out).toHaveLength(2);
    expect(out[0].link).toBe("https://www.espn.com/nfl/story/_/id/47822193");
    expect(out[0].snippet).toContain("29-13");
    expect(out[1].link).toBe("https://en.wikipedia.org/wiki/Super_Bowl_LX");
    // Entities decoded, tags stripped.
    expect(out[1].snippet).toContain("Levi's Stadium");
  });

  it("finds nothing in the anomaly page", () => {
    expect(parseDuckDuckGoLite(DDG_ANOMALY_HTML)).toEqual([]);
  });
});

describe("the keyless providers", () => {
  it("strips Wikipedia's searchmatch markup and builds a real article URL", async () => {
    stubFetch([
      [
        /wikipedia\.org/,
        () =>
          json({
            query: {
              search: [
                {
                  title: "Super Bowl LX",
                  snippet: 'the <span class="searchmatch">Seahawks</span> defeated New England',
                  timestamp: "2026-02-09T00:00:00Z",
                },
              ],
            },
          }),
      ],
    ]);
    const out = await searchWikipedia("super bowl 2026");
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("the Seahawks defeated New England");
    expect(out[0].link).toBe("https://en.wikipedia.org/wiki/Super_Bowl_LX");
    expect(out[0].source).toBe("Wikipedia");
  });

  it("truncates Stack Overflow bodies, which are whole HTML answers", async () => {
    stubFetch([
      [
        /stackexchange\.com/,
        () =>
          json({
            items: [
              {
                title: "How to debounce in React",
                body: `<p>${"word ".repeat(400)}</p>`,
                link: "https://stackoverflow.com/q/1",
                is_answered: true,
                creation_date: 1740000000,
              },
            ],
          }),
      ],
    ]);
    const out = await searchStackExchange("react debounce");
    expect((out[0].snippet as string).length).toBeLessThanOrEqual(400);
    expect(out[0].snippet).not.toContain("<p>");
    expect(out[0].source).toBe("Stack Overflow (answered)");
  });

  // Measured against the live API: `q` is AND across every term, so
  // "typescript debounce hook cancel flush" returns 0 items while
  // "typescript debounce hook" returns 3. Without the retry the programming half of
  // the keyless tier answers nothing for any real question.
  it("retries on the leading words when the full query is too narrow", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const q = new URL(String(input)).searchParams.get("q") || "";
        queries.push(q);
        // Mirrors the measured behaviour: all five terms match nothing.
        if (q.split(/\s+/).length > 3) return json({ items: [] });
        return json({ items: [{ title: "Debounce a hook", body: "<p>use a ref</p>", link: "https://so/1" }] });
      }),
    );

    const out = await searchStackExchange("typescript debounce hook cancel flush");
    expect(out).toHaveLength(1);
    expect(queries).toEqual(["typescript debounce hook cancel flush", "typescript debounce hook"]);
  });

  it("does not retry when the query is already short, or when the first try worked", async () => {
    const shortQueries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        shortQueries.push(new URL(String(input)).searchParams.get("q") || "");
        return json({ items: [] });
      }),
    );
    expect(await searchStackExchange("debounce hook")).toEqual([]);
    // One call, not two: there is nothing left to trim off a three-word query.
    expect(shortQueries).toHaveLength(1);
  });

  // Every provider swallows its own failure and returns empty, because the caller's
  // job is to try the next tier. An exception escaping one of these would take down
  // the route instead of degrading it.
  it("returns empty rather than throwing when a provider is down", async () => {
    stubFetch([[/./, () => new Response("nope", { status: 500 })]]);
    expect(await searchWikipedia("x")).toEqual([]);
    expect(await searchStackExchange("x")).toEqual([]);
  });
});

describe("runSearch: the provider chain", () => {
  // Recorded 2026-10-11 from api.tavily.com/search, "Lenovo G500 laptop" (bodies
  // trimmed, shape untouched). Two absences in the recording are load-bearing and are
  // kept: no row carries `published_date`, and `follow_up_questions` is null rather
  // than an array. Both are what the live endpoint actually returns for this query, and
  // both are states the mapping has to survive — a `results.map` that assumed a date,
  // or a `.slice` on follow-ups without a `|| []`, would pass on a hand-written fixture
  // and throw on this one.
  const TAVILY_OK = {
    query: "lenovo g500",
    answer:
      'The Lenovo G500 laptop is equipped with various configurations, including Intel Pentium 2030M and Intel Celeron 1005M processors, paired with AMD Radeon HD 8570M or Intel HD Graphics (Ivy Bridge) video cards. The display size is 15.6" with HD resolution (1366 x 768).',
    follow_up_questions: null,
    results: [
      {
        url: "https://pcsupport.lenovo.com/us/en/products/laptops-and-netbooks/lenovo-g-series-laptops/lenovo-g500-notebook/20236",
        title: "laptops and netbooks :: lenovo g series laptops :: lenovo g500 notebook :: 20236 - Lenovo Support US",
        content: "Skip to content\n\n> Laptops > G Series laptops (Lenovo) > G500 Laptop (Lenovo) - Type 20236",
        score: 0.8252664,
        id: "d69375-00",
      },
      {
        url: "https://laptopmedia.com/series/lenovo-g500",
        title: "Lenovo G500 - Specs, Tests, and Prices | LaptopMedia.com",
        content: "View all results\n\n# Lenovo G500\n\nLaptop Specs Lenovo G500 Series\n\n#### Lenovo G500 - Specs",
        score: 0.82082915,
        id: "bbbbde-01",
      },
      {
        // The `www.` row, kept because it is the one that proves the host is normalised
        // and not just copied — asserted below.
        url: "https://www.flipkart.com/lenovo-essential-g500-59-382995-laptop/p/itmdhz5gty8cmbzt",
        title: "Lenovo Essential G500 (59-382995) Laptop Rs. Price in India - Buy Online - Lenovo : Flipkart.com",
        content: "NVIDIA GeForce\n\n2.5 kg\n\nAll details\n\nFeatures, description and more",
        score: 0.8025714,
        id: "6eb6bb-02",
      },
    ],
    response_time: 2.08,
    request_id: "f2b7621d-b1de-4433-b161-31f7002d9748",
  };

  const SERP_OK = {
    organic_results: [
      { title: "ESPN recap", snippet: "Seattle 29, New England 13", link: "https://espn.com/x", source: "ESPN" },
    ],
  };

  it("uses keyed Tavily and stops there when it answers", async () => {
    const calls = stubFetch([[/tavily\.com/, () => json(TAVILY_OK)]]);
    const out = await runSearch("lenovo g500", 6, { TAVILY_API_KEY: "k" });
    const rows = out.results as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(3);
    // The synthesised answer is the reason Tavily took the primary slot: it is spec
    // §4's "synthesis" arriving as a field rather than as a second model call.
    expect(out.answerBox).toEqual({ title: "Answer", answer: expect.stringContaining("15.6") });
    // `content` is a real page excerpt and becomes the snippet the model grounds on.
    expect(rows[0].snippet).toContain("G500 Laptop (Lenovo) - Type 20236");
    expect(rows[0].source).toBe("pcsupport.lenovo.com");
    expect(rows[2].source).toBe("flipkart.com"); // `www.` stripped by hostOf, not copied
    expect(rows[0].date).toBeNull(); // the recording has no published_date
    // A clean primary answer is neither a failure nor a degraded tier.
    expect(out.error).toBeUndefined();
    expect(out.degraded).toBeUndefined();
    // Nothing else was contacted: the fallbacks cost latency and burn the shared IP's
    // rate-limit allowance on the keyless providers.
    expect(calls).toEqual(["https://api.tavily.com/search"]);
    expect(tavilyCalls()[0].auth).toBe("Bearer k");
    expect(tavilyCalls()[0].keyless).toBe(false);
  });

  // The state a fresh clone of this repo is in, and the one this change rewrote. It used
  // to fall straight through to Wikipedia + Stack Exchange and report `degraded: true`
  // with `error: "serpapi_key_missing"` — both of which were accurate then and are both
  // gone now, because keyless Tavily answers from a full web index. Asserting the two
  // flags are ABSENT is the assertion; a test that only checked "results length > 0"
  // would pass on the old chain too.
  it("searches the whole web with no key configured at all", async () => {
    const calls = stubFetch([[/tavily\.com/, () => json(TAVILY_OK)]]);
    const logs: string[] = [];
    const out = await runSearch("lenovo g500", 6, {}, (m) => logs.push(m));

    expect((out.results as unknown[]).length).toBe(3);
    expect(out.degraded).toBeUndefined();
    // A missing key is a deployment fact, not something the user has to hedge about.
    expect(out.error).toBeUndefined();
    expect(tavilyCalls()).toHaveLength(1);
    expect(tavilyCalls()[0].keyless).toBe(true);
    expect(tavilyCalls()[0].auth).toBeNull();
    // Not one scraper was reached.
    expect(calls.every((u) => /tavily\.com/.test(u))).toBe(true);
    expect(logs.join(" ")).toContain("TAVILY_API_KEY is not configured");
  });

  // The mirror of the case above, and the reason the keyed call is inside `if (tavily)`
  // rather than unconditional: an install that configured a paying provider means it.
  // Sending a keyless request first would spend a documented convenience on an install
  // that is not relying on it.
  it("does not spend a keyless request when only SerpApi is configured", async () => {
    const calls = stubFetch([[/serpapi\.com/, () => json(SERP_OK)]]);
    const out = await runSearch("super bowl", 6, { SERPAPI_API_KEY: "k" });

    expect((out.results as Array<{ title: string }>)[0].title).toBe("ESPN recap");
    expect(out.error).toBeUndefined();
    expect(tavilyCalls()).toEqual([]);
    expect(calls).toEqual([expect.stringContaining("serpapi.com")]);
  });

  it("hands over to SerpApi when the keyed primary refuses, and names the primary", async () => {
    stubFetch([
      [/tavily\.com/, () => new Response("rate limited", { status: 429 })],
      [/serpapi\.com/, () => json(SERP_OK)],
    ]);
    const out = await runSearch("super bowl", 6, { TAVILY_API_KEY: "k", SERPAPI_API_KEY: "k" });

    expect((out.results as Array<{ title: string }>)[0].title).toBe("ESPN recap");
    // The reason from the FIRST configured provider, because "your Tavily key is
    // rejected" is the actionable half.
    expect(out.error).toBe("tavily_http_429");
    // Not degraded: SerpApi's rows are a full web index. Calling them "narrower fallback
    // indexes" would make the model hedge about results that are fine — which is the
    // distinction `degraded` was split out of `error` to carry.
    expect(out.degraded).toBeUndefined();
    // SerpApi answered, so the keyless retry never ran: one Tavily call, and it was keyed.
    expect(tavilyCalls()).toHaveLength(1);
    expect(tavilyCalls()[0].keyless).toBe(false);
  });

  // The tier order, end to end and in one test: the same URL is called twice and the
  // two calls are told apart only by their headers, which is exactly the thing a
  // URL-keyed route table cannot assert.
  it("retries keyless Tavily after a rejected key, ahead of the scrapers", async () => {
    const calls = stubFetch([
      [/tavily\.com/, (init) => (authed(init) ? new Response("quota", { status: 429 }) : json(TAVILY_OK))],
    ]);
    const logs: string[] = [];
    const out = await runSearch("lenovo g500", 6, { TAVILY_API_KEY: "k" }, (m) => logs.push(m));

    expect((out.results as unknown[]).length).toBe(3);
    expect(tavilyCalls().map((r) => r.keyless)).toEqual([false, true]);
    // Recovered — so not degraded — while still reporting why the primary was not used.
    expect(out.degraded).toBeUndefined();
    expect(out.error).toBe("tavily_http_429");
    expect(calls.every((u) => /tavily\.com/.test(u))).toBe(true);
    expect(logs.join(" ")).toContain("Tavily unavailable (tavily_http_429)");
  });

  // The last tier is the only one that sets `degraded`, and the keyless retry's own
  // failure must not overwrite the primary's reason: "the unkeyed retry also had a bad
  // day" is not the half a user can act on.
  it("degrades to the narrow indexes while keeping the primary's reason", async () => {
    stubFetch([
      [/tavily\.com/, (init) => (authed(init) ? new Response("boom", { status: 500 }) : json({ results: [], answer: null }))],
      [/duckduckgo/, () => new Response(DDG_ANOMALY_HTML, { status: 202 })],
      [/wikipedia/, () => json({ query: { search: [{ title: "Super Bowl LX", snippet: "Seahawks won" }] } })],
      [/stackexchange/, () => json({ items: [] })],
    ]);
    const logs: string[] = [];
    const out = await runSearch("super bowl", 6, { TAVILY_API_KEY: "k" }, (m) => logs.push(m));

    expect((out.results as unknown[]).length).toBeGreaterThan(0);
    expect(out.degraded).toBe(true);
    expect(out.error).toBe("tavily_http_500");
    expect(logs.join(" ")).toContain("Tavily keyless unavailable (tavily_zero_results)");
  });

  // Bug 1 end to end: a 202 must not be reported as an empty web.
  it("reports a rate-limited fallback as blocked, not as an empty web", async () => {
    stubFetch([
      [/tavily\.com/, () => new Response("boom", { status: 500 })],
      [/serpapi\.com/, () => json({ error: "Your account has run out of searches." })],
      [/duckduckgo/, () => new Response(DDG_ANOMALY_HTML, { status: 202 })],
      [/wikipedia/, () => json({ query: { search: [] } })],
      [/stackexchange/, () => json({ items: [] })],
    ]);
    const logs: string[] = [];
    const out = await runSearch("super bowl", 6, { TAVILY_API_KEY: "k", SERPAPI_API_KEY: "k" }, (m) => logs.push(m));

    expect(out.results).toEqual([]);
    // The first configured reason wins: "your quota is gone" is the actionable half.
    expect(out.error).toBe("tavily_http_500");
    // Nothing was found at all, so this is not a degraded tier — it is a failure, and
    // `degraded` staying unset is what keeps the caller from reporting it as thin rows.
    expect(out.degraded).toBeUndefined();
    expect(logs.join(" ")).toContain("ddg_rate_limited");
  });

  it("falls through when a provider answers 200 with nothing usable", async () => {
    stubFetch([
      [/tavily\.com/, () => json({ results: [], answer: null })],
      [/serpapi\.com/, () => json({ organic_results: [], answer_box: { title: "x" } })],
      [/duckduckgo/, () => new Response(DDG_RESULTS_HTML, { status: 200 })],
    ]);
    const out = await runSearch("super bowl", 6, { TAVILY_API_KEY: "k", SERPAPI_API_KEY: "k" });
    expect((out.results as Array<{ source: string }>)[0].source).toBe("DuckDuckGo Web");
    // The FIRST zero-results reason, not the last: Tavily is the engine whose behaviour
    // the user can change (a broader query, a different depth), so its name is the one
    // worth carrying.
    expect(out.error).toBe("tavily_zero_results");
    expect(out.degraded).toBeUndefined();
  });

  // An answer with no links is a SUCCESS, not an empty result set. Tavily synthesises an
  // answer to a factual question and the recording above shows it returning one with
  // rows, but a conversational query legitimately comes back with an answer and nothing
  // to cite — and `!results.length` alone would throw that away.
  it("accepts an answer with no results as a search that worked", async () => {
    stubFetch([[/tavily\.com/, () => json({ results: [], answer: "It is 29-13.", follow_up_questions: null })]]);
    const out = await runSearch("super bowl score", 6, { TAVILY_API_KEY: "k" });
    expect(out.results).toEqual([]);
    expect(out.answerBox).toEqual({ title: "Answer", answer: "It is 29-13." });
    expect(out.error).toBeUndefined();
  });

  it("never throws, even when every provider fails hard", async () => {
    stubFetch([[/./, () => new Response("boom", { status: 500 })]]);
    const out = await runSearch("x", 6, { TAVILY_API_KEY: "k" });
    expect(out.results).toEqual([]);
    expect(typeof out.error).toBe("string");
  });
});

// The image tier is a merge rather than a chain: both providers are asked at once and
// their rows are combined. Tavily returns five images with a title but no thumbnail and
// no source page; SerpApi returns twelve with cached thumbnails, dimensions and the page
// each was found on. Neither is a substitute for the other, which is why this is the one
// place in the file where the primary does NOT short-circuit the secondary.
describe("runImageSearch: the merged image tier", () => {
  const TAVILY_IMAGES = {
    query: "lenovo g500",
    // Recorded 2026-10-11 with `include_image_descriptions: true`, which is what the
    // provider sends. Note the second row: `title` is set and `description` is set, while
    // the first has `description: null` — the mapping reads title first and falls back.
    images: [
      {
        url: "https://www.bhphotovideo.com/images/fb/lenovo_ideapad_g500_59373036_15_6_985074.jpg",
        title: 'Lenovo Essential G500 59373036 15.6" Laptop Computer 59373036',
        description: null,
      },
      {
        url: "https://media.officedepot.com/images/f_auto,q_auto,e_sharpen,h_450/products/144578/144578_p_g500_metal_standard_04_win8_wallpaper/144578",
        title: "Lenovo G500 59374891 Laptop Computer With 15.6 Screen 3rd Gen Intel Core i3 Processor - Office Depot",
        description: "A black Lenovo G500 laptop displays a colorful Windows 8 start screen.",
      },
    ],
  };

  const SERP_IMAGES = {
    images_results: [
      { title: "Lenovo G500 front", original: "https://lenovo.com/g500-front.jpg", thumbnail: "https://encrypted-tbn0.gstatic.com/AAA", link: "https://lenovo.com/g500", source: "Lenovo" },
      { title: "Lenovo G500 lid", original: "https://amazon.com/g500-lid.jpg", thumbnail: "https://encrypted-tbn0.gstatic.com/BBB", link: "https://amazon.com/g500", source: "Amazon" },
    ],
  };

  it("asks both providers and puts Tavily's rows first", async () => {
    stubFetch([
      [/tavily\.com/, () => json(TAVILY_IMAGES)],
      [/serpapi\.com/, () => json(SERP_IMAGES)],
    ]);
    const out = await runImageSearch("lenovo g500", 12, { TAVILY_API_KEY: "k", SERPAPI_API_KEY: "k" });
    const images = out.images as Array<Record<string, unknown>>;

    expect(images).toHaveLength(4);
    expect(images[0].imageUrl).toBe(TAVILY_IMAGES.images[0].url);
    expect(images[2].title).toBe("Lenovo G500 front");
    // Both legs answered, so there is nothing to report as lost.
    expect(out.degraded).toBeUndefined();
    expect(out.error).toBeUndefined();

    // Tavily has no thumbnail to offer, so the original is used as its own thumbnail
    // rather than the row being dropped — a five-row contribution is the whole reason
    // it is in this tier.
    expect(images[0].thumbnailUrl).toBe(TAVILY_IMAGES.images[0].url);
    // And no source page, deliberately: Tavily does not say which page an image was
    // found on, and guessing (the first result's URL) would be a made-up attribution on
    // a real picture. Empty is what the UI renders as "no link", not as a link to "#".
    expect(images[0].pageUrl).toBe("");
    expect(images[0].source).toBe("bhphotovideo.com"); // www. stripped
  });

  // The measurement that decided the tier's shape: Tavily returns five images and no
  // more, so on its own it cannot fill the grid this feature was built to show.
  it("works with no key at all, through keyless Tavily", async () => {
    stubFetch([[/tavily\.com/, () => json(TAVILY_IMAGES)]]);
    const out = await runImageSearch("lenovo g500", 12, {});
    expect((out.images as unknown[]).length).toBe(2);
    expect(tavilyCalls()[0].keyless).toBe(true);
    // SerpApi's absence is a deployment fact, and the rows are real — reporting this as
    // an error would tell the user their perfectly good gallery had failed.
    expect(out.error).toBeUndefined();
  });

  it("accepts bare-string rows, which is the shape without image descriptions", async () => {
    // Not a keyless quirk: measured 2026-10-11 across all four combinations of key ×
    // include_image_descriptions, the FLAG decides the shape and the credential does not.
    // Dropping the flag is a one-word edit, and without this branch it would silently
    // empty the gallery.
    stubFetch([[/tavily\.com/, () => json({ query: "x", images: ["https://x/a.jpg", "https://x/b.jpg"] })]]);
    const out = await runImageSearch("x", 12, { TAVILY_API_KEY: "k" });
    expect((out.images as Array<Record<string, unknown>>).map((i) => i.imageUrl)).toEqual([
      "https://x/a.jpg",
      "https://x/b.jpg",
    ]);
    expect((out.images as Array<Record<string, unknown>>)[0].title).toBe("");
  });

  it("reports the lost leg alongside the rows it kept, rather than instead of them", async () => {
    stubFetch([
      [/tavily\.com/, () => new Response("nope", { status: 403 })],
      [/serpapi\.com/, () => json(SERP_IMAGES)],
    ]);
    const out = await runImageSearch("lenovo g500", 12, { TAVILY_API_KEY: "k", SERPAPI_API_KEY: "k" });
    expect((out.images as unknown[]).length).toBe(2);
    // Degraded, not failed: the pictures are real and shown; the flag only says the set
    // is smaller than a full search would have returned.
    expect(out.degraded).toBe(true);
    expect(out.error).toBe("tavily:tavily_images_http_403");
  });

  it("names a reason when no provider can answer", async () => {
    stubFetch([
      [/tavily\.com/, () => json({ query: "x", images: [] })],
      [/serpapi\.com/, () => json({ error: "Invalid API key" })],
    ]);
    const logs: string[] = [];
    const out = await runImageSearch("x", 12, { TAVILY_API_KEY: "k", SERPAPI_API_KEY: "k" }, (m) => logs.push(m));
    expect(out.images).toEqual([]);
    expect(out.error).toBe("tavily_images_zero_results");
    expect(logs.join(" ")).toContain("[images] no provider could answer");
  });

  it("fails with a named reason on a bare install rather than returning an empty gallery", async () => {
    // The old behaviour, kept because a deployment can still reach it: no provider at
    // all. An empty `images: []` with no `error` is the shape that lets a caller render a
    // blank panel and call it success.
    stubFetch([[/./, () => new Response("nope", { status: 500 })]]);
    const out = await runImageSearch("x", 12, {});
    expect(out.images).toEqual([]);
    expect(typeof out.error).toBe("string");
    expect(out.degraded).toBeUndefined();
  });

  it("does not ask SerpApi for images when it has no key", async () => {
    const calls = stubFetch([[/tavily\.com/, () => json(TAVILY_IMAGES)]]);
    await runImageSearch("x", 12, { TAVILY_API_KEY: "k" });
    expect(calls.every((u) => /tavily\.com/.test(u))).toBe(true);
  });
});
