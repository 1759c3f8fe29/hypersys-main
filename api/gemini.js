// Vercel serverless function: POST /api/gemini
// Streams a Gemini chat completion (SSE) via the OpenAI-compatible endpoint.

import { applyGuard } from "./_guard.js";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Only the provider-specific BYOK header, then the server env. Deliberately
  // NOT `authorization` — that header now carries the caller's Firebase ID
  // token, so accepting it here would forward a user's auth token to Google as
  // if it were an API key. Nor `x-api-key`, which is provider-agnostic and would
  // let a key meant for one provider be sent to another.
  const key =
    req.headers["x-gemini-api-key"] ||
    process.env.GEMINI_API_KEY ||
    process.env.VITE_GEMINI_API_KEY;
  if (!key || key.startsWith("your-")) {
    res.status(400).json({ error: "Gemini API key is not configured." });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, model, temperature, top_p, max_tokens } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  const upstream = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "gemini-flash-latest",
      messages,
      stream: true,
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.95,
      max_tokens: max_tokens ?? 2048,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("Gemini upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({ error: "gemini_upstream_error", status: upstream.status });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
