// Vercel serverless function: POST /api/nvidia
// Streams a NVIDIA NIM chat completion (SSE) so the API key stays server-side.
// Set VITE_NVIDIA_API_KEY or NVIDIA_API_KEY in the Vercel project env.

import { applyGuard } from "./_guard.js";
import { applyMeter } from "./_meter.js";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  // Spends our NVIDIA key, so the caller is attributed and counted first.
  // A caller on their own key is exempt — they are spending their allowance.
  if (await applyMeter(req, res, { byokHeaders: ["x-nvidia-api-key", "x-api-key"] })) return;
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

  if (!model) {
    res.status(400).json({ error: "`model` is required" });
    return;
  }

  // Serve exactly the model that was asked for. Substituting a different model
  // on failure used to mask outages and answer with the wrong model entirely.
  //
  // NIM answers 529 "Service temporarily overloaded" (and occasionally 429/503)
  // when a popular model's pool is saturated — the model exists and works, the
  // gateway is just busy. These are transient, so retry with backoff before
  // giving up; a single attempt made working models look permanently broken.
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
  const BACKOFF_MS = [600, 1500, 3000];

  let upstream = null;
  let lastStatus = 0;
  let lastDetail = "";

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      upstream = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: temperature ?? 0.7,
          top_p: top_p ?? 0.95,
          max_tokens: max_tokens ?? 2048,
        }),
      });
    } catch (e) {
      console.error(`NVIDIA NIM model ${model} fetch failed (attempt ${attempt + 1}):`, e);
      upstream = null;
      lastStatus = 502;
      lastDetail = String(e);
    }

    if (upstream && upstream.ok && upstream.body) break;

    if (upstream) {
      lastStatus = upstream.status;
      lastDetail = await upstream.text().catch(() => "");
      // A real "model not found" / bad request must not be retried.
      if (!RETRY_STATUSES.has(upstream.status)) break;
      upstream = null;
    }

    if (attempt < BACKOFF_MS.length) {
      console.warn(`NVIDIA NIM ${model} returned ${lastStatus}; retrying in ${BACKOFF_MS[attempt]}ms`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    console.error("NVIDIA upstream error:", lastStatus, lastDetail);
    const overloaded = lastStatus === 529 || lastStatus === 429;
    res.status(lastStatus || 502).json({
      error: overloaded ? "nvidia_model_overloaded" : "nvidia_upstream_error",
      model,
      status: lastStatus,
      detail: overloaded
        ? `${model} is temporarily overloaded on NVIDIA NIM (HTTP ${lastStatus}). It is available again shortly — retry, or pick another model.`
        : lastDetail,
    });
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
