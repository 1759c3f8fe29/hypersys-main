// Vercel serverless function: POST /api/pollinations
// Streams a Pollinations AI chat completion (SSE). No API key needed!

import { applyGuard } from "./_guard.js";

const POLLINATIONS_URL = "https://text.pollinations.ai/v1/chat/completions";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, model, temperature, top_p, max_tokens } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  const upstream = await fetch(POLLINATIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "openai",
      messages,
      stream: true,
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.95,
      max_tokens: max_tokens ?? 2048,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("Pollinations upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({ error: "pollinations_upstream_error", status: upstream.status });
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
