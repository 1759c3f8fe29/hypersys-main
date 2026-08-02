// Vercel serverless function: POST /api/search
// Runs a SerpApi Google search server-side and returns condensed results.
// Set SERPAPI_API_KEY in the Vercel project env (see `vercel env add`).

import { applyGuard } from "./_guard.js";

const SERPAPI_URL = "https://serpapi.com/search.json";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key = process.env.SERPAPI_API_KEY || process.env.VITE_SERP_API_KEY || process.env.VITE_SERPAPI_API_KEY;
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { query, num } = body;
  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "`query` string is required" });
    return;
  }

  // Attempt SerpApi if API key is present
  let serpError = null;
  if (key) {
    try {
      const params = new URLSearchParams({
        engine: "google",
        q: query,
        num: String(Math.min(Math.max(Number(num) || 5, 1), 10)),
        api_key: key,
      });

      const upstream = await fetch(`${SERPAPI_URL}?${params.toString()}`);
      if (!upstream.ok) {
        // Surface the real reason (bad key, quota exhausted, rate limit) instead
        // of falling through silently and returning an empty result set that
        // looks to the model like "the web has nothing on this".
        serpError = `serpapi_http_${upstream.status}`;
        console.error("SerpApi error:", upstream.status, await upstream.text().catch(() => ""));
      } else {
        const data = await upstream.json();
        if (data.error) {
          serpError = "serpapi_error";
          console.error("SerpApi returned error:", data.error);
        } else {
        const organic = (data.organic_results || []).map((r) => ({
          title: r.title || "",
          snippet: r.snippet || "",
          link: r.link || "",
          source: r.source || null,
          date: r.date || null,
        }));

        const news = (data.news_results || []).map((r) => ({
          title: r.title || "",
          snippet: r.snippet || "",
          link: r.link || "",
          source: r.source || null,
          date: r.date || null,
        }));

        const topStories = (data.top_stories || []).map((r) => ({
          title: r.title || "",
          snippet: r.original_snippet || r.snippet || "",
          link: r.link || "",
          source: r.source || null,
          date: r.date || null,
        }));

        // News and top-stories first: for time-sensitive queries these carry the
        // fresh, dated items, while organic results skew toward evergreen pages.
        const combined = [...news, ...topStories, ...organic];
        const seenLinks = new Set();
        const results = combined.filter((r) => {
          if (!r.title || (!r.snippet && !r.link)) return false;
          if (r.link && seenLinks.has(r.link)) return false;
          if (r.link) seenLinks.add(r.link);
          return true;
        }).slice(0, 6);

        const ab = data.answer_box || data.knowledge_graph || data.sports_results;
        const overview = data.ai_overview?.text_blocks
          ?.map((b) => b.snippet)
          .filter(Boolean)
          .join(" ");
        const answerBox = ab
          ? { title: ab.title || ab.name || null, answer: ab.answer || ab.snippet || ab.description || null }
          : overview
          ? { title: "AI Overview", answer: overview }
          : null;

        const related = [
          ...(data.related_questions || []).map((q) => q.question),
          ...(data.related_searches || []).map((r) => r.query),
        ].filter(Boolean).slice(0, 4);

        res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
        res.status(200).json({ query, answerBox, results, related });
        return;
        }
      }
    } catch (err) {
      serpError = "serpapi_fetch_failed";
      console.warn("SerpApi primary search failed, trying DuckDuckGo fallback:", err);
    }
  } else {
    serpError = "serpapi_key_missing";
    console.error("SERPAPI_API_KEY is not configured — web search cannot ground answers.");
  }

  // Fallback: DuckDuckGo free search (No API Key Required!)
  try {
    const ddgResults = await fetchDuckDuckGoSearch(query);
    if (ddgResults && ddgResults.results.length > 0) {
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
      res.status(200).json(ddgResults);
      return;
    }
  } catch (err) {
    console.error("DuckDuckGo search error:", err);
  }

  // Nothing worked. Report *why* so the client can tell the model "search is
  // broken" rather than "the web returned no results" — those need different
  // answers, and conflating them is what made failures invisible.
  res.status(200).json({ query, answerBox: null, results: [], related: [], error: serpError || "no_results" });
}

<<<<<<< HEAD
// DuckDuckGo's lite endpoint answers a GET with an anti-bot challenge page
// ("anomaly modal") and no results. A form POST still returns real results, so
// the query goes in the body rather than the query string.
async function fetchDuckDuckGoSearch(query) {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const results = parseDuckDuckGoLite(html);
=======
async function fetchDuckDuckGoSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const results = [];
  const blocks = html.split(/class="[^"]*result__body[^"]*"/);

  for (let i = 1; i < blocks.length && results.length < 6; i++) {
    const block = blocks[i];
    const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/) ||
                         block.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const linkMatch = block.match(/href="([^"]*uddg=[^"]*)"/) || block.match(/class="result__url"[^>]*href="([^"]+)"/);

    if (titleMatch) {
      const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
      let link = "";
      if (linkMatch) {
        const rawLink = linkMatch[1];
        if (rawLink.includes("uddg=")) {
          const match = rawLink.match(/uddg=([^&]+)/);
          if (match) link = decodeURIComponent(match[1]);
        } else {
          link = rawLink;
        }
      }
      if (title && (snippet || link)) {
        results.push({ title, snippet, link, source: "DuckDuckGo Web", date: null });
      }
    }
  }
>>>>>>> 18477165c7a8d251af435cbe336ad95a20f49bcf

  return {
    query,
    answerBox: results.length > 0 ? { title: "Web Summary", answer: results[0].snippet } : null,
    results,
    related: [],
  };
}

<<<<<<< HEAD
// The lite layout is a flat <table> of rows: a result-link anchor, then a
// result-snippet cell. Pair them up positionally rather than by container.
export function parseDuckDuckGoLite(html, limit = 6) {
  const linkRe = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;

  const snippets = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(decodeEntities(stripTags(m[1])));
  }

  const results = [];
  let i = 0;
  for (let m = linkRe.exec(html); m && results.length < limit; m = linkRe.exec(html), i++) {
    const link = resolveDuckDuckGoLink(m[1]);
    const title = decodeEntities(stripTags(m[2]));
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
    try { return decodeURIComponent(redirect[1]); } catch { return ""; }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href.startsWith("http") ? href : "";
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

=======
>>>>>>> 18477165c7a8d251af435cbe336ad95a20f49bcf
function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
