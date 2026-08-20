// Vercel serverless function: POST /api/ocr
//
// Runs a single non-streaming NVIDIA `nemotron-parse` OCR call server-side so the
// API key stays server-side. Distinct from /api/nvidia (which streams chat) for
// two reasons wired into the model's contract:
//
//   * nemotron-parse rejects text input ("The model does not support text
//     input"); the caller sends an image-only content array. That is a document
//     utility shape, not a chat shape, so it gets its own route.
//   * The model returns its result as a `markdown_bbox` tool_call in ONE
//     non-streamed JSON response. Streamed, it instead emits loose
//     `<x_><y_><class_>` content tokens — a different, fragile grammar the
//     caller would have to reassemble. Non-streaming keeps the structured
//     output intact.
//
// The route spends our key, so callers are metered (BYOK headers exempt the
// caller's own allowance) and retried on the same transient NVIDIA statuses as
// /api/nvidia. Set VITE_NVIDIA_API_KEY or NVIDIA_API_KEY in the Vercel env.

import { applyGuard } from "./_guard.js";
import { applyMeter } from "./_meter.js";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const OCR_MODEL = "nvidia/nemotron-parse";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (await applyMeter(req, res, { byokHeaders: ["x-nvidia-api-key", "x-api-key"] })) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key =
    req.headers["x-nvidia-api-key"] ||
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.split(" ")[1] ||
    process.env.VITE_NVIDIA_API_KEY ||
    process.env.NVIDIA_API_KEY;
  if (!key) {
    res.status(500).json({ error: "NVIDIA_API_KEY is not configured" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, max_tokens } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  // Serve exactly nemotron-parse. The caller is responsible for sending the
  // image-only content the model accepts; we pass messages through verbatim so
  // the route does not become a silent shape-substitutor.
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
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: OCR_MODEL,
          messages,
          stream: false,
          max_tokens: max_tokens ?? 2000,
        }),
      });
    } catch (e) {
      console.error(`nemotron-parse fetch failed (attempt ${attempt + 1}):`, e);
      upstream = null;
      lastStatus = 502;
      lastDetail = String(e);
    }

    if (upstream && upstream.ok) break;

    if (upstream) {
      lastStatus = upstream.status;
      lastDetail = await upstream.text().catch(() => "");
      // A real bad request (no text input, oversized image, etc.) must not be
      // retried — only the transient gateway statuses.
      if (!RETRY_STATUSES.has(upstream.status)) break;
      upstream = null;
    }

    if (attempt < BACKOFF_MS.length) {
      console.warn(`nemotron-parse returned ${lastStatus}; retrying in ${BACKOFF_MS[attempt]}ms`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }

  if (!upstream || !upstream.ok) {
    console.error("nemotron-parse upstream error:", lastStatus, lastDetail);
    const overloaded = lastStatus === 529 || lastStatus === 429;
    res.status(lastStatus || 502).json({
      error: overloaded ? "nvidia_model_overloaded" : "ocr_upstream_error",
      status: lastStatus,
      detail: overloaded
        ? "nemotron-parse is temporarily overloaded on NVIDIA NIM. It is available again shortly — retry."
        : lastDetail,
    });
    return;
  }

  // Return the full JSON so the client can flatten the markdown_bbox tool_call.
  res.status(200).json(await upstream.json());
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
