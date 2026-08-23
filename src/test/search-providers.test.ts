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
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Reply to every fetch by matching the URL against a table of handlers. */
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
  const SERP_OK = {
    organic_results: [
      { title: "ESPN recap", snippet: "Seattle 29, New England 13", link: "https://espn.com/x", source: "ESPN" },
    ],
  };

  it("uses SerpApi and stops there when it answers", async () => {
    const calls = stubFetch([[/serpapi\.com/, () => json(SERP_OK)]]);
    const out = await runSearch("super bowl", 6, { SERPAPI_API_KEY: "k" });
    expect(out.results).toHaveLength(1);
    expect(out.error).toBeUndefined();
    // Nothing else was contacted: the fallbacks cost latency and burn the shared IP's
    // rate-limit allowance on the keyless providers.
    expect(calls.filter((u) => !/serpapi/.test(u))).toEqual([]);
  });

  // The state a fresh clone of this repo is in.
  it("skips SerpApi entirely with no key and still returns results", async () => {
    stubFetch([
      [/duckduckgo/, () => new Response(DDG_ANOMALY_HTML, { status: 202 })],
      [/wikipedia/, () => json({ query: { search: [{ title: "Super Bowl LX", snippet: "Seahawks won" }] } })],
      [/stackexchange/, () => json({ items: [] })],
    ]);
    const logs: string[] = [];
    const out = await runSearch("super bowl", 6, {}, (m) => logs.push(m));

    expect((out.results as unknown[]).length).toBeGreaterThan(0);
    // Degraded, and says so. The model is told the results may be incomplete, which
    // is true: this tier is two narrow indexes, not the web.
    expect(out.degraded).toBe(true);
    expect(out.error).toBe("serpapi_key_missing");
    expect(logs.join(" ")).toContain("SERPAPI_API_KEY is not configured");
  });

  // Bug 1 end to end: a 202 must not be reported as an empty web.
  it("reports a rate-limited fallback as blocked, not as an empty web", async () => {
    stubFetch([
      [/serpapi\.com/, () => json({ error: "Your account has run out of searches." })],
      [/duckduckgo/, () => new Response(DDG_ANOMALY_HTML, { status: 202 })],
      [/wikipedia/, () => json({ query: { search: [] } })],
      [/stackexchange/, () => json({ items: [] })],
    ]);
    const logs: string[] = [];
    const out = await runSearch("super bowl", 6, { SERPAPI_API_KEY: "k" }, (m) => logs.push(m));

    expect(out.results).toEqual([]);
    // The primary reason wins: "your quota is gone" is the actionable half.
    expect(out.error).toBe("serpapi_error");
    expect(logs.join(" ")).toContain("ddg_rate_limited");
  });

  it("falls through when SerpApi answers 200 with nothing usable", async () => {
    stubFetch([
      [/serpapi\.com/, () => json({ organic_results: [], answer_box: { title: "x" } })],
      [/duckduckgo/, () => new Response(DDG_RESULTS_HTML, { status: 200 })],
    ]);
    const out = await runSearch("super bowl", 6, { SERPAPI_API_KEY: "k" });
    expect((out.results as Array<{ source: string }>)[0].source).toBe("DuckDuckGo Web");
    expect(out.error).toBe("serpapi_zero_results");
  });

  it("never throws, even when every provider fails hard", async () => {
    stubFetch([[/./, () => new Response("boom", { status: 500 })]]);
    const out = await runSearch("x", 6, { SERPAPI_API_KEY: "k" });
    expect(out.results).toEqual([]);
    expect(typeof out.error).toBe("string");
  });
});
