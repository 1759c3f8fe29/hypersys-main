// Vercel serverless function: POST /api/mistral
// Streams a Mistral chat completion (SSE) so the API key stays server-side.
// Set MISTRAL_API_KEY in the Vercel project env (see `vercel env add`).

import { applyGuard } from "./_guard.js";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key = req.headers["x-mistral-api-key"] || req.headers["x-api-key"] || req.headers["authorization"]?.split(" ")[1] || process.env.MISTRAL_API_KEY || process.env.VITE_MISTRAL_API_KEY;
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, model, temperature, top_p, max_tokens } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  // Attempt Mistral API if key is available
  if (key) {
    try {
      const upstream = await fetch(MISTRAL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: model || "mistral-large-latest",
          messages,
          stream: true,
          temperature: temperature ?? 0.7,
          top_p: top_p ?? 0.95,
          max_tokens: max_tokens ?? 2048,
        }),
      });

      if (upstream.ok && upstream.body) {
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
        return;
      }
    } catch (err) {
      console.warn("Mistral primary upstream failed, trying NVIDIA NIM fallback:", err);
    }
  }

  // Fallback: Automatic server-side fallback to NVIDIA NIM!
  const nvidiaKey = req.headers["x-nvidia-api-key"] || process.env.VITE_NVIDIA_API_KEY || process.env.NVIDIA_API_KEY;
  if (nvidiaKey) {
    try {
      const nvidiaUpstream = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${nvidiaKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "meta/llama-3.3-70b-instruct",
          messages,
          stream: true,
          temperature: temperature ?? 0.7,
          top_p: top_p ?? 0.95,
          max_tokens: max_tokens ?? 2048,
        }),
      });

      if (nvidiaUpstream.ok && nvidiaUpstream.body) {
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const reader = nvidiaUpstream.body.getReader();
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
    } catch (err) {
      console.error("NVIDIA fallback error in api/mistral.js:", err);
    }
  }

  res.status(200).json({ error: "model_unavailable" });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
