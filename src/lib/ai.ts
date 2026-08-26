

import { auth } from "./firebase";
import {
  getModel,
  PROVIDERS,
  isImageModel as catalogueIsImage,
  isVisionModel as catalogueIsVision,
  supportsVision as catalogueSupportsVision,
  type ProviderId,
} from "./providers";
// `chat-format` imports nothing, so this cannot start a cycle — the same property
// that lets `api/_failover.js` stay dependency-free (see providers.ts).
import { stripReasoning } from "./chat-format";

// ---------------------------------------------------------------------------
// API base — same-origin on the web, absolute on the desktop shell
// ---------------------------------------------------------------------------
//
// The web build (Vercel) co-locates the /api/* handlers on the same origin, so
// a bare "/api/llm" is correct and CORS is never a question. The native desktop
// shell is a different case:
//
//   - desktop:dev loads the renderer from http://localhost:8080, which is the
//     Vite dev server — the /api/* middleware runs on that same origin, so the
//     calls stay same-origin and base is still "" (unchanged).
//   - desktop:build loads dist/index.html from file://, where there is no origin
//     to be same-origin with. The build sets VITE_API_BASE to the deployed
//     Vercel origin so the four /api/* calls reach https://myflyer.vercel.app.
//     See electron/main.cjs for the Origin-header rewrite that lets file://
//     requests through the production API's origin allowlist.
//
// Unset VITE_API_BASE (the normal web/dev case) → the helper is a passthrough,
// so this changes nothing about the existing Vercel deploy.
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
export function apiPath(p: string): string {
  return API_BASE ? `${API_BASE}${p}` : p;
}

// ---------------------------------------------------------------------------
// Legacy model → provider ID mapping
// ---------------------------------------------------------------------------
//
// DEPRECATED. src/lib/providers.ts is the model catalogue; this table only
// still exists for the direct /api/nvidia and /api/mistral proxies, which the
// router has not fully replaced yet. Add models to MODELS in providers.ts.
//
// Three entries were removed rather than migrated: "llama-4-maverick" and
// "qwen-3-next-80b" both pointed at meta/llama-3.1-70b-instruct, and
// "minimax-m2.7" at meta/llama-3.1-8b-instruct. The picker offered them under
// those names and a different model answered. Renaming weights is lying to the
// user about what produced their answer, so the names are gone; the legacy id
// map in providers.ts resolves any persisted ones to the model that genuinely
// replied.
export const MODEL_REGISTRY: Record<
  string,
  { nvidiaId: string; kind: 'Chat' | 'Vision' | 'Image'; provider?: 'nvidia' | 'mistral'; mistralId?: string }
> = {
  // ── Mistral Models (Mistral API — MISTRAL_API_KEY) ──
  "Flyer AI":             { nvidiaId: "", provider: "mistral", mistralId: "mistral-large-latest", kind: "Chat" },
  "mistral-large-latest": { nvidiaId: "", provider: "mistral", mistralId: "mistral-large-latest", kind: "Chat" },
  "mistral-large":        { nvidiaId: "", provider: "mistral", mistralId: "mistral-large-latest", kind: "Chat" },
  "mistral-medium":       { nvidiaId: "", provider: "mistral", mistralId: "mistral-medium-latest",kind: "Chat" },
  "mistral-small":        { nvidiaId: "", provider: "mistral", mistralId: "mistral-small-latest", kind: "Chat" },
  // pixtral-12b was removed here in 3.6: Mistral retired pixtral-12b-2409, so
  // the id now resolves to nemotron-vision via LEGACY_MODEL_IDS in providers.ts
  // and must not route to a dead Mistral upstream through this legacy registry.
  "codestral-latest":     { nvidiaId: "", provider: "mistral", mistralId: "codestral-latest",     kind: "Chat" },
  "devstral-latest":      { nvidiaId: "", provider: "mistral", mistralId: "devstral-latest",      kind: "Chat" },
  "ministral-8b":         { nvidiaId: "", provider: "mistral", mistralId: "ministral-8b-latest",  kind: "Chat" },

  // ── Verified NVIDIA NIM Chat / Reasoning Models ──
  "kimi-k2.6":          { nvidiaId: "moonshotai/kimi-k2.6",                    kind: "Chat" },
  "minimax-m3":        { nvidiaId: "minimaxai/minimax-m3",                     kind: "Chat" },
  "llama-3.3-70b":     { nvidiaId: "meta/llama-3.3-70b-instruct",             kind: "Chat" },
  "llama-70b":         { nvidiaId: "meta/llama-3.3-70b-instruct",             kind: "Chat" },
  "llama-8b":          { nvidiaId: "meta/llama-3.1-8b-instruct",              kind: "Chat" },
  "nemotron-3-ultra-550b": { nvidiaId: "nvidia/nemotron-3-ultra-550b-a55b", kind: "Chat" },
  "nemotron-super-49b":{ nvidiaId: "nvidia/llama-3.3-nemotron-super-49b-v1",  kind: "Chat" },
  "nemotron-nano-9b":  { nvidiaId: "nvidia/llama-3.1-nemotron-nano-8b-v1",   kind: "Chat" },
  "step-3.7-flash":    { nvidiaId: "stepfun-ai/step-3.7-flash",               kind: "Chat" },

  // ── Vision (image understanding engines) ──────
  // NOTE: these are NVIDIA NIM catalog ids and must exist in the NIM catalog.
  // "vision-engine" previously pointed at the bare string "pixtral-12b", which
  // is a Mistral id, not a NIM one — NIM answered every such call with a 404.
  "vision-engine":     { nvidiaId: "meta/llama-3.2-90b-vision-instruct",      kind: "Vision" },
  "vision-engine-2":   { nvidiaId: "meta/llama-3.2-11b-vision-instruct",      kind: "Vision" },
  "vision-engine-3":   { nvidiaId: "microsoft/phi-3-vision-128k-instruct",    kind: "Vision" },

  // ── Image Generation Models (Pollinations) ──
  // NVIDIA NIM's genai image ids (sana, sdxl-turbo) were removed in 3.6: the
  // /v1/genai/* endpoint 404s for every model, so the only live image backend
  // is keyless Pollinations. The ids resolve via LEGACY_MODEL_IDS in
  // providers.ts, so nothing here points at a dead NVIDIA route.
  "flux":              { nvidiaId: "pollinations",                             kind: "Image" },
  "turbo":             { nvidiaId: "pollinations",                             kind: "Image" },
  "stable-diffusion":  { nvidiaId: "pollinations",                             kind: "Image" },
};

/**
 * The provider-side NVIDIA id for a model, or undefined if we do not know it.
 *
 * Returns undefined rather than defaulting. This used to fall back to
 * meta/llama-3.1-8b-instruct for *any* unrecognised id, so a typo or a stale
 * persisted id produced a confident answer from an 8B model labelled as
 * whatever the user had picked. Callers must surface the failure instead.
 */
export function getNvidiaId(modelId: string): string | undefined {
  return MODEL_REGISTRY[modelId]?.nvidiaId || undefined;
}


// The internal vision-capable model any non-vision chat model routes through when an image is attached.
// Mistral retired pixtral-12b (verified in 3.6), so this is the live NVIDIA
// vision engine; persisted "pixtral-12b" ids still resolve to it via
// LEGACY_MODEL_IDS in providers.ts.
export const VISION_ENGINE_MODEL = "nemotron-vision";

// Tried in order by generateVisionResponse. The catalogue vision engine first,
// then Mistral's multimodal chat engines so an outage or a missing NVIDIA key
// still resolves to an answer. The old "vision-engine*" aliases all resolve to
// nemotron-vision via LEGACY_MODEL_IDS now, so naming them here would be
// redundant.
export const VISION_ENGINE_FALLBACKS = [
  "nemotron-vision",
  "mistral-medium",
  "mistral-large-latest",
];

// Models that actually accept image input. Verified live against the provider
// catalogs: every current Mistral *chat* model is multimodal, but the code
// models (codestral / devstral) and the audio models (voxtral) are not, so a
// blanket "is it Mistral?" test would route images into a model that rejects them.
const VISION_CAPABLE_IDS = new Set([
  "Flyer AI",
  "mistral-large-latest",
  "mistral-large",
  "mistral-medium",
  "mistral-small",
  "pixtral-12b",
  "ministral-8b",
]);

/**
 * Whether a legacy id belongs to Mistral.
 *
 * An empty id returns false. It used to return true, so a missing or unset
 * model id routed silently to Mistral and answered as mistral-large — a caller
 * bug turning into a wrong-model reply. An empty id is now nobody's model and
 * the caller has to deal with it.
 */
export function isMistralModel(modelId: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  if (
    lower.includes("mistral") ||
    lower.includes("pixtral") ||
    lower.includes("codestral") ||
    lower.includes("devstral") ||
    lower.includes("flyer") ||
    modelId === "Flyer AI"
  ) {
    return true;
  }
  return MODEL_REGISTRY[modelId]?.provider === "mistral";
}

export function isVisionCapableModel(modelId: string): boolean {
  if (catalogueSupportsVision(modelId)) return true;
  if (VISION_CAPABLE_IDS.has(modelId)) return true;
  return isVisionModel(modelId);
}

// The catalogue in providers.ts is authoritative; the legacy registry is only
// consulted for ids that predate it.
export function isVisionModel(modelId: string): boolean {
  return catalogueIsVision(modelId) || MODEL_REGISTRY[modelId]?.kind === "Vision";
}

export function isImageModel(modelId: string): boolean {
  return catalogueIsImage(modelId) || MODEL_REGISTRY[modelId]?.kind === "Image";
}

// ---------------------------------------------------------------------------
// API Key Retreivers
// ---------------------------------------------------------------------------

// Only ever returns a user-supplied ("bring your own") key from Settings.
// The app's own key is NEVER read here — it lives server-side on the /api
// proxy so it can't be extracted from the browser bundle. When this returns
// undefined the client calls the proxy keyless and the server injects its key.
const getUserNvidiaApiKey = () => {
  const localKey = localStorage.getItem("VITE_NVIDIA_API_KEY") || localStorage.getItem("NVIDIA_API_KEY");
  return localKey ? localKey.trim() : undefined;
};

// Same "bring your own key" contract for Mistral. Undefined = call the
// /api/mistral proxy keyless and let the server inject MISTRAL_API_KEY.
const getUserMistralApiKey = () => {
  const localKey = localStorage.getItem("VITE_MISTRAL_API_KEY") || localStorage.getItem("MISTRAL_API_KEY");
  return localKey ? localKey.trim() : undefined;
};

// Per-provider BYOK lookup for the multi-provider router. A user who supplies
// their own key is spending their own quota, so the server skips its rate limit
// for that request entirely — this is the escape hatch for anyone who needs
// more than the shared free pool allows.
export function getUserProviderKey(provider: ProviderId): string | undefined {
  const stored = localStorage.getItem(`BYOK_${provider.toUpperCase()}`);
  return stored ? stored.trim() : undefined;
}

export function setUserProviderKey(provider: ProviderId, key: string | null) {
  const storageKey = `BYOK_${provider.toUpperCase()}`;
  if (key && key.trim()) localStorage.setItem(storageKey, key.trim());
  else localStorage.removeItem(storageKey);
}

/**
 * Firebase ID token for the current user, or undefined when signed out.
 *
 * Returned rather than thrown on failure: the router answers 401 with a
 * message the UI can show, which is clearer than a client-side exception that
 * would be indistinguishable from a network fault.
 *
 * `forceRefresh` bypasses the SDK's cached token and mints a new one. It exists for
 * the 401 retry in `generateRoutedResponse`: the SDK refreshes a token it believes
 * is near expiry, but "believes" is doing real work there — a suspended laptop, a
 * desktop window left open overnight, or a clock that drifted all reach the server
 * with a token the server rejects and the client still considers current. Asking
 * the server and then forcing a refresh is the only version that recovers, because
 * the server's opinion is the one that decides.
 */
async function getIdToken(forceRefresh = false): Promise<string | undefined> {
  try {
    return await auth.currentUser?.getIdToken(forceRefresh);
  } catch (err) {
    console.warn("[auth] could not get ID token:", err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = TextPart | ImagePart;

/** A tool call the model asked for, with `arguments` still unparsed JSON. */
export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * The OpenAI wire shape for a tool call on an assistant message. The assistant
 * turn that requested the calls must be replayed to the model verbatim
 * alongside the tool results, or the provider rejects the follow-up with
 * "tool_call_id not found".
 */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content: string | ContentPart[] | null;
  /** Present on an assistant turn that requested tools. */
  tool_calls?: WireToolCall[];
  /** Present on a `role: "tool"` result, matching the call it answers. */
  tool_call_id?: string;
  name?: string;
}

/** What a single streamed completion produced besides text. */
export interface StreamResult {
  toolCalls: ToolCall[];
  finishReason?: string;
  /**
   * Whether any text reached `onChunk` — including the reasoning fallback, which
   * streams a thinking-only reply as the answer. Read it as "the caller has
   * something to show", not as "a `content` delta arrived".
   */
  sawContent: boolean;
}

/** An OpenAI-style function schema advertised to the model. */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Chat streaming — via NVIDIA NIM or the Mistral API
// ---------------------------------------------------------------------------

export async function generateChatResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  opts?: { deepThink?: boolean },
) {
  // Models in the multi-provider catalogue go through the unified /api/llm
  // router, which walks that model's provider chain and streams from the first
  // one that answers. Every route in a chain serves the SAME model, so failing
  // over changes who served the reply, never what model produced it.
  if (getModel(modelId)) {
    await generateRoutedResponse(messages, modelId, onChunk, signal, opts);
    return;
  }

  // Legacy ids not yet migrated to the catalogue keep their direct proxies.
  // A failure surfaces as an error rather than being answered by a different
  // model — a silent substitution hides outages and misattributes the reply.
  if (isMistralModel(modelId)) {
    await generateMistralResponse(messages, modelId, onChunk, signal, opts);
    return;
  }

  await generateNvidiaChatResponse(messages, modelId, onChunk, signal, opts);
}

/**
 * Stream a catalogue model through the multi-provider router.
 *
 * The router walks the model's provider chain and streams from the first one
 * that answers, so a rate-limited or saturated provider falls through to the
 * next without changing which model produced the reply.
 */
export async function generateRoutedResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  opts?: { deepThink?: boolean; tools?: ToolSchema[]; toolChoice?: "auto" | "none" | "required" },
): Promise<StreamResult> {
  const spec = getModel(modelId)!;

  const maxTokens = Math.min(
    opts?.deepThink ? spec.maxOutputTokens : Math.floor(spec.maxOutputTokens / 2),
    spec.maxOutputTokens,
  );

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // A user's own key bypasses our shared quota entirely.
  for (const route of spec.routes) {
    const byokHeader = PROVIDERS[route.provider]?.byokHeader;
    const userKey = byokHeader ? getUserProviderKey(route.provider) : undefined;
    if (byokHeader && userKey) headers[byokHeader] = userKey;
  }

  // The router requires an authenticated caller so requests can be attributed and
  // metered; without a token the server answers 401 rather than spending the shared
  // free-tier pool on an anonymous request. fetchAsUser attaches the token and
  // replaces it if the server says it has expired.
  const { response, errText } = await fetchAsUser(apiPath("/api/llm"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      routes: spec.routes,
      messages,
      // See the NVIDIA path below — DeepThink trades creativity for care.
      temperature: opts?.deepThink ? 0.3 : 0.7,
      top_p: 0.95,
      max_tokens: maxTokens,
      // Only sent when the model supports tools. Pollinations (flyer-free) and
      // the vision engines do not, and a tool payload at an endpoint that
      // rejects it would burn the last fallback in the chain.
      ...(opts?.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      ...(opts?.toolChoice ? { tool_choice: opts.toolChoice } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    console.error("LLM router error:", response.status, errText);
    throw new Error(routerError(response.status, errText));
  }

  return pumpOpenAiStream(response, onChunk);
}

/**
 * `true` when a router failure is a token the client can replace.
 *
 * Deliberately narrow: only the server's own `token_expired`. Retrying an
 * `invalid_token` would be a retry loop on a credential that will never verify, and
 * retrying a 429 would spend a second request out of the quota that just ran out.
 */
function isRefreshableAuthFailure(status: number, errText: string): boolean {
  if (status !== 401) return false;
  try {
    return JSON.parse(errText)?.error === "token_expired";
  } catch {
    return false;
  }
}

/**
 * POST to one of our own serverless routes as the signed-in user, recovering from
 * an expired ID token without the user seeing it.
 *
 * Shared by every authenticated call rather than written per call site, because the
 * two call sites had drifted in opposite directions and each was wrong in its own
 * way: `/api/llm` sent a token and could not refresh it, and `/api/search` sent no
 * token at all. Both routes go through `applyMeter`, which meters a tokenless
 * request against `DAILY_LIMIT_GUEST` (10/day, keyed on a hashed IP) instead of
 * `DAILY_LIMIT_USER` (100/day) — so search quietly spent a guest allowance on
 * behalf of signed-in users, and the user tier the quota code implements was
 * unreachable from that path.
 *
 * Returns the response together with its error text, because deciding whether to
 * retry means reading the body and `Response.text()` can only be called once. The
 * text is empty on success, where the caller wants the undisturbed stream instead.
 */
export async function fetchAsUser(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<{ response: Response; errText: string }> {
  const base: Record<string, string> = { ...(init.headers ?? {}) };

  // A fresh header object per attempt, rather than one object mutated in place before
  // the retry. Behaviourally identical — `fetch` reads the headers when it builds the
  // request — but it keeps each attempt's headers readable *after* the fact, which is
  // what makes "the retry went out with a different token" observable at all. With a
  // shared object both attempts point at the same one and it holds only the last value.
  const send = (token?: string) =>
    fetch(url, {
      ...init,
      headers: token ? { ...base, Authorization: `Bearer ${token}` } : { ...base },
    });

  const idToken = await getIdToken();

  let response = await send(idToken);
  let errText = response.ok ? "" : await response.text().catch(() => "");

  // One retry, and only for an expired token.
  //
  // This is the reported bug. A Firebase ID token lives an hour, so any session
  // open longer than that presents a stale one — and the failure was terminal: the
  // server answered 401, nothing refreshed the token, and `routerError` had no
  // branch for it, so it fell through to `friendlyHttpError(401)` and told the user
  // "Authentication failed with the model service. Please check your API key."
  // There is no API key in this path. The user cannot act on that sentence, and the
  // app stayed broken until a full reload — the model simply stopped answering.
  if (isRefreshableAuthFailure(response.status, errText)) {
    const fresh = await getIdToken(true);
    // Only when the refresh produced a *different* token. Re-sending the same one
    // would be a second guaranteed 401, and on a signed-out client `getIdToken`
    // returns undefined, where the honest answer is the original 401 rather than an
    // identical unauthenticated retry.
    if (fresh && fresh !== idToken) {
      console.info("[auth] server rejected an expired token; retrying with a fresh one");
      response = await send(fresh);
      errText = response.ok ? "" : await response.text().catch(() => "");
    }
  }

  return { response, errText };
}

/**
 * Turn a router failure into something a user can act on. The router reports
 * *why* the whole chain failed, which is a different situation from one
 * provider being down and needs a different message.
 */
function routerError(status: number, errText: string): string {
  try {
    const parsed = JSON.parse(errText);
    if (parsed.error === "sign_in_required") {
      return "Please sign in to continue.";
    }
    // Reached only when the refresh-and-retry above also came back expired, so the
    // client has done everything it can. Says what happened and what fixes it, and
    // never mentions an API key: the previous behaviour fell through to
    // friendlyHttpError(401), whose text is "check your API key" — advice for a
    // BYOK failure, given to a signed-in user on the shared pool who has no key to
    // check. Wrong diagnosis, and unactionable.
    if (parsed.error === "token_expired") {
      return "Your session expired and could not be renewed. Reload the app, or sign in again.";
    }
    if (parsed.error === "invalid_token") {
      return "Your sign-in is no longer valid. Please sign out and sign in again.";
    }
    // Neither of the two above, and the distinction is worth the extra branch: the
    // token was never actually judged, because the service that judges it was
    // unreachable. Answering this with the `invalid_token` text would send someone
    // with a perfectly good session to sign out and back in over a network blip that
    // fixes itself — and they would, because the message told them to.
    if (parsed.error === "auth_unavailable") {
      return "Couldn't verify your sign-in just now — that check is temporarily unreachable. Your session is fine; try again in a moment.";
    }
    // A deployment fault, not a user fault. Distinguished because the user can do
    // nothing at all about this one and should not be sent to re-authenticate:
    // the server is holding a token it has no project id to verify against.
    if (parsed.error === "auth_not_configured") {
      return "The server is not configured for sign-in right now. This is a server-side problem, not yours — try again shortly.";
    }
    if (parsed.error === "quota_exceeded") {
      return parsed.detail || "You've reached today's message limit.";
    }
    if (parsed.error === "all_providers_rate_limited") {
      return "All providers are busy right now. Try again in a moment, or add your own API key in Settings for unlimited use.";
    }
    if (parsed.error === "no_provider_configured") {
      return "No AI provider is configured on the server.";
    }
    // Every route answered 404. Since 3.11 that is a *capacity* reading first and
    // an identity reading second — NVIDIA 404s a route that is merely unserved at
    // that moment (evidence in api/_failover.js) — so the advice is "try again",
    // not "that model is gone".
    if (parsed.error === "model_unavailable") {
      return "This model isn't being served right now. That's usually temporary — try again in a moment, or pick another model.";
    }
    // Every route answered 410 Gone. The opposite advice to the 404 branch above,
    // and the pairing is the point: 404 says retry because the id may well answer
    // in a minute, 410 must not, because it will not. Telling someone to retry a
    // retired model sends them round a loop that reads as an app bug rather than a
    // provider decision.
    if (parsed.error === "model_retired") {
      return "This model has been retired by its provider. Pick another model — your conversation is unaffected.";
    }
    // Nothing refused the request — every route in the chain went quiet. Worth
    // its own message because the generic one reads as "your request was wrong",
    // and the useful advice here is the opposite: retry, or pick another model.
    if (parsed.error === "all_providers_timed_out") {
      return "The model didn't respond in time. Try again, or switch to another model — some large models are slow to wake up.";
    }
    if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
  } catch {
    // Not JSON — fall through to the generic message.
  }
  return friendlyHttpError(status, "the model service");
}

async function generateNvidiaChatResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  opts?: { deepThink?: boolean },
) {
  const nvidiaModel = getNvidiaId(modelId);

  // Fail rather than guess. This path used to default an unknown id to
  // llama-3.1-8b, so a stale or misspelled id produced a confident answer from
  // a small model wearing the requested model's name.
  if (!nvidiaModel) {
    throw new Error(
      `"${modelId}" isn't a model we recognise any more. Pick another model from the list.`,
    );
  }

  const userKey = getUserNvidiaApiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userKey) headers["X-Nvidia-Api-Key"] = userKey;

  const response = await fetch(apiPath("/api/nvidia"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: nvidiaModel,
      messages,
      stream: true,
      // Lower temperature in DeepThink so careful reasoning isn't derailed by
      // sampling noise, and raise the ceiling so long derivations aren't cut off.
      temperature: opts?.deepThink ? 0.3 : 0.7,
      top_p: 0.95,
      max_tokens: opts?.deepThink ? 8192 : 4096,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("NVIDIA proxy error:", response.status, errText);

    try {
      const parsed = JSON.parse(errText);
      if (parsed.detail) throw new Error(parsed.detail);
      if (parsed.error && typeof parsed.error === "string") throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message !== errText) throw e;
    }
    throw new Error(friendlyHttpError(response.status, "NVIDIA NIM"));
  }

  await pumpOpenAiStream(response, onChunk);
}

// ---------------------------------------------------------------------------
// The pre-flight intent classifier used to live here — deleted in Phase 6
// ---------------------------------------------------------------------------
// `evaluateUserIntent` / `evaluateImageIntent` decided "does this turn need a
// web search or an image?" with a pile of regexes plus a call to a small utility
// model, *before* the real model had seen the turn. Two structural faults, not
// tuning problems:
//
//  - It had to guess without being able to read its own answer, so it was wrong
//    in both directions: searching for creative writing, and answering live
//    questions from a stale training snapshot.
//  - Every ambiguous turn cost an extra model call, all of it latency in front
//    of the first token, on the free-tier quota this app runs on.
//
// src/lib/agent.ts replaced it: the model that is writing the reply calls
// web_search / generate_image itself, and can search twice if the first results
// were thin — something a one-shot pre-flight decision cannot do.
//
// `getCompleteChatResponse` (a non-streaming wrapper) went with it: the
// classifier was its only caller. Anything needing a whole string can still
// accumulate deltas from `generateChatResponse`, which is what it did.
//
// Deliberate consequence: a model with `supportsTools: false` (`flyer-free` on
// Pollinations) no longer searches or generates images from a phrase like "draw
// me a cat" — it answers in prose. That is the same graceful degradation
// runAgentTurn already applies to search, and it is preferable to a keyword
// guess that fired on "write a story about drawing". Explicitly picking an
// Image model in the sidebar still generates, and that path needs no classifier.

// ---------------------------------------------------------------------------
// Vision — with automatic fallback across engines
// ---------------------------------------------------------------------------

// Route an image-analysis turn through the vision engines in order. The first
// engine that actually streams content wins. If an engine errors BEFORE any
// token arrives (404 pulled model, cold-start timeout, 5xx), the next engine is
// tried transparently. Once tokens have started we never switch — that would
// duplicate text mid-stream. Returns the id of the engine that answered.
export async function generateVisionResponse(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: unknown;
  for (const engineId of VISION_ENGINE_FALLBACKS) {
    let started = false;
    try {
      await generateChatResponse(
        messages,
        engineId,
        (delta) => { started = true; onChunk(delta); },
        signal,
      );
      return engineId; // completed successfully
    } catch (err) {
      // Never retry a user-initiated abort, and never fall back once the model
      // has already emitted content (avoids duplicated/garbled output).
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (started) throw err;
      lastErr = err;
      // else: try the next engine in the chain
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("All vision engines are currently unavailable. Please try again.");
}

// ---------------------------------------------------------------------------
// OCR — nemotron-parse document extraction
// ---------------------------------------------------------------------------
//
// Unlike the vision engine above, `nemotron-parse` is a non-conversational
// document utility: it takes an image (a rendered page or a photograph of a
// document) and returns the text it contains as structured regions — not a
// prose answer. Its contract is rigid in ways the chat engines are not:
//
//   * image-only content. Any text segment gets a hard 400 ("The model does
//     not support text input"); the caller must send just the image.
//   * one shot, non-streaming. The structured result arrives in a single
//     `markdown_bbox` tool_call on `choices[0].message`. Streamed, the same
//     model emits loose `<x_><y_><class_>` content tokens instead — a grammar
//     the caller would have to reassemble. Non-streaming keeps it intact.
//
// The route /api/ocr is a sibling of /api/nvidia (same key precedence, same
// retry set) but non-streaming. We flatten the regions here so `documents.ts`
// gets plain text it can feed straight into the document context block.

export interface OcrRegion {
  bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
  text: string;
  type: string;
}

export interface OcrResult {
  text: string;
  /** Non-empty regions in reading order, for callers that want structure. */
  regions?: OcrRegion[];
  /** Set when the service is down or rejected the image; text is then "". */
  error?: string;
}

/**
 * Parse the `markdown_bbox` tool-call a non-streamed nemotron-parse response
 * carries. Regions come as `[[{bbox,text,type}, ...]]` (a list containing one
 * list); we collapse that and drop the entries with no text — a photo returns a
 * single `Picture` region with `text: ""`, which is the honest empty case, not
 * an error. Output is joined in reading order (top-to-bottom, left-to-right)
 * so the model reads it like a page. Titles and list items keep their shape;
 * tables and plain text pass through verbatim.
 */
export function flattenOcrResponse(json: unknown): OcrResult {
  try {
    const choice = (json as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> })?.choices?.[0];
    const argsRaw = choice?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argsRaw) return { text: "", error: "ocr: no structured result in the response." };
    const parsed = JSON.parse(argsRaw) as OcrRegion[] | OcrRegion[][];
    const regions = (Array.isArray(parsed[0]) ? (parsed[0] as OcrRegion[]) : (parsed as OcrRegion[])).filter(
      (r) => r && typeof r.text === "string" && r.text.length > 0,
    );
    if (regions.length === 0) return { text: "" };

    // Reading order: sort by the top edge, then the left edge. Bboxes are
    // normalised to the image dimensions, so equal-floor regions compare left.
    regions.sort((a, b) => a.bbox.ymin - b.bbox.ymin || a.bbox.xmin - b.bbox.xmin);

    const lines = regions.map((r) => {
      const t = r.text.trim();
      switch (r.type) {
        case "Title":
        case "Section-header":
          return `${t}\n`;
        case "ListItem":
          return `- ${t}`;
        default:
          return t;
      }
    });
    return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), regions };
  } catch (e) {
    return { text: "", error: `ocr: could not parse the structured result (${e instanceof Error ? e.message : "parse error"}).` };
  }
}

/**
 * Run OCR on a single image via /api/ocr. The image must be a data: URL the
 * serverless function will forward to nemotron-parse. Non-streaming: returns
 * once the full structured result is back. Aborts cleanly on `signal`.
 */
export async function ocrImage(imageDataUrl: string, signal?: AbortSignal): Promise<OcrResult> {
  if (!imageDataUrl?.startsWith("data:image/")) {
    return { text: "", error: "ocr: a data: image URL is required (the service will not fetch remote URLs)." };
  }
  let res: Response;
  try {
    res = await fetch(apiPath("/api/ocr"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }] }],
        max_tokens: 2000,
      }),
      signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    return { text: "", error: "ocr: the OCR service could not be reached." };
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.detail || (await res.text()); } catch { /* ignore */ }
    return { text: "", error: `ocr: the OCR service rejected the request (${res.status}). ${String(detail).slice(0, 160)}` };
  }
  return flattenOcrResponse(await res.json());
}

async function generateMistralResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  opts?: { deepThink?: boolean },
) {
  const mistralModel = MODEL_REGISTRY[modelId]?.mistralId || "mistral-large-latest";

  const userKey = getUserMistralApiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userKey) headers["X-Mistral-Api-Key"] = userKey;

  const response = await fetch(apiPath("/api/mistral"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: mistralModel,
      messages,
      stream: true,
      // See generateNvidiaChatResponse — DeepThink trades creativity for care.
      temperature: opts?.deepThink ? 0.3 : 0.7,
      top_p: 0.95,
      max_tokens: opts?.deepThink ? 8192 : 4096,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("Mistral proxy error:", response.status, errText);
    try {
      const parsed = JSON.parse(errText);
      if (parsed.detail) throw new Error(typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail));
      if (parsed.error && typeof parsed.error === "string") throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message !== errText) throw e;
    }
    throw new Error(friendlyHttpError(response.status, "Mistral"));
  }

  // The Mistral API is OpenAI-compatible on the wire, so the same SSE pump works.
  await pumpOpenAiStream(response, onChunk);
}

/**
 * Which accumulator slot a streamed tool-call fragment belongs to.
 *
 * Exported for tests: the reassembly is the one place where a provider quirk
 * turns a correct model output into a tool error the user sees, and there is no
 * way to exercise it from outside without a live stream.
 */
export function slotIndexFor(
  call: { index?: unknown; id?: string },
  pending: Map<number, unknown>,
  slotForId: Map<string, number>,
  openSlot: number,
): number {
  if (typeof call.index === "number") {
    if (call.id) slotForId.set(call.id, call.index);
    return call.index;
  }
  if (call.id) {
    const known = slotForId.get(call.id);
    if (known !== undefined) return known;
    let fresh = pending.size;
    while (pending.has(fresh)) fresh += 1;
    slotForId.set(call.id, fresh);
    return fresh;
  }
  // Arguments-only continuation: it extends whichever call is open.
  return openSlot;
}

/**
 * Turn one OpenAI-compatible SSE response into streamed text plus whatever tool
 * calls it contained.
 *
 * Exported for tests. All three providers funnel through here, so a reassembly
 * bug is a bug in every model at once, and the failure mode is quiet: the model
 * asked for two tools and the loop reports malformed arguments. A fake Response
 * over a ReadableStream exercises it exactly as the network does, including the
 * part that actually breaks — fragments split at arbitrary byte boundaries.
 */
export async function pumpOpenAiStream(
  response: Response,
  onChunk: (text: string) => void,
): Promise<StreamResult> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoning = "";
  let sawContent = false;
  let finishReason: string | undefined;

  // Tool calls arrive fragmented: the id and name land in the first delta for an
  // index, then `arguments` streams in as a run of partial JSON strings that
  // must be concatenated in arrival order before they parse.
  //
  // `index` is the key when the provider sends one, and most do. Not all: a
  // delta carrying only an `id` has to open its own slot, or two calls collapse
  // into one whose `args` is the concatenation of two JSON documents — which
  // parses as nothing, so the model sees "arguments were not valid JSON" for a
  // call it wrote correctly. A delta with neither id nor index is an arguments
  // continuation and belongs to the slot that is currently open.
  const pending = new Map<number, { id: string; name: string; args: string }>();
  const slotForId = new Map<string, number>();
  let openSlot = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith(":") || !trimmedLine.startsWith("data:")) continue;

      const payload = trimmedLine.replace(/^data:\s*/, "");
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        // Reassemble tool calls before content: a turn that calls a tool often
        // streams no content at all, and dropping these is what made the model
        // look like it silently ignored the request.
        if (Array.isArray(delta?.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = slotIndexFor(call, pending, slotForId, openSlot);
            openSlot = index;
            const slot = pending.get(index) ?? { id: "", name: "", args: "" };
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name = call.function.name;
            // Concatenated, never replaced — each chunk is a slice of one JSON
            // document, so overwriting would leave only the final fragment.
            if (typeof call.function?.arguments === "string") {
              slot.args += call.function.arguments;
            }
            pending.set(index, slot);
          }
        }

        // Reasoning models (kimi, nemotron, minimax) stream their thinking in
        // `reasoning_content` and the answer in `content`. Emit content when it
        // exists; only fall back to reasoning when a turn produced nothing else,
        // so a thinking-only response is never silently empty.
        if (delta?.content) {
          sawContent = true;
          onChunk(delta.content);
        } else if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content;
        }
      } catch {
        // ignore JSON parse errors for incomplete chunks
      }
    }
  }

  // A tool-calling turn legitimately produces no content, so the reasoning
  // fallback must not fire there — it would print the model's private
  // deliberation about which tool to call as if it were the answer.
  const toolCalls = [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, slot]) => slot.name)
    .map(([index, slot]) => ({
      // The fallback carries the index. Without it, two calls to the same tool
      // in one step — "search these two things" — both become `call_web_search`,
      // and the loop then answers two calls with two tool messages sharing one
      // tool_call_id: providers reject that, and the ones that don't may pair the
      // wrong result with the wrong call.
      id: slot.id || `call_${index}_${slot.name}`,
      name: slot.name,
      // Left as a raw string: the executor parses it and needs to report a
      // malformed payload back to the model rather than throw here.
      argumentsJson: slot.args || "{}",
    }));

  // Some reasoning models spend their whole budget in `reasoning_content` and
  // never emit `content`. Surface the thinking rather than an empty answer.
  //
  // `sawContent` is set with it, because the flag answers "did text reach the
  // caller" — not "did a `content` delta arrive". The distinction is invisible
  // until something acts on the answer: the agent loop uses this flag to decide a
  // turn produced nothing and needs a stand-in message, and a reasoning-only reply
  // that left the flag false would get that message appended under the thinking it
  // had just streamed.
  if (!sawContent && !toolCalls.length && reasoning) {
    onChunk(reasoning);
    sawContent = true;
  }

  return { toolCalls, finishReason, sawContent };
}

function friendlyHttpError(status: number, providerLabel: string): string {
  if (status === 401 || status === 403) return `Authentication failed with ${providerLabel}. Please check your API key.`;
  // "Currently" is load-bearing and was verified in 3.11: NVIDIA returned 404 three
  // times running for an id that answered three times minutes later, so this must
  // not read as "that model no longer exists". Suggesting a retry before a switch
  // is the cheaper of the two actions and works about as often.
  if (status === 404)
    return "That model isn't being served by NVIDIA NIM right now. Try again in a moment, or pick a different one.";
  // 410 sits right next to 404 here on purpose, saying the opposite thing. This is
  // the direct-provider path (a user's own key going straight to NVIDIA/Mistral),
  // which has no failover chain and therefore no `model_retired` router code to
  // lean on — so the distinction has to be drawn again from the bare status.
  if (status === 410)
    return `That model has been retired by ${providerLabel} and won't come back. Pick a different one.`;
  if (status === 429) return "Rate limit reached. Please wait a moment and try again.";
  // 529 = NIM's "Service temporarily overloaded". The model exists and works;
  // its capacity pool is just saturated. Say so instead of implying it's broken.
  if (status === 529) return `That model is temporarily overloaded on ${providerLabel}. Retry in a few seconds, or switch models.`;
  if (status >= 500) return "The model service is temporarily unavailable. Please retry.";
  return `The model responded with an error (${status}).`;
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

// Turn a plain user request into a rich, intent-aware generation prompt. This
// is the "system prompt" for image models: it detects what the user is trying
// to make (logo, photo, art, 3D, anime, UI…) and appends the quality/style
// descriptors that steer the diffusion model toward that intent — the same way
// ChatGPT's image tool rewrites a bare request before generating.
export function buildImagePrompt(userPrompt: string): string {
  const base = (userPrompt || "").trim() || "a beautiful, highly detailed artistic image";
  const p = base.toLowerCase();

  const has = (...words: string[]) => words.some((w) => p.includes(w));

  let style: string;
  if (has("logo", "icon", "emblem", "brand")) {
    style = "clean professional vector logo, minimal, flat design, centered, crisp edges, high resolution, plain background";
  } else if (has("photo", "photograph", "realistic", "photorealistic", "portrait", "headshot")) {
    style = "photorealistic, natural lighting, shallow depth of field, professional photography";
  } else if (has("anime", "manga", "cartoon", "comic")) {
    style = "vibrant anime illustration, clean line art, cel shading, expressive, studio quality";
  } else if (has("3d", "render", "blender", "octane")) {
    style = "high-quality 3D render, physically based rendering, soft global illumination, cinematic";
  } else if (has("ui", "app", "website", "dashboard", "mockup", "interface")) {
    style = "clean modern UI design mockup, crisp, well-aligned, professional, high resolution";
  } else if (has("poster", "banner", "wallpaper", "cover")) {
    style = "striking poster art, bold composition, dramatic lighting, 4k";
  } else if (has("sketch", "drawing", "pencil", "line art")) {
    style = "detailed hand-drawn sketch, expressive linework, fine shading";
  } else {
    style = "highly detailed, masterpiece, vibrant, sharp focus, 4k, professional quality";
  }

  return `${base}. ${style}.`;
}

// Map our internal image model IDs to a valid Pollinations model name.
// Our IDs are already the exact Pollinations model names (verified live), so
// this is a passthrough with a safe "flux" fallback for anything unknown.
// "sana" was removed in 3.6: it is a retired NVIDIA genai id, not a Pollinations
// model, so a legacy caller asking for it falls back to "flux" here.
const POLLINATIONS_MODELS = new Set(["flux", "gptimage", "turbo", "stable-diffusion"]);
function pollinationsModelFor(modelId: string): string {
  return POLLINATIONS_MODELS.has(modelId) ? modelId : "flux";
}

// ---------------------------------------------------------------------------
// Prompt Engineering — 1000-word Master Prompts via Chat Model
// ---------------------------------------------------------------------------

// System prompt that turns any chat model into a Master Vision Prompt Engineer.
// When a user uploads files/images, the chat model first generates an exhaustive
// ~1000-word master analysis prompt that is supplied internally to the vision engine.
// Written as a *routing* prompt rather than a fixed template. The previous
// version demanded ~1000 words for every upload, which actively hurt precision:
// a pointed question ("what's the error on line 3?") came back as a full scene
// inventory with the answer buried, and the length quota pushed the engine into
// padding — the main source of hallucinated detail on sparse images.
const VISION_PROMPT_ENGINEER_SYSTEM = [
  "You are a Vision Prompt Engineer. You do NOT answer the user's question.",
  "You rewrite it into the single most effective instruction for a vision model that will receive the same image(s).",
  "",
  "STEP 1 — CLASSIFY the request into exactly one mode:",
  "  A. TARGETED — a specific question about one thing (a value, a line, a name, yes/no, 'is this right?').",
  "  B. EXTRACTION — the user wants content pulled out verbatim (text, code, table, handwriting, numbers).",
  "  C. DIAGNOSTIC — the user wants a problem found or explained (error screenshot, broken layout, failing test, medical/mechanical fault).",
  "  D. OPEN — genuinely open-ended ('describe this', 'what am I looking at', no text at all).",
  "",
  "STEP 2 — WRITE THE PROMPT for that mode, and only that mode:",
  "  A. TARGETED → Restate the user's exact question as the first line. Instruct: answer it directly in the first sentence, cite only the region of the image that supports it, then stop. Explicitly forbid a general description. 60-120 words.",
  "  B. EXTRACTION → Instruct verbatim transcription inside a fenced code block, preserving line breaks, indentation, spelling and casing exactly as shown, marking illegible spans as [illegible] rather than guessing. Specify reading order for multi-column layouts. Ban commentary before the block. 80-150 words.",
  "  C. DIAGNOSTIC → Instruct: transcribe the exact error/anomaly text first, state the single most likely root cause, then give the concrete fix. Require it to name what evidence in the image supports the diagnosis. 120-200 words.",
  "  D. OPEN → Now depth is warranted. Direct a structured pass: subject and setting, spatial layout, all legible text, notable details, then a short synthesis of what it is and what it is for. Use markdown headings. 200-400 words.",
  "",
  "UNIVERSAL RULES to embed in every prompt you write:",
  "- Report only what is visibly present. If something is ambiguous, say so instead of inferring.",
  "- Never invent text, numbers, names, or brands that are not legible.",
  "- If the image cannot support the request, say that plainly rather than substituting a general description.",
  "",
  "OUTPUT: the finished prompt text only — no preamble, no mode label, no quotes, no code fences around the whole thing.",
].join("\n");

/**
 * Clean a crafted vision prompt before it is handed to the vision engine.
 *
 * This ran as an inline `.replace(/<\s*think\s*>…<\s*\/\s*think\s*>/gi, "")` and was
 * a third, narrower copy of a rule `stripReasoning` already owns — narrower in the
 * two ways that matter here:
 *
 *   • **It knew one tag.** `chatModelId` is whatever the user selected, and this app
 *     ships several reasoning models; `REASONING_TAGS` lists five spellings because
 *     they emit five. `<thinking>` passed straight through.
 *   • **It required a closing tag.** A model that spends its whole budget thinking,
 *     or a stream cut off by the 22s first-byte / 50s chain guards, leaves the tag
 *     open — and a `[\s\S]*?` between two literals matches nothing at all when the
 *     second literal never arrives. So the *entire* chain-of-thought survived.
 *
 * That is not a cosmetic leak. The result is injected into the vision request as
 * "Analysis guidance" (see Chat.tsx), so the vision model was being instructed with
 * the chat model's internal deliberation. And the length gate made it *more* likely
 * to happen, not less: a chain-of-thought blob clears `>= 20` comfortably, where the
 * empty string this now produces correctly falls back to the user's own words.
 */
export function cleanCraftedVisionPrompt(raw: string, fallback: string): string {
  const cleaned = stripReasoning(raw || "").trim();
  return cleaned.length >= 20 ? cleaned : fallback;
}

export async function craftVisionPrompt(
  userPrompt: string,
  attachmentNames: string[],
  chatModelId: string,
  signal?: AbortSignal,
): Promise<string> {
  const fileContext = attachmentNames.length > 0
    ? `[Uploaded files: ${attachmentNames.join(", ")}]`
    : "";
  const base = `${userPrompt} ${fileContext}`.trim() || "Analyze the uploaded file/image in detail.";

  try {
    let crafted = "";
    await generateChatResponse(
      [
        { role: "system", content: VISION_PROMPT_ENGINEER_SYSTEM },
        { role: "user", content: base },
      ],
      chatModelId,
      (delta) => { crafted += delta; },
      signal,
    );
    return cleanCraftedVisionPrompt(crafted, base);
  } catch (err) {    if (err instanceof Error && err.name === "AbortError") throw err;
    return base;
  }
}

// The IMAGE_PROMPT_ENGINEER_SYSTEM prompt and `craftImagePrompt` used to sit
// here — a round-trip that asked a chat model to rewrite the user's request into
// a dense generation prompt before the renderer ever saw it. Phase 6 removed it:
// that guidance now lives in `generate_image`'s schema description (see
// src/lib/tools/generate-image.ts), so the model already writing the reply
// writes the generation prompt in the same breath instead of a second model
// being paid to rewrite it afterwards. The explicit Image-model path keeps
// `buildImagePrompt` below, which does the same intent-aware enrichment locally
// with no model call at all.

// Image-model id mapping. `pollinationsModelFor` translates a legacy or
// catalogue id (sana, sdxl-turbo, flux-schnell) into a name the endpoint
// recognises, and the constants below are the names known to be live.
//
// This is NOT a retry chain, despite reading like one: the URL below is handed
// straight to an <img>, so nothing here ever observes a failure and there is no
// point at which a second name could be tried. Only element [0] is used. A real
// retry lives where the failure is actually visible — the <img> onError in
// components/chat/ChatMessage.tsx. Kept as a list because the mapping still needs
// a fallback for an id with no Pollinations equivalent.
const IMAGE_MODEL_FALLBACKS = ["flux", "turbo", "stable-diffusion"];

function imageFallbackChain(modelId: string): string[] {
  const primary = pollinationsModelFor(modelId);
  // Primary first, then the known-live names, de-duplicated.
  return [...new Set([primary, ...IMAGE_MODEL_FALLBACKS])];
}

/**
 * How much of the prompt reaches the endpoint.
 *
 * This used to be 250, which quietly undid the instruction it was paired with:
 * `generate_image`'s schema asks the model for a 40-110 word prompt, and 250
 * characters cuts that off around word 40 — so the composition, lighting and
 * medium the model was told to specify were dropped from every single image, and
 * the schema's claim that truncation happens "in the text encoder" was false
 * because it happened here first.
 *
 * Measured against the live endpoint: 387 chars → 3.0s, 697 → 7.4s, and every
 * probe from ~1000 chars up sat at ~45s. 700 keeps the whole prompt for the word
 * count the schema asks for while staying in the band that returns promptly.
 */
const MAX_IMAGE_PROMPT_CHARS = 700;

/**
 * Pixel dimensions per aspect ratio — a real parameter, replacing the prose hint
 * that used to carry the ratio.
 *
 * `generate_image` has always accepted an `aspect_ratio` enum and used to fold it
 * into the prompt text as "tall vertical composition". That is a weak lever on a
 * diffusion model and it was also the *first thing truncated*, since the hint is
 * appended after the prompt and MAX_IMAGE_PROMPT_CHARS cuts from the end. A user
 * asking for a phone wallpaper got a square image.
 *
 * **Measured, not read off the docs** (`scripts/probe-image-size.mjs`), because the
 * documented `model` param on this same endpoint is a no-op — §3.8 — and shipping a
 * second nominal parameter would be that mistake twice:
 *
 *     no size param        -> 768x768
 *     width=576&height=1024 -> 576x1024   exact
 *     width=1024&height=576 -> 1024x576   exact
 *     width=888&height=664  -> 888x664    exact
 *     width=1024&height=1024 -> 768x768   downscaled, ratio kept
 *     width=1600&height=900  -> 1024x576  downscaled, ratio kept
 *
 * So width/height are honoured, and there is a **pixel budget of 589,824** —
 * exactly 768², which is also 1024x576 and 576x1024. Every entry below sits at or
 * just under it, so nothing is silently rescaled: ask for 1600x900 and the bytes
 * come back identical to 1024x576 (same md5), which is the endpoint quietly
 * ignoring half of what it was told. 4:3 is 888x664 = 589,632 rather than the
 * exact-ratio 886.8x665.1, because both axes want to be multiples of 8.
 *
 * Timing is not a reason to avoid this: the same probe measured 3.2-6.2s with the
 * params against 3.3s without.
 */
export const IMAGE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 768, height: 768 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "4:3": { width: 888, height: 664 },
  "3:4": { width: 664, height: 888 },
};

/** The requested ratio's canvas, or the square default for anything unknown. */
export function imageDimensionsFor(aspectRatio?: string): { width: number; height: number } {
  return IMAGE_DIMENSIONS[(aspectRatio || "").trim()] || IMAGE_DIMENSIONS["1:1"];
}

export async function generateImageResponse(
  prompt: string,
  modelId: string,
  _images: Array<{ dataUrl?: string }>,
  signal?: AbortSignal,
  /**
   * One of `IMAGE_DIMENSIONS`' keys. Optional and last, so the explicit
   * Image-model path in Chat.tsx — which has no ratio control in the UI — keeps
   * working unchanged and lands on the square default it already produced.
   */
  aspectRatio?: string,
): Promise<{ imageDataUrl: string; message: string }> {
  const fullPrompt = (prompt || "").trim() || buildImagePrompt("");
  // No fetch happens here, so there is nothing to cancel. Stop still works: the
  // turn's abort tears down the agent loop around this call, and the <img> that
  // loads the URL is unmounted with the message.
  void signal;

  // Pollinations direct URL via img tag. We skip POST since it is frequently
  // blocked by CORS or AdBlockers; the direct URL loads perfectly in an <img>
  // tag without needing JS fetch — and loads *progressively*, so the reply's
  // text arrives while the pixels are still generating instead of the whole turn
  // blocking on a request that can take 45 seconds.
  //
  // NVIDIA NIM's genai image path was removed in 3.6 — the /v1/genai/* endpoint
  // 404s for every model even with a valid key, so there is no NVIDIA leg to
  // try. modelId still feeds the mapping below so a caller that passes a legacy
  // id (sana, sdxl-turbo) still lands on a live Pollinations model.
  //
  // `_images` is unused and cannot be otherwise: the endpoint takes a prompt in
  // a URL path and has no img2img leg, so there is nowhere to put a reference
  // image. Editing an uploaded photo needs a provider that accepts one.

  const condensedPrompt = fullPrompt.length > MAX_IMAGE_PROMPT_CHARS
    ? fullPrompt.slice(0, MAX_IMAGE_PROMPT_CHARS - 3).replace(/\s+\S*$/, "") + "..."
    : fullPrompt;
  const encoded = encodeURIComponent(condensedPrompt);

  const fallbackModel = imageFallbackChain(modelId)[0] || "flux";
  // Dimensions are always sent, even for 1:1 — the endpoint's own default is
  // 768x768, so the square case is a no-op that keeps one URL shape instead of
  // two.
  const { width, height } = imageDimensionsFor(aspectRatio);
  const directUrl =
    `https://image.pollinations.ai/prompt/${encoded}` +
    `?nologo=true&model=${fallbackModel}&width=${width}&height=${height}`;
  return {
    imageDataUrl: directUrl,
    message: "Here is your generated image:",
  };
}

/**
 * Turn a title model's raw output into a conversation title, or `null` when it did
 * not produce one.
 *
 * Extracted from `generateSmartChatTitle`, where it was an inline chain with an
 * ordering bug: `.trim()` came **last**, so `^title:` was tested against text that
 * still had the model's leading whitespace on it. Measured against the shipped chain,
 * three of four ordinary inputs kept the label —
 *
 *     "Title: Photo Analysis"                    -> "Photo Analysis"
 *     "\nTitle: Photo Analysis"                  -> "Title: Photo Analysis"
 *     "  Title: Photo Analysis"                  -> "Title: Photo Analysis"
 *     "<think>hm</think>\nTitle: Photo Analysis" -> "Title: Photo Analysis"
 *
 * — so the conversation appeared in the sidebar as *"Title: Photo Analysis"*, spending
 * one of its five words on the word "Title". The fourth line is the same defect
 * reached from the other side: a strip leaves the whitespace that surrounded what it
 * removed.
 *
 * **What actually closes it is `stripReasoning`'s own trailing `.trim()`**, which runs
 * before anything here does. That was established by mutation rather than assumed —
 * reverting this function to the shipped order left the leading-newline test green,
 * because the strip had already eaten the newline. The explicit `.trim()` below is
 * therefore belt-and-braces, and worth keeping precisely because the alternative is a
 * correctness property of this function resting on another function's last line: no
 * input can distinguish the two today, and `stripReasoning` has no contract that says
 * it trims.
 *
 * `\s+` rather than the shipped `\n+` for the interior collapse, which is a real fix
 * and not tidying: a tab or a double space survived, `split(" ")` counted it as a word
 * boundary, and the empty string it produced silently cost one of the five words.
 *
 * The reasoning strip is `stripReasoning` rather than a local `<think>` regex, for
 * the reasons in `cleanCraftedVisionPrompt` — less load-bearing here, since this path
 * is pinned to `ministral-8b`, but a second divergent copy of a rule is how the first
 * one survived. It runs *inside* this function rather than at the call site so that
 * the whole cleanup is one owned path with one set of tests; a caller cannot forget
 * half of it.
 *
 * Two behaviours kept deliberately:
 *
 *   • **Punctuation is stripped, including `.` and `_`.** "Node.js Setup" becomes
 *     "Nodejs Setup", which is worse than ideal and better than the alternative it
 *     was chosen over — models wrap titles in quotes and asterisks constantly, and a
 *     sidebar full of `**Bold Title**` is the failure this prevents.
 *   • **A response over 45 characters is rejected outright** rather than sliced to
 *     five words. Length is the signal that the model answered instead of titling
 *     ("Sure! Here is a concise title for…"), and the first five words of a preamble
 *     are a worse title than the caller's own fallback.
 */
export function cleanGeneratedTitle(raw: string): string | null {
  const cleaned = stripReasoning(raw || "")
    .trim()
    .replace(/["'`#*._]/g, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 2 || cleaned.length > 45) return null;

  return cleaned
    .split(" ")
    .slice(0, 5)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
    .join(" ")
    .trim();
}

/**
 * Smart Short Title Generator for Chat Conversations (ChatGPT-style).
 * Strictly uses Mistral 8B (ministral-8b) via Mistral API to generate a concise 2 to 4 word summary title.
 */
export async function generateSmartChatTitle(
  firstMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const text = (firstMessage || "").trim();
  if (!text || text.length < 2) return "New Chat";

  try {
    const prompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are an AI Title Generator. Generate a concise, clear 2 to 4 word title summarizing the user's prompt. Output ONLY the raw title text. Do NOT use quotation marks, punctuation, or words like 'Title:'. Keep it under 35 characters.",
      },
      { role: "user", content: text },
    ];

    let titleText = "";
    // Strictly invoke Mistral 8B (ministral-8b) on Mistral API
    await generateMistralResponse(
      prompt,
      "ministral-8b",
      (chunk) => { titleText += chunk; },
      signal,
    );

    const cleaned = cleanGeneratedTitle(titleText);
    if (cleaned) return cleaned;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.warn("Mistral 8B title generation fallback:", err);
  }

  // Clean fallback: Extract 2-4 clean words from user message
  const words = text.replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words
      .slice(0, 4)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  return text.slice(0, 30);
}

