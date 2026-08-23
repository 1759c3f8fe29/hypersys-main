// ---------------------------------------------------------------------------
// Search providers, shared by the serverless route and the dev proxy
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS
//
// The SerpApi call, the DuckDuckGo scraper and the result-merging logic were written
// twice: once in api/search.js for production and once inline in vite.config.ts for
// `npm run dev`. Both copies carried comments saying "Mirrors api/search.js", which
// is a drift warning written by someone who knew the duplication was a problem. They
// had already drifted (the dev copy quoted class attributes differently), and a fix
// applied to one would have silently missed the other.
//
// IMPORT BOUNDARY — read before adding anything here
//
// This module is imported by api/search.js (Node, serverless) and by vite.config.ts
// (Node, build time). It must NEVER be imported from anything under src/, because
// that would pull it into the browser bundle. It has no dependencies for the same
// reason api/_failover.js has none: an import here that reaches _meter.js or
// _auth.js would drag JWT verification and Redis quota code toward the client.
//
// WHAT WAS ACTUALLY WRONG WITH SEARCH (all measured, 2026-08-22)
//
//   • SerpApi works, on the free plan, with 198 of 250 searches left for the month.
//     So search "works" right now and stops working the moment that runs out.
//
//   • DuckDuckGo lite — the only fallback, and the only backend that needs no key —
//     returns HTTP 202 and an anti-bot "anomaly" page. The `result-link` class the
//     parser looks for is absent from that page, so it yields zero results.
//
//     It is rate limiting by IP, not a layout change and not a missing header. One
//     cold request returned HTTP 200 with six parseable results; after a handful of
//     probes every request returned 202, including a byte-identical curl repeat of
//     the one that had just succeeded, and including full browser header sets with
//     Origin, Referer, Sec-Fetch-* and Upgrade-Insecure-Requests. Header shape made
//     no difference in either direction. That matters for the conclusion: on Vercel
//     the outbound IP is shared with every other tenant, so DDG there is not
//     "occasionally rate limited", it is effectively always rate limited.
//
//   • HTTP 202 passes `res.ok`, which is true for anything 200-299. The old
//     `if (!res.ok) return null` therefore accepted the challenge page and parsed it,
//     turning "we are blocked" into "the web has nothing on this" — the exact
//     conflation the error codes in this file exist to prevent.
//
//   • The answerBox could be `{title: null, answer: null}`: a truthy object carrying
//     nothing, produced when SerpApi returned a knowledge_graph or sports_results
//     block with none of the fields we read off it. Verified against the live
//     deployment, which returned exactly that for "who won the 2026 super bowl".
//
// So the fallback tier is now two real JSON APIs that were tested and answered,
// rather than one scraper that cannot. Wikipedia and Stack Exchange are keyless,
// have stable documented shapes, and do not rate limit a single query per turn. They
// are a narrower index than Google and that is the honest tradeoff: an install with
// no SerpApi key gets encyclopedic and programming coverage instead of nothing.
//
// NO QUERY CLASSIFIER, DELIBERATELY
//
// The obvious move is a regex deciding "this looks like a programming question, ask
// Stack Exchange". src/lib/search.ts records that this codebase already had exactly
// that (`evaluateSmartWebSearch`, `shouldWebSearch`) and deleted it in Phase 6,
// because a regex "could only ever guess from the wording". Re-adding one here would
// undo that decision in a new place. The fallback tier queries both, labels every row
// with the source it came from, and lets the model judge relevance. It sees
// `source: "Stack Overflow"` next to an irrelevant row and ignores it.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const clampNum = (num) => Math.min(Math.max(Number(num) || 5, 1), 10);

// ── shared text helpers ────────────────────────────────────────────────────

export function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const clean = (s) => decodeEntities(stripTags(s));

/**
 * Drop rows with no usable content and rows repeating a link already seen.
 *
 * Deduplication is by URL across the *whole* merged set, which is why merging
 * happens here rather than at each provider: the same article legitimately appears
 * in SerpApi's news block and its organic block, and once results from two providers
 * are concatenated the same page can arrive from both.
 */
export function condense(rows, limit = 6) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || !r.title) continue;
    if (!r.snippet && !r.link) continue;
    if (r.link) {
      if (seen.has(r.link)) continue;
      seen.add(r.link);
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build an answerBox, or null.
 *
 * Returns null rather than an object whose fields are both null. A caller writing
 * `if (search.answerBox)` is asking "is there a featured answer", and an object with
 * no answer in it makes that check lie. `buildSearchContext` in src/lib/search.ts
 * happens to read `answerBox?.answer` and survives, but that is the caller being
 * careful about a shape that should never have been produced.
 */
export function toAnswerBox(raw, overview) {
  if (raw) {
    const title = raw.title || raw.name || null;
    const answer = raw.answer || raw.snippet || raw.description || null;
    if (answer) return { title, answer };
  }
  if (overview) return { title: "AI Overview", answer: overview };
  return null;
}

// ── SerpApi (primary; needs a key) ─────────────────────────────────────────

export function serpApiKey(env) {
  return env.SERPAPI_API_KEY || env.VITE_SERP_API_KEY || env.VITE_SERPAPI_API_KEY || "";
}

/**
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 * Never throws: the caller's job is to try the next provider, and an exception
 * escaping here would take down the whole route instead of degrading it.
 */
export async function searchSerpApi(query, num, key) {
  try {
    const params = new URLSearchParams({
      engine: "google",
      q: query,
      num: String(clampNum(num)),
      api_key: key,
    });
    const res = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!res.ok) {
      // Surface the real reason (bad key, quota exhausted, rate limit) rather than
      // falling through silently to an empty result set, which reads to the model
      // as "the web has nothing on this".
      return { ok: false, reason: `serpapi_http_${res.status}` };
    }
    const data = await res.json();
    if (data.error) return { ok: false, reason: "serpapi_error" };

    const map = (rows, snippetKey = "snippet") =>
      (rows || []).map((r) => ({
        title: r.title || "",
        snippet: r[snippetKey] || r.snippet || "",
        link: r.link || "",
        source: r.source || null,
        date: r.date || null,
      }));

    // News and top stories first: for time-sensitive queries these carry the fresh,
    // dated items, while organic results skew toward evergreen pages.
    const results = condense([
      ...map(data.news_results),
      ...map(data.top_stories, "original_snippet"),
      ...map(data.organic_results),
    ]);

    const answerBox = toAnswerBox(
      data.answer_box || data.knowledge_graph || data.sports_results,
      data.ai_overview?.text_blocks?.map((b) => b.snippet).filter(Boolean).join(" "),
    );

    const related = [
      ...(data.related_questions || []).map((q) => q.question),
      ...(data.related_searches || []).map((r) => r.query),
    ]
      .filter(Boolean)
      .slice(0, 4);

    // A 200 carrying nothing usable must fall through to the next provider instead
    // of reporting success with no results.
    if (!results.length && !answerBox?.answer) return { ok: false, reason: "serpapi_zero_results" };
    return { ok: true, payload: { query, answerBox, results, related } };
  } catch {
    return { ok: false, reason: "serpapi_fetch_failed" };
  }
}

// ── DuckDuckGo lite (opportunistic; no key) ────────────────────────────────

/**
 * The lite layout is a flat <table> of rows: a result-link anchor, then a
 * result-snippet cell. Pair them up positionally rather than by container.
 *
 * Exported for the unit test, which runs it against a saved copy of both a real
 * results page and an anomaly page — the second one being the case that used to be
 * parsed as if it were the first.
 */
export function parseDuckDuckGoLite(html, limit = 6) {
  const linkRe = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;

  const snippets = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) snippets.push(clean(m[1]));

  const results = [];
  let i = 0;
  for (let m = linkRe.exec(html); m && results.length < limit; m = linkRe.exec(html), i++) {
    const link = resolveDuckDuckGoLink(m[1]);
    const title = clean(m[2]);
    if (!title || !link) continue;
    results.push({ title, snippet: snippets[i] || "", link, source: "DuckDuckGo Web", date: null });
  }
  return results;
}

// Lite sometimes links straight out and sometimes via /l/?uddg=<encoded>.
function resolveDuckDuckGoLink(raw) {
  const href = decodeEntities(raw);
  const redirect = href.match(/[?&]uddg=([^&]+)/);
  if (redirect) {
    try {
      return decodeURIComponent(redirect[1]);
    } catch {
      return "";
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href.startsWith("http") ? href : "";
}

/** Is this the anti-bot interstitial rather than a results page? */
export function isDuckDuckGoBlock(status, html) {
  // 202 is the tell and it is why this check exists: `res.ok` is true for 202, so
  // the old code accepted the challenge page and parsed zero results out of it.
  if (status === 202) return true;
  return /anomaly|captcha|unusual traffic/i.test(html) && !/class=['"]result-link['"]/.test(html);
}

export async function searchDuckDuckGo(query) {
  try {
    // A form POST rather than a GET: the GET endpoint answers with the anomaly page
    // unconditionally, so the query goes in the body.
    const res = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ q: query }).toString(),
    });
    const html = await res.text();
    if (isDuckDuckGoBlock(res.status, html)) return { ok: false, reason: "ddg_rate_limited" };
    if (!res.ok) return { ok: false, reason: `ddg_http_${res.status}` };

    const results = parseDuckDuckGoLite(html);
    if (!results.length) {
      // Reached a real page and found no rows in it. Distinct from being blocked,
      // and the distinction is the point: this one means the layout changed.
      return { ok: false, reason: "ddg_no_results" };
    }
    return {
      ok: true,
      payload: {
        query,
        answerBox: results[0].snippet ? { title: "Web Summary", answer: results[0].snippet } : null,
        results,
        related: [],
      },
    };
  } catch {
    return { ok: false, reason: "ddg_fetch_failed" };
  }
}

// ── Wikipedia (keyless, stable, encyclopedic) ──────────────────────────────

export async function searchWikipedia(query, limit = 4) {
  try {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      format: "json",
      srlimit: String(limit),
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { "User-Agent": "Flyer/1.0 (chat assistant; web search fallback)" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.query?.search || []).map((s) => ({
      title: s.title,
      // The API wraps matched terms in <span class="searchmatch">, so this needs
      // stripping even though it is a JSON field rather than a scraped page.
      snippet: clean(s.snippet),
      link: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`,
      source: "Wikipedia",
      date: s.timestamp || null,
    }));
  } catch {
    return [];
  }
}

// ── Stack Exchange (keyless, stable, programming) ──────────────────────────

export async function searchStackExchange(query, limit = 3) {
  // Stack Exchange's /search/advanced `q` is AND across every term, so a natural
  // question finds nothing. Measured: "typescript debounce hook cancel flush" -> 0
  // items, "typescript debounce hook" -> 3. One retry on the leading words fixes it.
  //
  // Leading words rather than "important" words on purpose: picking important ones
  // means scoring them, which is the query classifier this file's header explains we
  // are not reintroducing. People front-load the terms that matter, and the retry
  // only ever runs when the precise query already returned nothing.
  const first = await stackExchangeQuery(query, limit);
  if (first.length) return first;

  const words = query.trim().split(/\s+/);
  if (words.length <= 3) return [];
  return stackExchangeQuery(words.slice(0, 3).join(" "), limit);
}

async function stackExchangeQuery(query, limit) {
  try {
    const params = new URLSearchParams({
      order: "desc",
      sort: "relevance",
      q: query,
      site: "stackoverflow",
      pagesize: String(limit),
      filter: "withbody",
    });
    const res = await fetch(`https://api.stackexchange.com/2.3/search/advanced?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map((it) => ({
      title: clean(it.title),
      // `body` is full HTML for an entire answer. Truncated hard: this is grounding
      // context inside a system message, not a document to render.
      snippet: clean(it.body).slice(0, 400),
      link: it.link,
      source: `Stack Overflow${it.is_answered ? " (answered)" : ""}`,
      date: it.creation_date ? new Date(it.creation_date * 1000).toISOString().slice(0, 10) : null,
    }));
  } catch {
    return [];
  }
}

// ── the chain ──────────────────────────────────────────────────────────────

/**
 * Try every provider in order and return the first usable answer.
 *
 * Always resolves to a payload, never throws, and always explains itself: when
 * nothing worked the payload carries `error` with the reason from the *primary*
 * provider, because "your SerpApi quota is gone" is the actionable half and
 * "the keyless fallbacks are also thin" is not.
 *
 * @param {(msg: string) => void} [log] optional sink for one line per failed tier
 */
export async function runSearch(query, num, env, log = () => {}) {
  const key = serpApiKey(env);
  let primaryReason = null;

  if (key) {
    const serp = await searchSerpApi(query, num, key);
    if (serp.ok) return serp.payload;
    primaryReason = serp.reason;
    log(`[search] SerpApi unavailable (${serp.reason}) — trying keyless providers.`);
  } else {
    primaryReason = "serpapi_key_missing";
    log("[search] SERPAPI_API_KEY is not configured — running on keyless providers only.");
  }

  const ddg = await searchDuckDuckGo(query);
  if (ddg.ok) return { ...ddg.payload, error: primaryReason ?? undefined };
  log(`[search] DuckDuckGo unavailable (${ddg.reason}).`);

  // Last tier, and the only one that has never failed a probe. Queried in parallel
  // because they are independent and this is already the slow path.
  const [wiki, stack] = await Promise.all([searchWikipedia(query), searchStackExchange(query)]);
  const results = condense([...wiki, ...stack]);
  if (results.length) {
    return {
      query,
      answerBox: null,
      results,
      related: [],
      // Reported even though results were found. The model is told these may be
      // incomplete, which is true: this tier is two narrow indexes, not the web.
      error: primaryReason ?? undefined,
      degraded: true,
    };
  }

  return {
    query,
    answerBox: null,
    results: [],
    related: [],
    error: primaryReason || ddg.reason || "no_results",
  };
}
