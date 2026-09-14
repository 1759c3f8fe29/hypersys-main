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

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, max_tokens } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  if (await applyMeter(req, res, { byokHeaders: ["x-nvidia-api-key", "x-api-key"] })) return;

  // Never read `authorization`: Firebase ID token, not a provider key.
  const key =
    header(req, "x-nvidia-api-key") ||
    header(req, "x-api-key") ||
    process.env.VITE_NVIDIA_API_KEY ||
    process.env.NVIDIA_API_KEY;
  if (!key) {
    res.status(500).json({ error: "NVIDIA_API_KEY is not configured" });
    return;
  }

  // Serve exactly nemotron-parse. The caller is responsible for sending the
  // image-only content the model accepts; we pass messages through verbatim so
  // the route does not become a silent shape-substitutor.
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
  const BACKOFF_MS = [600, 1500, 3000];
  const safeMaxTokens = Math.min(Math.max(Number(max_tokens) || 2000, 1), 8192);
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
      upstream = await fetchWithTimeout(NVIDIA_URL, {
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
          max_tokens: safeMaxTokens,
        }),
      });
    } catch (e) {
      console.error(`nemotron-parse fetch failed (attempt ${attempt + 1}):`, e);
      upstream = null;
      lastStatus = 502;
      lastDetail = String(e).slice(0, 300);
    }

    if (upstream && upstream.ok) break;

    if (upstream) {
      lastStatus = upstream.status;
      lastDetail = (await upstream.text().catch(() => "")).slice(0, 300);
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
  // Guarded: a 200 with non-JSON (gateway HTML, truncation) must 502, not throw.
  try {
    res.status(200).json(await upstream.json());
  } catch {
    res.status(502).json({ error: "ocr_upstream_error", status: 502, detail: "OCR returned a non-JSON response." });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
