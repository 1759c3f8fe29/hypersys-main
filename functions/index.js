import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

// Secrets are configured with the Firebase CLI, never committed:
//   firebase functions:secrets:set MISTRAL_API_KEY
//   firebase functions:secrets:set SERPAPI_API_KEY
//   firebase functions:secrets:set NVIDIA_API_KEY
//   firebase functions:secrets:set OPENAI_API_KEY
//   firebase functions:secrets:set GEMINI_API_KEY
//   firebase functions:secrets:set XAI_API_KEY
const MISTRAL_API_KEY = defineSecret("MISTRAL_API_KEY");
const SERPAPI_API_KEY = defineSecret("SERPAPI_API_KEY");
const NVIDIA_API_KEY = defineSecret("NVIDIA_API_KEY");
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const XAI_API_KEY = defineSecret("XAI_API_KEY");

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const SERPAPI_URL = "https://serpapi.com/search.json";


// Comma-separated allowlist of origins permitted to use the proxy. When unset
// (development), any origin is allowed. In production, set ALLOWED_ORIGINS to
// your app's domain(s) so the app's server-side keys can't be driven from
// other websites' browser code.
function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

// Returns the request's origin (falling back to the Referer's origin) or null.
function requestOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return origin;
  const referer = req.headers.referer;
  if (referer) {
    try { return new URL(referer).origin; } catch { /* ignore */ }
  }
  return null;
}

// True when the request may use the proxy. If no allowlist is configured we
// allow everything (dev). Otherwise a present Origin must be in the list; a
// request with no Origin at all (same-origin server call, tooling) is allowed.
function isOriginAllowed(req) {
  const allowed = getAllowedOrigins();
  if (allowed.length === 0) return true;
  const origin = requestOrigin(req);
  if (!origin) return true;
  return allowed.includes(origin);
}

// Reflect the caller's origin when it is allowed, so CORS stays tight in
// production while remaining permissive ("*") when no allowlist is set.
function setCors(res, req) {
  const allowed = getAllowedOrigins();
  const origin = req ? requestOrigin(req) : null;
  if (allowed.length === 0) {
    res.set("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Nvidia-Api-Key, X-Mistral-Api-Key, X-OpenAI-Api-Key, X-Gemini-Api-Key, X-xAI-Api-Key");
  res.set("Access-Control-Max-Age", "3600");
}

/**
 * Unified API handler. Routed at /api/** by the Hosting rewrite:
 *   POST /api/mistral  -> streams a Mistral chat completion (SSE passthrough)
 *   POST /api/search   -> returns condensed SerpApi organic results as JSON
 */
export const api = onRequest(
  {
    secrets: [MISTRAL_API_KEY, SERPAPI_API_KEY, NVIDIA_API_KEY],
    cors: false,
    memory: "256MiB",
    timeoutSeconds: 120,
    maxInstances: 10,
  },
  async (req, res) => {
    setCors(res, req);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    // Reject calls from origins outside the configured allowlist so the app's
    // server-side keys can't be spent by other sites' browser code.
    if (!isOriginAllowed(req)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    // req.path is the portion after the function mount. Match on suffix so it
    // works both behind the /api rewrite and when called directly.
    const path = (req.path || "").replace(/\/+$/, "");

    try {
      if (path.endsWith("/mistral")) {
        await handleMistral(req, res);
        return;
      }
      if (path.endsWith("/nvidia")) {
        await handleNvidia(req, res);
        return;
      }
      if (path.endsWith("/openai")) {
        await handleOpenAI(req, res);
        return;
      }
      if (path.endsWith("/gemini")) {
        await handleGemini(req, res);
        return;
      }
      if (path.endsWith("/xai")) {
        await handleXAI(req, res);
        return;
      }
      if (path.endsWith("/pollinations")) {
        await handlePollinations(req, res);
        return;
      }
      if (path.endsWith("/search")) {
        await handleSearch(req, res);
        return;
      }
      res.status(404).json({ error: "Unknown endpoint" });
    } catch (err) {
      console.error("API handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal error" });
      } else {
        res.end();
      }
    }
  }
);

function getApiKey(secretObject, envVarName1, envVarName2, req) {
  if (req) {
    const headerKey = req.headers["x-openai-api-key"] || 
                      req.headers["x-gemini-api-key"] || 
                      req.headers["x-xai-api-key"] || 
                      req.headers["x-nvidia-api-key"] || 
                      req.headers["x-mistral-api-key"] || 
                      req.headers["x-api-key"] || 
                      req.headers["authorization"]?.split(" ")[1];
    if (headerKey) return headerKey.trim();
  }
  try {
    const val = secretObject.value();
    if (val && val !== "your-key-here" && !val.startsWith("your-")) return val;
  } catch (e) {
    // Secret not defined or not available in current environment
  }
  return process.env[envVarName1] || process.env[envVarName2];
}

async function handleOpenAI(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = getApiKey(OPENAI_API_KEY, "VITE_OPENAI_API_KEY", "OPENAI_API_KEY", req);
  if (!key || key === "your-openai-key" || key.startsWith("your-")) {
    res.status(400).json({ error: "OpenAI API key is not configured." });
    return;
  }
  const { messages, model, temperature, top_p, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages,
      stream: true,
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.95,
      max_tokens: max_tokens ?? 2048,
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("OpenAI upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({ error: "openai_upstream_error", status: upstream.status });
    return;
  }
  res.status(200);
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");
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

async function handleGemini(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = getApiKey(GEMINI_API_KEY, "VITE_GEMINI_API_KEY", "GEMINI_API_KEY", req);
  if (!key || key === "your-gemini-key" || key.startsWith("your-")) {
    res.status(400).json({ error: "Gemini API key is not configured." });
    return;
  }
  const { messages, model, temperature, top_p, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }
  const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "gemini-2.0-flash",
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
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");
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

async function handleXAI(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = getApiKey(XAI_API_KEY, "VITE_XAI_API_KEY", "XAI_API_KEY", req);
  if (!key || key === "your-xai-key" || key.startsWith("your-")) {
    res.status(400).json({ error: "xAI (Grok) API key is not configured." });
    return;
  }
  const { messages, model, temperature, top_p, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }
  const upstream = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "grok-2",
      messages,
      stream: true,
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.95,
      max_tokens: max_tokens ?? 2048,
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("xAI upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({ error: "xai_upstream_error", status: upstream.status });
    return;
  }
  res.status(200);
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");
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

async function handleMistral(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { messages, model, temperature, top_p, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  const key = getApiKey(MISTRAL_API_KEY, "VITE_MISTRAL_API_KEY", "MISTRAL_API_KEY", req);
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

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("Mistral upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({
      error: "mistral_upstream_error",
      status: upstream.status,
    });
    return;
  }

  // Stream the SSE bytes straight back to the browser.
  res.status(200);
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");

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

async function handleSearch(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { query, num } = req.body || {};
  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "`query` string is required" });
    return;
  }

  const key = getApiKey(SERPAPI_API_KEY, "VITE_SERP_API_KEY", "SERPAPI_API_KEY");
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: String(Math.min(Math.max(Number(num) || 5, 1), 10)),
    api_key: key,
  });

  const upstream = await fetch(`${SERPAPI_URL}?${params.toString()}`);
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    console.error("SerpApi upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({ error: "serpapi_upstream_error" });
    return;
  }

  const data = await upstream.json();

  // Condense to only what the model needs, to keep the prompt small.
  const answerBox = data.answer_box
    ? {
        title: data.answer_box.title || null,
        answer: data.answer_box.answer || data.answer_box.snippet || null,
      }
    : null;

  const results = (data.organic_results || []).slice(0, 6).map((r) => ({
    title: r.title || "",
    snippet: r.snippet || "",
    link: r.link || "",
    source: r.source || null,
    date: r.date || null,
  }));

  res.set("Cache-Control", "public, max-age=300");
  res.status(200).json({
    query,
    answerBox,
    results,
    related: (data.related_questions || []).slice(0, 3).map((q) => q.question).filter(Boolean),
  });
}

async function handleNvidia(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { messages, model, temperature, top_p, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  const key = getApiKey(NVIDIA_API_KEY, "VITE_NVIDIA_API_KEY", "NVIDIA_API_KEY", req);
  const upstream = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "meta/llama-3.3-70b-instruct",
      messages,
      stream: true,
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.95,
      max_tokens: max_tokens ?? 2048,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("NVIDIA upstream error:", upstream.status, text);
    res.status(upstream.status || 502).json({
      error: "nvidia_upstream_error",
      status: upstream.status,
    });
    return;
  }

  res.status(200);
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");

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

async function handlePollinations(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { messages, model, temperature, top_p, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }

  const upstream = await fetch("https://text.pollinations.ai/v1/chat/completions", {
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
    res.status(upstream.status || 502).json({
      error: "pollinations_upstream_error",
      status: upstream.status,
    });
    return;
  }

  res.status(200);
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");

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

