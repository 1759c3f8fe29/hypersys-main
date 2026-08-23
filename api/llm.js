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
import { FAILOVER_STATUSES, RETRY_STATUSES, OVERLOAD_STATUSES, GONE_STATUSES } from "./_failover.js";

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
  // The keyless final fallback, and — since api/pollinations.js was deleted — the
  // only way into Pollinations on this surface.
  //
  // That file was a second, standalone POST /api/pollinations handler. It had
  // ZERO callers (the client's only api paths are /api/llm, /api/nvidia,
  // /api/mistral, /api/ocr and /api/search, none of them built dynamically), and
  // it was the one endpoint here that did not import _meter.js — which is the
  // sole route to _auth.js's verifyRequest. Its own header claimed it "stays
  // behind applyGuard's Origin allowlist", but _guard.js documents the opposite
  // for exactly the caller that matters: a request with no Origin header is
  // "deliberately let through for _auth.js to attribute and meter". So a bare
  // curl reached the upstream fetch with nothing in between — an open,
  // unauthenticated, unmetered streaming LLM relay on the deployed origin.
  //
  // Worth recording WHY, because it was not an oversight: the handler wanted to
  // be authenticated but not charged against the daily allowance (correct — the
  // safety net must not be taken away at the moment it is needed, and Pollinations
  // costs us nothing). applyMeter cannot express that; it verifies AND consumes,
  // and its only bypass is opts.byokHeaders. Faced with an API that offered
  // "authenticated and metered" or nothing, the file took nothing — and lost
  // authentication as collateral damage. If a keyless route ever does need its own
  // handler, add an explicit skip-quota option to applyMeter rather than dropping
  // the module: the two properties are separable and the API should say so.
  //
  // Nothing was lost by deleting it. This route serves `flyer-free` through the
  // guarded, metered chain below, and verify-models now probes it live (it
  // answered in 5300ms), so the fallback is exercised rather than assumed.
  pollinations: {
    url: "https://text.pollinations.ai/openai",
    envKeys: [],
    keyless: true,
    supportsTools: false,
  },
};

// The three failure-classification sets now live in ./_failover.js — one
// definition, imported by this file AND by src/lib/providers.ts, which used to
// keep a hand-copied duplicate behind shouldFailover(). See that file for why the
// shared module is plain dependency-free .js and why it sits in api/.
//
// Re-exported because src/test/llm-failover.test.ts and src/test/providers.test.ts
// both import them from this module by name, and because this is the honest place
// to look for them: it is the file whose behaviour they govern.
export { FAILOVER_STATUSES, RETRY_STATUSES, OVERLOAD_STATUSES, GONE_STATUSES };

// Backoff between retries against the same provider. Most catalogue models have a
// single route, so without this a 529 blip surfaces as a hard failure — the
// "working models look permanently broken" bug api/nvidia.js (L41-42) documents
// fixing with the same backoff.
const BACKOFF_MS = [600, 1500];

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------
//
// WHY THESE EXIST
//
// The upstream fetch used to carry no signal at all, so a provider that accepted
// the TCP connection and then never answered hung this function until the
// platform killed it. Three things broke at once, and none of them looked like a
// timeout to the user:
//
//   1. The failover loop below never advanced. `await fetch` never settled, so a
//      model with a second route — nemotron-vision has one precisely for this —
//      could only ever fail over on an HTTP *status*, never on a hang. The
//      backup route was unreachable in the exact failure it was added for.
//   2. The handler never reached its own error reporting, so the client got a
//      platform 504 with no JSON body instead of the "which of three situations
//      is this" payload built at the end of this file.
//   3. The user waited out the client's full REQUEST_TIMEOUT_MS (130s, see
//      src/pages/Chat.tsx L102) and got a generic failure.
//
// This is not theoretical: scripts/verify-models.mjs probes every catalogue route
// and meta/llama-3.3-70b-instruct has now failed to answer a POST three separate
// times while nine other NVIDIA routes on the same key answered in under 2s.
//
// TWO GUARDS, NOT ONE. The deadline bounds *time to first byte* only, and is
// cleared the moment response headers arrive. A streaming completion legitimately
// takes minutes, so a single timer around the whole exchange would cut off long
// answers mid-sentence — which is a worse bug than the one being fixed. Once the
// stream is flowing, a stalled connection is the client's STREAM_IDLE_TIMEOUT_MS
// (60s) to catch, and it does.
//
// The chain gets one shared budget rather than a per-route timeout, so the total
// stays under the client's guard no matter how many routes a model lists. 50s
// leaves the client ~80s of headroom to receive and render a real error.
//
// UPPER BOUND: vercel.json pins `maxDuration: 60` for api/**. It was previously
// unset, which means the invocation inherited whatever the account default is —
// documented as low (on the order of 10-15s for Node functions, though it varies
// by plan and with Fluid compute, and this was NOT re-verified against Vercel's
// current docs). Either way an unset value is the wrong way to run a streaming AI
// proxy: a default shorter than an answer takes truncates it mid-sentence, and it
// makes every deadline in this file unreachable. 60 is the Hobby-plan ceiling, so
// it is the highest value that cannot fail a deploy on any plan. Raising
// CHAIN_DEADLINE_MS above ~55s therefore does nothing until maxDuration goes up
// with it (Pro allows 300).
//
// This bounds the *whole* invocation including streaming, so a very long answer
// can still be cut off by the platform. That is a plan limit, not something this
// file can fix.
const CHAIN_DEADLINE_MS = 50_000;
export { CHAIN_DEADLINE_MS };

// Per-attempt cap on time-to-first-byte, applied only when another route is left
// to try. Observed cold starts on this endpoint run to ~13s (minimaxai/minimax-m3,
// measured), so this clears a genuinely slow scale-from-zero with margin while
// still leaving room for a second route inside CHAIN_DEADLINE_MS.
const FIRST_BYTE_TIMEOUT_MS = 22_000;
export { FIRST_BYTE_TIMEOUT_MS };

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
 *
 * `deadline` is an absolute epoch-ms cap shared by the whole chain. `isLastRoute`
 * relaxes the per-attempt cap: with no backup left there is nothing to fail over
 * *to*, so the final route is allowed the entire remaining budget rather than
 * being cut off at FIRST_BYTE_TIMEOUT_MS to protect a route that does not exist.
 */
export async function callProvider({ cfg, route, key, payload, deadline, isLastRoute }) {
  let lastStatus = 0;
  let lastDetail = "";

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { status: 504, detail: `chain deadline of ${CHAIN_DEADLINE_MS}ms exhausted` };
    }
    const attemptMs = isLastRoute ? remaining : Math.min(FIRST_BYTE_TIMEOUT_MS, remaining);

    let upstream = null;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptMs);

    try {
      upstream = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(cfg.keyless ? {} : { Authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({ ...payload, model: route.modelId }),
        signal: controller.signal,
      });
    } catch (err) {
      lastStatus = timedOut ? 504 : 502;
      lastDetail = timedOut ? `no response in ${attemptMs}ms` : String(err);
      upstream = null;
    } finally {
      // Cleared as soon as headers are in. This is what keeps the guard on
      // time-to-first-byte instead of on the whole stream: leaving the timer
      // armed would abort `upstream.body` mid-answer once it fired.
      clearTimeout(timer);
    }

    // A route that produced nothing in attemptMs will not produce anything in
    // attemptMs + 600ms. Retrying it here would spend the entire chain budget
    // re-hanging one dead route and never reach the backup — the original bug
    // with extra steps. Return so the caller fails over; 504 is in
    // FAILOVER_STATUSES, so it will.
    if (timedOut) {
      console.warn(`[llm] ${route.provider}/${route.modelId} → no first byte in ${attemptMs}ms`);
      return { status: lastStatus, detail: lastDetail };
    }

    if (upstream) {
      if (upstream.ok && upstream.body) return { upstream };
      lastStatus = upstream.status;
      lastDetail = (await upstream.text().catch(() => "")).slice(0, 300);
      // 404 is ambiguous on NVIDIA — transient unavailability and an id they do not
      // host look identical from here (see api/_failover.js). It fails over now, so
      // this line is the only place the signal survives: a 404 that shows up in the
      // logs for one model over and over is a catalogue entry to re-probe with
      // scripts/probe-id.mjs, not a busy pool.
      if (upstream.status === 404) {
        console.warn(
          `[llm] ${route.provider}/${route.modelId} → 404. Transient on NVIDIA, or the id is no longer served; failing over. Re-probe before editing the catalogue.`,
        );
      }
      // A genuine 4xx (bad request, rejected key) must not be retried. 404 is not
      // in RETRY_STATUSES either — three 404s inside six seconds were observed, so
      // knocking again on the same route is measured waste — but it does fail over.
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

/**
 * Which of the four situations a fully-failed chain is in, as
 * `{ error, status, detail }`. `error` is a wire contract: routerError() in
 * src/lib/ai.ts switches on these strings, so the two must change together.
 *
 * Pure and exported so it can be tested without standing up req/res plus
 * applyGuard and applyMeter — the same reason callProvider above and canExtract()
 * in src/lib/documents.ts are separate from their callers. This was previously
 * four inline ternaries evaluated three times over (once for `error`, once for the
 * HTTP status, once for the detail string), which is how 503 came to be handled in
 * two of the three places and missed in the third.
 */
export function classifyFailure(attempts) {
  // every() on an empty array is true, so without this guard a chain that never
  // ran would confidently report "no provider configured". Unreachable today —
  // `routes` is validated non-empty and every iteration either returns or pushes —
  // which is exactly what makes it cheap to keep.
  if (attempts.length === 0) {
    return { error: "all_providers_failed", status: 502, detail: "All providers failed." };
  }

  if (attempts.every((a) => a.status === 0)) {
    return {
      error: "no_provider_configured",
      status: 400,
      detail:
        "No provider key is configured on the server. Set NVIDIA_API_KEY and/or MISTRAL_API_KEY (Pollinations needs no key and answers as the final fallback).",
    };
  }

  if (attempts.every((a) => OVERLOAD_STATUSES.has(a.status))) {
    // The wire code still says "rate_limited" although the set is now broader.
    // Renaming it would strand the desktop builds in release/, which ship a frozen
    // client bundle pointed at the deployed API (see .env.desktop) and would fall
    // through to the generic message for a code they have never heard of. Both
    // user-facing strings already say "busy"/"overloaded" rather than naming a
    // status, so the code name is the only thing narrower than the behaviour.
    return {
      error: "all_providers_rate_limited",
      status: 429,
      detail: "Every provider for this model is rate limited or overloaded right now.",
    };
  }

  // Every leg answered 404. Its own branch because the generic fallback below
  // pastes `attempts[last].detail` — a raw NVIDIA 404 body — into the chat, which
  // is the same class of bug 503 had before OVERLOAD_STATUSES existed.
  //
  // The wording deliberately does not claim to know which of the two causes it is,
  // because from one request they are indistinguishable (see api/_failover.js): the
  // id may be temporarily unserved, or withdrawn for good. Both leave the user with
  // the same two useful options, so the message gives those instead of a diagnosis.
  //
  // `detail` is written as user-facing prose on purpose. routerError() in
  // src/lib/ai.ts falls through to `parsed.detail` for a code it does not know, and
  // the desktop builds in release/ ship a frozen client bundle against the deployed
  // API — so this exact sentence is what those older builds will show. A terse
  // machine detail here would degrade them to the generic HTTP message.
  if (attempts.every((a) => a.status === 404)) {
    return {
      error: "model_unavailable",
      status: 503,
      detail:
        "This model isn't being served right now. That is usually temporary — try again in a moment, or pick another model.",
    };
  }

  // Every leg answered 410 Gone. Placed AFTER the 404 branch, and the ordering is
  // load-bearing in the other direction than it looks: a mixed chain (one leg 404,
  // one leg 410) matches neither `every` and correctly falls through to the generic
  // message, because we do not know from a mixed result whether the model is
  // retired everywhere or merely unserved somewhere.
  //
  // The message says "retired" and does NOT suggest trying again, which is the
  // entire reason this branch exists rather than folding 410 in with 404 above.
  // 410 is the one status a provider gives that is a promise about the future, and
  // telling the user to retry an id that will never answer sends them into a loop
  // that looks like a bug in the app.
  //
  // Same constraint as the 404 branch on the prose: routerError() in src/lib/ai.ts
  // falls through to `parsed.detail` for codes it does not recognise, and the
  // frozen desktop bundles in release/ point at the deployed API — so this exact
  // sentence is what an older client renders.
  if (attempts.every((a) => GONE_STATUSES.has(a.status))) {
    return {
      error: "model_retired",
      // 410 rather than 503: the status is the honest one, and unlike the 404
      // branch there is no argument for softening it into "service unavailable".
      status: 410,
      detail:
        "This model has been retired by its provider and is no longer available. Pick another model — your conversation is unaffected.",
    };
  }

  // Nothing rejected the request; the providers simply never answered. Worth its
  // own message because the generic one invites the user to debug a request that
  // was never refused.
  if (attempts.every((a) => a.status === 504)) {
    return {
      error: "all_providers_timed_out",
      status: 504,
      detail: `No provider for this model returned a first byte within the ${CHAIN_DEADLINE_MS / 1000}s budget.`,
    };
  }

  return {
    error: "all_providers_failed",
    status: 502,
    detail: attempts[attempts.length - 1]?.detail || "All providers failed.",
  };
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

  // One budget for the whole chain, fixed before the first attempt, so total time
  // stays under the client's REQUEST_TIMEOUT_MS however many routes a model has.
  const deadline = Date.now() + CHAIN_DEADLINE_MS;

  // Whether any route *after* this one could actually be tried. Not the same as
  // "is this the last element": routes with an unknown provider or a missing key
  // are skipped below, so with an unconfigured backup the first route is
  // effectively the last one and deserves the full remaining budget rather than
  // being cut short to preserve a failover that cannot happen.
  const usableRouteAfter = (i) =>
    routes.slice(i + 1).some((r) => {
      const c = PROVIDER_ENDPOINTS[r?.provider];
      return Boolean(c) && (c.keyless || Boolean(resolveKey(req, c).key));
    });

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
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

    const result = await callProvider({
      cfg,
      route,
      key,
      payload: routePayload,
      deadline,
      isLastRoute: !usableRouteAfter(i),
    });

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

  // --- Everything failed: say which of the four situations this is ----------
  console.error("[llm] all providers failed:", JSON.stringify(attempts));

  const { error, status, detail } = classifyFailure(attempts);
  res.status(status).json({
    error,
    detail,
    attempts: attempts.map(({ provider, status: s }) => ({ provider, status: s })),
  });
}

