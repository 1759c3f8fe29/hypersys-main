

import { auth } from "./firebase";
import {
  getModel,
  PROVIDERS,
  isImageModel as catalogueIsImage,
  isVisionModel as catalogueIsVision,
  supportsVision as catalogueSupportsVision,
  type ProviderId,
} from "./providers";

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
 */
async function getIdToken(): Promise<string | undefined> {
  try {
    return await auth.currentUser?.getIdToken();
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

  // The router requires an authenticated caller so requests can be attributed
  // and metered; without a token the server answers 401 rather than spending
  // the shared free-tier pool on an anonymous request.
  const idToken = await getIdToken();
  if (idToken) headers["Authorization"] = `Bearer ${idToken}`;

  // A user's own key bypasses our shared quota entirely.
  for (const route of spec.routes) {
    const byokHeader = PROVIDERS[route.provider]?.byokHeader;
    const userKey = byokHeader ? getUserProviderKey(route.provider) : undefined;
    if (byokHeader && userKey) headers[byokHeader] = userKey;
  }

  const response = await fetch("/api/llm", {
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
    const errText = await response.text().catch(() => "");
    console.error("LLM router error:", response.status, errText);
    throw new Error(routerError(response.status, errText));
  }

  return pumpOpenAiStream(response, onChunk);
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
    if (parsed.error === "quota_exceeded") {
      return parsed.detail || "You've reached today's message limit.";
    }
    if (parsed.error === "all_providers_rate_limited") {
      return "All providers are busy right now. Try again in a moment, or add your own API key in Settings for unlimited use.";
    }
    if (parsed.error === "no_provider_configured") {
      return "No AI provider is configured on the server.";
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

  const response = await fetch("/api/nvidia", {
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

  const response = await fetch("/api/mistral", {
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

async function pumpOpenAiStream(
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
  // must be concatenated in arrival order before they parse. Keyed by index
  // because a model may open several calls in one turn and interleave them.
  const pending = new Map<number, { id: string; name: string; args: string }>();

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
            const index = typeof call.index === "number" ? call.index : 0;
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
    .map(([, slot]) => slot)
    .filter((slot) => slot.name)
    .map((slot) => ({
      id: slot.id || `call_${slot.name}`,
      name: slot.name,
      // Left as a raw string: the executor parses it and needs to report a
      // malformed payload back to the model rather than throw here.
      argumentsJson: slot.args || "{}",
    }));

  // Some reasoning models spend their whole budget in `reasoning_content` and
  // never emit `content`. Surface the thinking rather than an empty answer.
  if (!sawContent && !toolCalls.length && reasoning) onChunk(reasoning);

  return { toolCalls, finishReason, sawContent };
}

function friendlyHttpError(status: number, providerLabel: string): string {
  if (status === 401 || status === 403) return `Authentication failed with ${providerLabel}. Please check your API key.`;
  if (status === 404) return "That model is currently unavailable on NVIDIA NIM. Try a different one.";
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
    const cleaned = crafted
      .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
      .trim();
    return cleaned.length >= 20 ? cleaned : base;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
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

// Image-model fallback order: the requested model first, then 2 proven
// alternates. If a Pollinations model 500s / times out (a model can go down or
// get gated to the paid tier), the next one is tried so generation still
// succeeds. "flux" (quality) → "turbo" (fast) → "stable-diffusion" (baseline).
const IMAGE_MODEL_FALLBACKS = ["flux", "turbo", "stable-diffusion"];

function imageFallbackChain(modelId: string): string[] {
  const primary = pollinationsModelFor(modelId);
  // Primary first, then the standard fallbacks, de-duplicated.
  return [...new Set([primary, ...IMAGE_MODEL_FALLBACKS])];
}

export async function generateImageResponse(
  prompt: string,
  modelId: string,
  _images: Array<{ dataUrl?: string }>,
  signal?: AbortSignal,
): Promise<{ imageDataUrl: string; message: string }> {
  const fullPrompt = (prompt || "").trim() || buildImagePrompt("");
  void signal;

  // Pollinations direct URL via img tag. We skip POST since it is frequently
  // blocked by CORS or AdBlockers; the direct URL loads perfectly in an <img>
  // tag without needing JS fetch.
  //
  // NVIDIA NIM's genai image path was removed in 3.6 — the /v1/genai/* endpoint
  // 404s for every model even with a valid key, so there is no NVIDIA leg to
  // try. modelId still feeds the fallback chain below so a caller that passes a
  // legacy id (sana, sdxl-turbo) still lands on a live Pollinations model.

  const condensedPrompt = fullPrompt.length > 250
    ? fullPrompt.slice(0, 247).replace(/\s+\S*$/, "") + "..."
    : fullPrompt;
  const encoded = encodeURIComponent(condensedPrompt);

  const fallbackModel = imageFallbackChain(modelId)[0] || "flux";
  const directUrl = `https://image.pollinations.ai/prompt/${encoded}?nologo=true&model=${fallbackModel}`;
  return {
    imageDataUrl: directUrl,
    message: "Here is your generated image:",
  };
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

    const cleaned = titleText
      .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
      .replace(/["'`#*._]/g, "")
      .replace(/^title:\s*/i, "")
      .replace(/\n+/g, " ")
      .trim();

    if (cleaned.length >= 2 && cleaned.length <= 45) {
      return cleaned
        .split(" ")
        .slice(0, 5)
        .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
        .join(" ")
        .trim();
    }
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

