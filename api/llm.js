// Vercel serverless function: POST /api/llm
//
// The unified multi-provider chat router. src/lib/ai.ts sends a model's whole
// provider chain here and this walks it, streaming from the first provider that
// answers. Ported from the dev proxy in vite.config.ts (proxyLlm, L107-189);
// dev and prod must stay in agreement, so change both together.
//
// WHY A ROUTER AND NOT ONE ROUTE PER PROVIDER
//
// Keyed free tiers run out and NVIDIA NIM answers 529 when a model's capacity
// pool saturates. Falling through to the next provider in the chain keeps the
// app answering. The rule from src/lib/providers.ts holds absolutely: every
// route in a chain is the SAME underlying model served by a different provider.
// This file must never substitute a different model, because the user picked the
// model and the reply is labelled with it.
//
// Unlike the dev proxy, this enforces auth and quota: production is exposed to
// the internet and the shared free-tier pool is the most abusable thing we have.

import { applyGuard } from "./_guard.js";
import { applyMeter } from "./_meter.js";

// Keep in step with PROVIDERS in src/lib/providers.ts. Server-side only, so no
// VITE_-prefixed key is read here by preference — those get inlined into the
// browser bundle and are only tolerated as a legacy fallback.
const PROVIDER_ENDPOINTS = {
  nvidia: {
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    envKeys: ["NVIDIA_API_KEY", "VITE_NVIDIA_API_KEY"],
    byokHeader: "x-nvidia-api-key",
    supportsTools: true,
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    envKeys: ["MISTRAL_API_KEY", "VITE_MISTRAL_API_KEY"],
    byokHeader: "x-mistral-api-key",
    supportsTools: true,
  },
  pollinations: {
    url: "https://text.pollinations.ai/openai",
    envKeys: [],
    keyless: true,
    supportsTools: false,
  },
};

// Mirrors shouldFailover() in src/lib/providers.ts (L283). 401/403 (bad key) and
// 404 (unknown model) are deliberately absent: those are configuration faults,
// and failing over would leave us quietly running on backups while the primary
// stays broken. They surface loudly instead.
const FAILOVER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// Transient-overload statuses worth waiting out on the *same* provider. Most
// catalogue models have a single route, so without this a 529 blip would surface
// as a hard failure — the "working models look permanently broken" bug that
// api/nvidia.js (L41-42) already documents fixing with the same backoff.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const BACKOFF_MS = [600, 1500];

// The client is untrusted; a huge max_tokens is a cost attack.
const MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_OUTPUT_TOKENS = 4096;

function header(req, name) {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw || undefined;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * The key to use for a provider: the caller's own (BYOK) first, then ours.
 * Returns { key, byok }. A placeholder left in .env ("your-key-here") counts as
 * unconfigured — otherwise it reaches the provider and comes back 401, which
 * failover refuses to retry, so the whole chain dies on a typo.
 */
function resolveKey(req, cfg) {
  if (cfg.keyless) return { key: null, byok: false };

  const userKey = cfg.byokHeader ? header(req, cfg.byokHeader) : undefined;
  if (userKey && !String(userKey).startsWith("your-")) {
    return { key: userKey, byok: true };
  }

  const ourKey = cfg.envKeys.map((k) => process.env[k]).find(Boolean);
  if (ourKey && !String(ourKey).startsWith("your-")) {
    return { key: ourKey, byok: false };
  }

  return { key: null, byok: false };
}

async function pipeStream(upstream, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

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

/**
 * One attempt at one provider, with backoff on transient overload.
 * Returns { upstream } on success, or { status, detail } on failure.
 */
async function callProvider({ cfg, route, key, payload }) {
  let lastStatus = 0;
  let lastDetail = "";

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    let upstream = null;
    try {
      upstream = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(cfg.keyless ? {} : { Authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({ ...payload, model: route.modelId }),
      });
    } catch (err) {
      lastStatus = 502;
      lastDetail = String(err);
      upstream = null;
    }

    if (upstream) {
      if (upstream.ok && upstream.body) return { upstream };
      lastStatus = upstream.status;
      lastDetail = (await upstream.text().catch(() => "")).slice(0, 300);
      // A genuine 4xx (bad key, unknown model) must not be retried.
      if (!RETRY_STATUSES.has(upstream.status)) break;
    }

    if (attempt < BACKOFF_MS.length) {
      console.warn(
        `[llm] ${route.provider}/${route.modelId} → ${lastStatus}; retrying in ${BACKOFF_MS[attempt]}ms`,
      );
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }

  return { status: lastStatus, detail: lastDetail };
}

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { messages, routes, temperature, top_p, max_tokens, tools, tool_choice } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "`messages` array is required" });
    return;
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    res.status(400).json({ error: "`routes` array is required" });
    return;
  }

  // --- Who is calling, and may they spend from the pool? --------------------
  //
  // Counted before any upstream call, so a caller over their limit costs us
  // nothing. Only the BYOK headers for providers actually in this chain exempt
  // the request: an x-mistral-api-key must not buy free NVIDIA calls.
  const byokHeaders = routes
    .map((route) => PROVIDER_ENDPOINTS[route?.provider]?.byokHeader)
    .filter(Boolean);

  if (await applyMeter(req, res, { byokHeaders })) return;

  // --- Walk the chain -------------------------------------------------------
  const payload = {
    messages,
    stream: true,
    temperature: temperature ?? 0.7,
    top_p: top_p ?? 0.95,
    max_tokens: Math.min(Number(max_tokens) || DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
  };

  const attempts = [];

  for (const route of routes) {
    const cfg = PROVIDER_ENDPOINTS[route?.provider];
    if (!cfg) {
      attempts.push({ provider: String(route?.provider), status: 0, detail: "unknown provider" });
      continue;
    }

    const { key } = resolveKey(req, cfg);
    if (!cfg.keyless && !key) {
      attempts.push({ provider: route.provider, status: 0, detail: "no key configured" });
      continue;
    }

    // Only forward tools to a provider whose OpenAI-compatible surface accepts
    // them. Pollinations does not, and sending tools there returns a 400 that
    // would burn the last fallback in the chain.
    const routePayload = { ...payload };
    if (Array.isArray(tools) && tools.length > 0 && cfg.supportsTools) {
      routePayload.tools = tools;
      if (tool_choice) routePayload.tool_choice = tool_choice;
    }

    const result = await callProvider({ cfg, route, key, payload: routePayload });

    if (result.upstream) {
      // The client reads these to show who actually served the reply.
      res.setHeader("X-Served-By", route.provider);
      res.setHeader("X-Served-Model", route.modelId);
      await pipeStream(result.upstream, res);
      return;
    }

    attempts.push({ provider: route.provider, status: result.status, detail: result.detail });

    if (!FAILOVER_STATUSES.has(result.status)) {
      // Configuration fault — stop rather than mask it behind a backup.
      break;
    }
    console.warn(`[llm] ${route.provider}/${route.modelId} → ${result.status}, trying next`);
  }

  // --- Everything failed: say which of the three situations this is ---------
  // src/lib/ai.ts:286-306 maps these to user-facing messages.
  const noneConfigured = attempts.length > 0 && attempts.every((a) => a.status === 0);
  const allRateLimited =
    attempts.length > 0 && attempts.every((a) => a.status === 429 || a.status === 529);

  const error = noneConfigured
    ? "no_provider_configured"
    : allRateLimited
      ? "all_providers_rate_limited"
      : "all_providers_failed";

  console.error("[llm] all providers failed:", JSON.stringify(attempts));

  res.status(noneConfigured ? 400 : allRateLimited ? 429 : 502).json({
    error,
    detail: noneConfigured
      ? "No provider key is configured on the server. Set NVIDIA_API_KEY and/or MISTRAL_API_KEY (Pollinations needs no key and answers as the final fallback)."
      : allRateLimited
        ? "Every provider for this model is rate limited or overloaded right now."
        : attempts[attempts.length - 1]?.detail || "All providers failed.",
    attempts: attempts.map(({ provider, status }) => ({ provider, status })),
  });
}

