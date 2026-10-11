// Vercel serverless function: POST /api/search
//
// Provider chain, result shaping and the failure taxonomy all live in
// ./_search-providers.js, shared with the dev proxy in vite.config.ts so the two
// cannot drift (they had). What remains here is the route: auth, metering, method
// and argument validation, caching, and the response.
//
// Set SERPAPI_API_KEY in the Vercel project env (see `vercel env add`). Without it
// the route still answers, from the keyless providers, and says so in `error`.

import { applyGuard } from "./_guard.js";
import { applyMeter } from "./_meter.js";
import { runImageSearch, runSearch } from "./_search-providers.js";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { query, num } = body;
  // `mode: "images"` routes to the image tier; anything else is a web search. Unknown
  // values fall back to "web" rather than erroring, so a typo degrades instead of
  // 400ing. The two tiers answer with different shapes (`results` vs `images`), which
  // is why the cache check below branches too.
  const mode = body.mode === "images" ? "images" : "web";
  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "`query` string is required" });
    return;
  }
  if (query.length > 500) {
    res.status(400).json({ error: "`query` is too long (max 500 characters)" });
    return;
  }

  // Meter AFTER validation so 405/400s never burn quota.
  if (await applyMeter(req, res)) return;

  const payload =
    mode === "images"
      ? await runImageSearch(query, num, process.env, (msg) => console.warn(msg))
      : await runSearch(query, num, process.env, (msg) => console.warn(msg));

  // Cache only a real answer. Caching a failure would pin a transient rate limit in
  // front of every user of that query for five minutes.
  const answered =
    mode === "images"
      ? Array.isArray(payload.images) && payload.images.length > 0
      : payload.results.length || payload.answerBox?.answer;
  if (answered) {
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  }
  res.status(200).json(payload);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
