#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Which keyless search backends actually answer today?
// ---------------------------------------------------------------------------
//
//   node scripts/probe-search-backends.mjs [query]
//
// The DuckDuckGo lite fallback in api/search.js now returns HTTP 202 and an anomaly
// challenge page: zero results, and the `result-link` class it parses is gone from
// the markup entirely. That fallback is the only backend that works without a key,
// so on any install without SERPAPI_API_KEY — which includes local dev for anyone
// who clones this — web search is dead rather than degraded.
//
// Picking a replacement by reputation is how the current one was picked. This tries
// each candidate against the live internet and reports what came back, so the choice
// is made on today's behaviour instead of on what used to work.
//
// Judge candidates on three things, in this order:
//   1. does it return results at all, unauthenticated, from a datacentre IP
//   2. is the shape stable (a JSON API beats a scraped layout, always)
//   3. does it carry snippets, since a title and a URL alone cannot ground a claim

const query = process.argv.slice(2).join(" ") || "who won the 2026 super bowl";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function verdict(name, note, sample = []) {
  console.log(`\n${name}`);
  console.log(`  ${note}`);
  for (const s of sample.slice(0, 2)) console.log(`    • ${String(s).slice(0, 110)}`);
}

async function get(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...(init.headers || {}) },
  });
  return res;
}

console.log(`query: ${JSON.stringify(query)}`);

// ── 1. DuckDuckGo html endpoint (the sibling of the dead lite one) ──────────
try {
  const res = await get("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
  });
  const html = await res.text();
  const hits = [...html.matchAll(/class="result__a"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => strip(m[1]));
  verdict(
    "ddg /html/",
    `HTTP ${res.status}, ${html.length}B, ${hits.length} titles, challenge=${/anomaly|captcha/i.test(html)}`,
    hits,
  );
} catch (e) {
  verdict("ddg /html/", `failed: ${e.message}`);
}

// ── 2. DuckDuckGo Instant Answer API (official, keyless, JSON) ─────────────
// Stable shape, but historically only answers entity-ish queries; the RelatedTopics
// array is often the only populated field. Worth knowing whether it carries prose.
try {
  const res = await get(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`,
  );
  const j = await res.json();
  const topics = (j.RelatedTopics || []).map((t) => t.Text).filter(Boolean);
  verdict(
    "ddg instant answer (JSON)",
    `HTTP ${res.status}, AbstractText=${j.AbstractText ? j.AbstractText.length + "B" : "empty"}, ` +
      `Answer=${j.Answer ? "yes" : "no"}, RelatedTopics=${topics.length}`,
    [j.AbstractText, ...topics].filter(Boolean),
  );
} catch (e) {
  verdict("ddg instant answer (JSON)", `failed: ${e.message}`);
}

// ── 3. Mojeek (independent index, scraper-tolerant) ────────────────────────
try {
  const res = await get(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`);
  const html = await res.text();
  const titles = [...html.matchAll(/<a[^>]*class="ob"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => strip(m[1]));
  const alt = [...html.matchAll(/<h2><a[^>]*>([\s\S]*?)<\/a><\/h2>/g)].map((m) => strip(m[1]));
  verdict(
    "mojeek",
    `HTTP ${res.status}, ${html.length}B, class="ob"=${titles.length}, h2>a=${alt.length}`,
    titles.length ? titles : alt,
  );
} catch (e) {
  verdict("mojeek", `failed: ${e.message}`);
}

// ── 4. Brave Search, no key, HTML ─────────────────────────────────────────
try {
  const res = await get(`https://search.brave.com/search?q=${encodeURIComponent(query)}`);
  const html = await res.text();
  const titles = [...html.matchAll(/<div class="title"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => strip(m[1]));
  verdict("brave html", `HTTP ${res.status}, ${html.length}B, titles=${titles.length}`, titles);
} catch (e) {
  verdict("brave html", `failed: ${e.message}`);
}

// ── 5. Wikipedia search API (keyless, JSON, encyclopedic only) ────────────
// Not a general web index, so it cannot be the only fallback. Included because it is
// the one backend that will still be up and unblocked in a year, which makes it a
// reasonable last resort for the "what is X" half of queries.
try {
  const res = await get(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5&origin=*`,
  );
  const j = await res.json();
  const hits = (j.query?.search || []).map((s) => `${s.title}: ${strip(s.snippet)}`);
  verdict("wikipedia api (JSON)", `HTTP ${res.status}, ${hits.length} results`, hits);
} catch (e) {
  verdict("wikipedia api (JSON)", `failed: ${e.message}`);
}

// ── 6. Public SearXNG instances with JSON enabled ─────────────────────────
// A SearXNG instance aggregates Google/Bing/etc and can answer JSON directly, which
// would be the ideal fallback shape. Most public instances disable the JSON format
// or rate limit hard, so this checks several and reports which (if any) cooperate.
const SEARX = [
  "https://searx.be",
  "https://search.bus-hit.me",
  "https://priv.au",
  "https://searxng.site",
  "https://search.inetol.net",
];
for (const base of SEARX) {
  try {
    const res = await get(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let hits = [];
    try {
      hits = (JSON.parse(text).results || []).map((r) => `${r.title} — ${(r.content || "").slice(0, 60)}`);
    } catch {
      /* not JSON: the instance served HTML or an error page */
    }
    verdict(
      `searxng ${base}`,
      `HTTP ${res.status}, ${text.length}B, json=${text.trim().startsWith("{")}, results=${hits.length}`,
      hits,
    );
  } catch (e) {
    verdict(`searxng ${base}`, `failed: ${e.message}`);
  }
}
