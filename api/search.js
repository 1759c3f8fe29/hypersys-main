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
import { runSearch } from "./_search-providers.js";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  // SerpApi searches are metered per call against our plan, and the keyless
  // providers rate limit by IP — an unmetered search route is worth abusing, and
  // abusing it is also what gets our IP blocked on the fallbacks. Callers are
  // attributed and counted.
  if (await applyMeter(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { query, num } = body;
  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "`query` string is required" });
    return;
  }

  const payload = await runSearch(query, num, process.env, (msg) => console.warn(msg));

  // Cache only a real answer. Caching a failure would pin a transient rate limit in
  // front of every user of that query for five minutes.
  if (payload.results.length || payload.answerBox?.answer) {
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
