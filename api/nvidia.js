// Vercel serverless function: POST /api/nvidia
// Streams a NVIDIA NIM chat completion (SSE) so the API key stays server-side.
// Set VITE_NVIDIA_API_KEY or NVIDIA_API_KEY in the Vercel project env.

import { applyGuard } from "./_guard.js";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key = req.headers["x-nvidia-api-key"] || req.headers["x-api-key"] || req.headers["authorization"]?.split(" ")[1] || process.env.VITE_NVIDIA_API_KEY || process.env.NVIDIA_API_KEY;
  if (!key) {
    res.status(500).json({ error: "NVIDIA_API_KEY is not configured" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, model, temperature, top_p, max_tokens } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  const requestedModel = model || "meta/llama-3.1-70b-instruct";
  const candidateModels = [
    requestedModel,
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "nvidia/llama-3.3-nemotron-super-49b-v1",
    "stepfun-ai/step-3.7-flash"
  ];
  // Deduplicate preserving order
  const modelsToTry = [...new Set(candidateModels)];

  let upstream = null;
  for (const mId of modelsToTry) {
    try {
      upstream = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: mId,
          messages,
          stream: true,
          temperature: temperature ?? 0.7,
          top_p: top_p ?? 0.95,
          max_tokens: max_tokens ?? 2048,
        }),
      });

      if (upstream.ok && upstream.body) {
        break;
      }
      console.warn(`NVIDIA NIM model ${mId} returned status ${upstream.status}, trying fallback...`);
    } catch (e) {
      console.warn(`NVIDIA NIM model ${mId} fetch failed:`, e);
    }
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("NVIDIA upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({ error: "nvidia_upstream_error", status: upstream.status });
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
