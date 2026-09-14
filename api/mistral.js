// Vercel serverless function: POST /api/mistral
// Streams a Mistral chat completion (SSE) so the API key stays server-side.
// Set MISTRAL_API_KEY in the Vercel project env (see `vercel env add`).

import { applyGuard } from "./_guard.js";
import { applyMeter } from "./_meter.js";
import { sanitiseMessages } from "./_messages.js";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

function header(req, name) {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw || undefined;
}

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Never read `authorization`: Firebase ID token for identity, not a key.
  const key = header(req, "x-mistral-api-key") || header(req, "x-api-key") || process.env.MISTRAL_API_KEY || process.env.VITE_MISTRAL_API_KEY;
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, model, temperature, top_p, max_tokens } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  const requestedModel = model || "mistral-large-2512";

  // Meter AFTER validation so 405/400s never burn quota.
  if (await applyMeter(req, res, { byokHeaders: ["x-mistral-api-key", "x-api-key"] })) return;

  // Attempt Mistral API if key is available
  if (key) {
    // Empty assistant turns 400 (code 3240) and stop the chain — strip them.
    const { messages: cleanMessages } = sanitiseMessages(messages);
    const safeMaxTokens = Math.min(Math.max(Number(max_tokens) || 2048, 1), 8192);
    const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
    const BACKOFF_MS = [600, 1500];
    const fetchWithTimeout = (url, opts, ms = 25000) => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
    };
    let upstream = null;
    let lastStatus = 0;
    let lastDetail = "";
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      try {
        upstream = await fetchWithTimeout(MISTRAL_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: requestedModel,
            messages: cleanMessages,
            stream: true,
            temperature: temperature ?? 0.7,
            top_p: top_p ?? 0.95,
            max_tokens: safeMaxTokens,
          }),
        });
      } catch (err) {
        lastStatus = 502;
        lastDetail = String(err).slice(0, 300);
        upstream = null;
      }
      if (upstream && upstream.ok && upstream.body) break;
      if (upstream) {
        lastStatus = upstream.status;
        lastDetail = (await upstream.text().catch(() => "")).slice(0, 300);
        if (!RETRY_STATUSES.has(upstream.status)) break;
        upstream = null;
      }
      if (attempt < BACKOFF_MS.length) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }
    try {
      if (upstream && upstream.ok && upstream.body) {
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const reader = upstream.body.getReader();
        try { req.on?.("close", () => reader.cancel().catch(() => {})); } catch { /* ignore */ }
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
        return;
      }
      console.error("Mistral upstream error:", lastStatus, lastDetail);
      res.status(lastStatus || 502).json({ error: "mistral_upstream_error", model: requestedModel, status: lastStatus, detail: lastDetail });
      return;
    } catch (err) {
      console.error("Mistral upstream fetch failed:", err);
      res.status(502).json({ error: "mistral_upstream_error", model: requestedModel, detail: String(err).slice(0, 300) });
      return;
    }
  }

  res.status(500).json({ error: "MISTRAL_API_KEY is not configured" });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
