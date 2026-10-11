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
// TIER ORDER TODAY (2026-10-11, after Tavily was added at the user's direction)
//
//   text    Tavily (key) → SerpApi (key) → Tavily (keyless) → DuckDuckGo → Wikipedia+SE
//   images  Tavily (key or keyless) ‖ SerpApi (key), merged — see runImageSearch
//
// Tavily took the primary slot because of what it returns, not because of a preference:
// a synthesised `answer`, `follow_up_questions` that map onto the chips the UI already
// renders, real page excerpts in `content` rather than SERP meta-descriptions, and a
// documented keyless mode. The keyless tiers are all still here, in the order measured:
// Tavily keyless is a full web index, DuckDuckGo is a scrape of one, and Wikipedia plus
// Stack Exchange are narrow indexes — which is why only the last pair sets `degraded`.
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

// Bounded fetch so one hung provider can't hang the route (and the dev proxy).
function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

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

// Decode THEN strip: strip-then-decode lets `&lt;img onerror=&gt;` survive the
// strip (no literal <) and become a real tag via decode — an XSS vector if a
// client renders snippets as HTML.
const clean = (s) => stripTags(decodeEntities(s));

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

// ── Tavily (primary; a key is optional, keyless mode is first-party) ──────
//
// Added 2026-10-11 at the user's direction ("tavily ... is 100x better than serpapi"),
// and the shape of what it returns is why it took the primary slot rather than a
// fallback slot:
//
//   • `answer` — a synthesised answer to the question, not just ten links. That is
//     spec §4's "synthesis" arriving as a field instead of as a second model call.
//   • `follow_up_questions` — maps straight onto the follow-up chips the UI already
//     renders from SerpApi's `related_questions`.
//   • `results[].content` — a real excerpt of the page, not a meta-description
//     scraped from a SERP. `snippet` is what the model grounds on.
//   • IMPORTANT: a documented KEYLESS mode. `X-Tavily-Access-Mode: keyless` answers
//     without any credential at all (measured 2026-10-11: three results and five
//     images for "Lenovo G500 laptop", no key sent). This is the first keyless
//     provider in this file that returns *search results* rather than encyclopedia
//     rows — see the tier order in runSearch for what that changes.
//
// It does NOT replace the keyless tail. Keyless mode is a documented convenience, not
// a contract with a rate limit I can see, so DuckDuckGo/Wikipedia/Stack Exchange stay
// behind it: if Tavily keyless ever stops answering, the route degrades to exactly
// what it had before rather than to an error.

const TAVILY_URL = "https://api.tavily.com/search";

export function tavilyKey(env) {
  // Server-side only. A VITE_-prefixed name is inlined into the browser bundle, which
  // is why no key in this file uses one — the VITE_ spellings are read here only
  // because older .env files carry them (same reason serpApiKey accepts them).
  return env.TAVILY_API_KEY || env.VITE_TAVILY_API_KEY || "";
}

/**
 * Auth for a Tavily call: the key when there is one, keyless mode when there is not.
 *
 * Keyless is not "no auth" — the header is what tells Tavily to accept the request, and
 * a keyless request that omits it answers 401. The measurement above is of the header
 * being sent, not of it being optional.
 */
function tavilyInit(key, body) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : { "X-Tavily-Access-Mode": "keyless" }),
    },
    body: JSON.stringify(body),
  };
}

/** Host of an absolute URL, `www.` stripped; null when it is not a URL. */
export function hostOf(u) {
  try {
    return new URL(String(u)).host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 * Never throws — same contract as the other providers, so a Tavily outage degrades the
 * tier chain instead of taking the route down.
 */
export async function searchTavily(query, num, key) {
  try {
    const res = await fetchWithTimeout(
      TAVILY_URL,
      tavilyInit(key, {
        query,
        // `basic` measured at 0.6-1.2s against 5.99s for `advanced`, for the same top
        // three results on this query. The turn's own budget is what that time comes
        // out of, and depth is the wrong thing to spend it on.
        search_depth: "basic",
        // Ask for more than `condense` keeps (it defaults to 6), so merging and
        // deduplication have spare rows to work with rather than exactly the right count.
        max_results: clampNum(num) + 2,
        include_answer: true,
        // Images are a separate tier with its own rules (never generated, always
        // attributed). Fetching them here would pay for them on every text search.
        include_images: false,
      }),
    );
    if (!res.ok) return { ok: false, reason: `tavily_http_${res.status}` };
    const data = await res.json();
    if (data.error) return { ok: false, reason: "tavily_error" };

    const results = condense(
      (data.results || []).map((r) => ({
        title: r.title || "",
        // `content` is the page excerpt Tavily retrieved; a row without one still has a
        // title and a link, which is what condense() keeps rows on.
        snippet: r.content || r.raw_content?.slice(0, 600) || "",
        link: r.url || "",
        source: hostOf(r.url),
        date: r.published_date || null,
      })),
    );

    const answerBox = data.answer ? { title: "Answer", answer: data.answer } : null;
    const related = (data.follow_up_questions || []).filter(Boolean).slice(0, 4);

    if (!results.length && !answerBox?.answer) return { ok: false, reason: "tavily_zero_results" };
    return { ok: true, payload: { query, answerBox, results, related } };
  } catch {
    return { ok: false, reason: "tavily_fetch_failed" };
  }
}

/**
 * Tavily's image tier.
 *
 * Two things measured before it was wired in, because both change what the gallery can
 * promise (2026-10-11, "Lenovo G500 laptop"):
 *
 *   • It returns FIVE images and no more. `max_images` and `image_count` are accepted
 *     and ignored (three probes, five images each), and `max_results: 10` does not move
 *     it either. So Tavily is a *supplement* to SerpApi's twelve, not a replacement:
 *     the merged tier keeps SerpApi's rows to fill the grid.
 *
 *   • Each row is `{url, title, description}` when `include_image_descriptions` is set
 *     (which it is below) and a bare URL string when it is not — the flag decides the
 *     shape, not the credential. There is no thumbnail and no source page either way,
 *     and `title`/`description` are frequently null. Four of the five URLs served 206
 *     image/jpeg and one answered 403 (a hotlinking host) — the same rate and the same
 *     host that blocked SerpApi's `original`, which is why the lightbox already falls
 *     back to the thumbnail and the tile already falls back to a source-preserving link.
 *     Rows from here carry `thumbnailUrl === imageUrl` because there is no smaller image
 *     to offer; the UI treats "no source page" as no link rather than as a link to "#".
 */
export async function searchTavilyImages(query, num, key) {
  try {
    const res = await fetchWithTimeout(
      TAVILY_URL,
      tavilyInit(key, {
        query,
        search_depth: "basic",
        max_results: clampImages(num),
        include_images: true,
        include_image_descriptions: true,
      }),
    );
    if (!res.ok) return { ok: false, reason: `tavily_images_http_${res.status}` };
    const data = await res.json();
    if (data.error) return { ok: false, reason: "tavily_images_error" };

    // The row SHAPE follows `include_image_descriptions`, not the credential. Measured
    // 2026-10-11 by calling the same body twice with and without the flag, both keyed and
    // keyless: with it, `images` is `[{url, title, description}]`; without it, `images` is
    // `["<url>", ...]`. All four combinations are otherwise identical, down to the same
    // five URLs. So the bare-string branch below is not a keyless fallback — it is what
    // this endpoint returns when someone drops the flag, which reads as a trivial edit.
    // Accepting both is what keeps that edit from silently emptying the gallery.
    const rows = (data.images || []).map((img) => {
      const url = safeHttpUrl(typeof img === "string" ? img : img?.url);
      return {
        title: typeof img === "string" ? "" : img?.title || img?.description || "",
        imageUrl: url,
        thumbnailUrl: url,
        // Deliberately empty, not guessed. Tavily does not say which page an image was
        // found on, and inventing one (the first result's URL, say) would be a made-up
        // attribution on a real picture.
        pageUrl: "",
        source: hostOf(url),
        width: null,
        height: null,
      };
    });

    const images = condenseImages(rows);
    if (!images.length) return { ok: false, reason: "tavily_images_zero_results" };
    return { ok: true, payload: { query, images } };
  } catch {
    return { ok: false, reason: "tavily_images_fetch_failed" };
  }
}

// ── SerpApi (secondary for text; the rich half of the image tier) ──────────

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
    const res = await fetchWithTimeout(`https://serpapi.com/search.json?${params}`);
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

// ── Image search (SerpApi google_images; needs a key) ──────────────────────

/**
 * Allow only http(s) URLs through. Every field that becomes an `src` or `href` in
 * the gallery passes this first.
 *
 * The rows come from a third-party index, i.e. from content the app did not write,
 * so a `javascript:` thumbnail is a string that would execute if it reached an
 * `<img src>` or an anchor `href` unchecked. `data:` is refused for the same reason
 * plus payload smuggling. The refusal is a drop, not a rewrite: a row whose image is
 * not a real http(s) URL is not shown at all.
 */
export function safeHttpUrl(u) {
  const s = String(u ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

const clampImages = (num) => Math.min(Math.max(Number(num) || 12, 1), 20);

/**
 * Normalise one `images_results` row, keeping the provider's own URLs.
 *
 * `imageUrl` (the full `original`) and `thumbnailUrl` are deliberately distinct: the
 * grid loads the thumbnail, which is small and the cheapest thing to serve, and the
 * lightbox opens the original. Neither is constructed or guessed — a row with no
 * provider image is dropped, never backfilled with a placeholder, because a
 * substituted image is a fabricated result (spec §5.3, Test H).
 */
function imageRow(r) {
  return {
    title: r.title || "",
    imageUrl: safeHttpUrl(r.original),
    thumbnailUrl: safeHttpUrl(r.thumbnail),
    pageUrl: safeHttpUrl(r.link),
    source: r.source || null,
    width: r.original_width || r.thumbnail_width || null,
    height: r.original_height || r.thumbnail_height || null,
  };
}

/**
 * Drop images with no real thumbnail (unrenderable in a grid) and images repeating
 * one already kept. Deduplication is by image identity — the full URL when present,
 * otherwise the thumbnail — because a search legitimately returns the same picture
 * from several pages and a gallery showing it five times looks broken.
 */
export function condenseImages(rows, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || !r.thumbnailUrl) continue;
    const key = r.imageUrl || r.thumbnailUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 * Never throws, same contract as searchSerpApi: the route degrades, it does not 500.
 */
export async function searchSerpApiImages(query, num, key) {
  try {
    const params = new URLSearchParams({
      engine: "google_images",
      q: query,
      num: String(clampImages(num)),
      api_key: key,
    });
    const res = await fetchWithTimeout(`https://serpapi.com/search.json?${params}`);
    if (!res.ok) return { ok: false, reason: `serpapi_images_http_${res.status}` };
    const data = await res.json();
    if (data.error) return { ok: false, reason: "serpapi_images_error" };

    const images = condenseImages((data.images_results || []).map(imageRow));
    // A 200 carrying no usable image is a failure to find, not an empty gallery that
    // renders as a blank panel.
    if (!images.length) return { ok: false, reason: "serpapi_images_zero_results" };
    return { ok: true, payload: { query, images } };
  } catch {
    return { ok: false, reason: "serpapi_images_fetch_failed" };
  }
}

/**
 * The image-search chain: Tavily first, SerpApi to fill the grid.
 *
 * Neither replaces the other, and that is measured rather than assumed. SerpApi's
 * google_images returns twelve rows with cached thumbnails, dimensions and a source
 * page per image; Tavily returns five, with a title but no thumbnail and no source
 * page. Five hotlinked originals is not a better gallery than twelve attributed
 * thumbnails, and twelve Google images is what the feature was built to show. So the
 * merged set is Tavily's rows first (its titles and its relevance) topped up with
 * SerpApi's, deduplicated by image URL, capped at the requested count.
 *
 * The important consequence: image search now WORKS WITH NO KEY AT ALL, through
 * Tavily's keyless mode. It used to be the one feature that hard-required a credential
 * — and the correct behaviour when no provider can answer is still a named error the
 * UI turns into a capability message, never an empty gallery and never a generated
 * picture standing in for a found one.
 */
export async function runImageSearch(query, num, env, log = () => {}) {
  const tavily = tavilyKey(env);
  const serp = serpApiKey(env);
  const limit = clampImages(num);

  // `null`, not a synthesised failure, when SerpApi has no key. The distinction is the
  // whole point of this shape: a provider that was never configured has not failed, and
  // the `loss` list below treats the two differently. The first version substituted
  // `{ok:false, reason:"serpapi_key_missing"}` here and every keyless install — which is
  // what a fresh clone is — got `degraded: true` and `error: "serpapi:serpapi_key_missing"`
  // on a gallery that was exactly as complete as that install could make it. Same
  // conflation runSearch was fixed for one function up, and it survived here.
  const [t, s] = await Promise.all([
    searchTavilyImages(query, limit, tavily),
    serp ? searchSerpApiImages(query, limit, serp) : Promise.resolve(null),
  ]);

  const images = condenseImages([...(t.ok ? t.payload.images : []), ...(s?.ok ? s.payload.images : [])], limit);
  if (images.length) {
    // A degraded tier reports itself alongside its rows rather than instead of them —
    // the same pairing web_search uses, and the reason is the same: the pictures are
    // real and usable, and the UI should still be able to say the richer source was
    // unavailable rather than implying the smaller set was all there was.
    const loss = [t.ok ? null : `tavily:${t.reason}`, s && !s.ok ? `serpapi:${s.reason}` : null].filter(Boolean);
    return { query, images, ...(loss.length ? { degraded: true, error: loss.join(",") } : {}) };
  }

  const reason = t.reason || s?.reason || "image_search_unavailable";
  log(
    `[images] no provider could answer (tavily: ${t.ok ? "ok" : t.reason}; ` +
      `serpapi: ${s ? (s.ok ? "ok" : s.reason) : "no key"}). ` +
      `Set TAVILY_API_KEY or SERPAPI_API_KEY to search images.`,
  );
  return { query, images: [], error: reason };
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
    const res = await fetchWithTimeout("https://lite.duckduckgo.com/lite/", {
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
    const res = await fetchWithTimeout(`https://en.wikipedia.org/w/api.php?${params}`, {
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
    const res = await fetchWithTimeout(`https://api.stackexchange.com/2.3/search/advanced?${params}`);
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
 * Always resolves to a payload, never throws, and always explains itself: when nothing
 * worked the payload carries `error` with the reason from the *first configured*
 * provider, because "your Tavily key is rejected" is the actionable half and "the
 * keyless tail is also thin" is not.
 *
 * @param {(msg: string) => void} [log] optional sink for one line per failed tier
 */
export async function runSearch(query, num, env, log = () => {}) {
  const tavily = tavilyKey(env);
  const serp = serpApiKey(env);
  // Two different facts that used to share one field, and the difference matters to
  // whoever reads the reply:
  //
  //   `error`    — why the primary engine was not the one that answered. Set only when
  //                a credential was present and the call still failed. A missing key is
  //                a deployment fact, not an answer the user has to hedge about.
  //   `degraded` — the rows themselves are from a narrower index (Wikipedia, Stack
  //                Exchange) rather than a web index. Tavily keyless and DuckDuckGo are
  //                both full-web, so neither is degraded; they are just differently
  //                credentialed.
  //
  // Conflating them is how a keyless install ends up telling users its perfectly good
  // results "may be incomplete" while a real outage goes unmentioned.
  let failure = null;

  // Keyed Tavily only when there is a key. Calling it unconditionally would make every
  // search on a SerpApi-only install start with a keyless request to a provider whose
  // key was deliberately not set — the keyless tier is a documented convenience, and an
  // install that configured a paying provider means it.
  if (tavily) {
    const t = await searchTavily(query, num, tavily);
    if (t.ok) return t.payload;
    failure = t.reason;
    log(`[search] Tavily unavailable (${t.reason}) — trying SerpApi.`);
  } else {
    log("[search] TAVILY_API_KEY is not configured — trying SerpApi.");
  }

  if (serp) {
    const s = await searchSerpApi(query, num, serp);
    if (s.ok) return { ...s.payload, error: failure ?? undefined };
    log(`[search] SerpApi unavailable (${s.reason}) — trying the keyless tail.`);
    failure = failure ?? s.reason;
  } else {
    log("[search] SERPAPI_API_KEY is not configured — running on keyless providers only.");
  }

  // Keyless Tavily is a real web index rather than a scrape, so it goes before the
  // scrapers. Its own failures are logged but never overwrite `failure`: a missing key
  // is the interesting half, not "the unkeyed retry also had a bad day".
  const keyless = await searchTavily(query, num, "");
  if (keyless.ok) return { ...keyless.payload, error: failure ?? undefined };
  log(`[search] Tavily keyless unavailable (${keyless.reason}) — falling back to the scrapers.`);

  const ddg = await searchDuckDuckGo(query);
  if (ddg.ok) return { ...ddg.payload, error: failure ?? undefined };
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
      error: failure ?? undefined,
      degraded: true,
    };
  }

  return {
    query,
    answerBox: null,
    results: [],
    related: [],
    error: failure || ddg.reason || "no_results",
  };
}
