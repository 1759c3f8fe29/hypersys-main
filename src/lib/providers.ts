// ---------------------------------------------------------------------------
// Provider registry and fallback routing
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
//
// The app is free for end users, which means *we* absorb the inference cost.
// We serve it from three providers we already run: NVIDIA NIM and Mistral (both
// keyed, generous free/credit tiers) and Pollinations (keyless, no account) as
// a last-resort fallback so the app can still answer even if both keyed
// providers are down or rate limited.
//
// Design rule enforced here: a given model has exactly ONE source. If NVIDIA or
// Mistral serves it, it is never *also* routed elsewhere. Duplicating a model
// across providers would mean the user picks one thing and a different backend
// answers, which misattributes the reply. The only cross-provider fallbacks are
// for distinct utility roles (e.g. the small classifier), never for the same
// model. Users who need more than the shared pool can supply their own key
// (BYOK), which bypasses our quota — see getUserProviderKey() in ai.ts.
//
// All providers are OpenAI-compatible on the wire, so one request shape and one
// SSE parser cover all of them.

// The failure-classification sets, defined once in the serverless router that
// production requests actually go through. Dependency-free by design so this
// import ships three sets of integers to the browser and nothing else.
import { FAILOVER_STATUSES } from "../../api/_failover.js";

export type ProviderId = "nvidia" | "mistral" | "pollinations" | "tokenrouter";

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible chat completions endpoint. */
  baseUrl: string;
  /** Server env var holding the key. Never VITE_-prefixed — that would inline it into the bundle. Empty for keyless providers. */
  envKey: string;
  /** Header a user's own (BYOK) key arrives on, if this provider supports BYOK. */
  byokHeader?: string;
  /** True when the provider needs no API key at all (Pollinations). */
  keyless?: boolean;
  /** Whether the provider's OpenAI-compatible surface supports `tools`. */
  supportsTools: boolean;
  /** Whether image_url content parts are accepted. */
  supportsVision: boolean;
  /**
   * Free-tier notes, for the settings UI and for our own planning. These change
   * frequently — treat them as documentation, not as something to enforce
   * against. The authoritative limit is whatever the provider's 429 says.
   */
  freeTier: string;
}

// The fallback chain walks PROVIDER_ORDER. Keyed, higher-quality providers are
// tried first; the keyless provider is the final safety net so a reply still
// arrives when the others are exhausted.
export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    envKey: "NVIDIA_API_KEY",
    byokHeader: "x-nvidia-api-key",
    supportsTools: true,
    supportsVision: true,
    freeTier: "Free credits. Returns 529 when a model's capacity pool is saturated.",
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    envKey: "MISTRAL_API_KEY",
    byokHeader: "x-mistral-api-key",
    supportsTools: true,
    supportsVision: true,
    freeTier: "Free experimentation tier on La Plateforme.",
  },
  tokenrouter: {
    id: "tokenrouter",
    label: "TokenRouter",
    baseUrl: "https://api.tokenrouter.com/v1/chat/completions",
    envKey: "TOKENROUTER_API_KEY",
    byokHeader: "x-tokenrouter-api-key",
    supportsTools: true,
    supportsVision: false,
    freeTier: "Hosted open models (glm-5.3-free). Both OpenAI and Anthropic surfaces.",
  },
  pollinations: {
    id: "pollinations",
    label: "Pollinations",
    baseUrl: "https://text.pollinations.ai/openai",
    envKey: "",
    keyless: true,
    supportsTools: false,
    supportsVision: false,
    freeTier: "Keyless and free — no account or key. Used as the final fallback.",
  },
};

export const PROVIDER_ORDER: ProviderId[] = [
  "nvidia",
  "mistral",
  "tokenrouter",
  "pollinations",
];


// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

export interface ModelRoute {
  provider: ProviderId;
  /** The exact model id this provider expects. */
  modelId: string;
  /**
   * Extra time-to-first-byte headroom this route is known to need beyond the
   * router's per-attempt cap (FIRST_BYTE_TIMEOUT_MS in api/llm.js). The router
   * already gives a *last* route the whole remaining chain budget, so this
   * field exists for the client: Chat.tsx adds the largest declared allowance
   * on any non-primary route to REQUEST_TIMEOUT_MS so its abort never fires
   * while a healthy slow leg is still answering. Declare it only from a
   * measured figure (see the default model's flash leg), never a guess.
   */
  firstByteAllowanceMs?: number;
}

export interface ModelSpec {
  /** Our stable internal id, used in the UI and persisted with each message. */
  id: string;
  /** Full display name, e.g. "Nemotron 3 Ultra 550B". */
  label: string;
  /**
   * Shorter label for the collapsed picker chip, where the full name would wrap.
   * Falls back to `label`.
   */
  shortLabel?: string;
  description: string;
  /**
   * Where to send this model, in preference order.
   *
   * RULE (made absolute 2026-09-13, maintainer's direction — "use real model
   * not alias"): every entry has exactly ONE route, naming the exact model id
   * the entry's label promises. A second route used to be allowed when it was
   * the same weights on a different provider, or as a documented exception
   * for service/capability names ("Flyer", "Flyer Vision"); the maintainer
   * overruled both exceptions, so the array shape remains only because
   * api/llm.js walks routes generically. Today every routes array in this file
   * has length 1 — adding a second entry of ANY kind is reintroducing the
   * alias, and the visible-failure behaviour of a dead route is the honest
   * one: the user sees the error and picks another named model themselves.
   */
  routes: ModelRoute[];
  /** Total context window in tokens. Used by the token budgeter. */
  contextWindow: number;
  /** Max tokens we will ask for in a single completion. */
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
  /** Reasoning models stream chain-of-thought in `reasoning_content`. */
  isReasoning?: boolean;

  // --- Presentation -------------------------------------------------------
  // These live here rather than in a parallel UI array because a second
  // hardcoded catalogue in the sidebar is exactly how the ids drifted apart:
  // the picker offered models the router had never heard of, so getModel()
  // returned undefined and the request silently fell through to a legacy proxy.
  // One list, or it happens again.

  /** Shown beside the name in the picker. */
  emoji: string;
  /** Which section of the picker this belongs to. */
  kind: "Chat" | "Vision" | "Image";
  /** Surfaced before the user expands the full list. */
  featured?: boolean;
  /**
   * Internal-only: kept out of the picker. Used for roles the product needs but
   * the user never picks, like the cheap utility model.
   */
  hidden?: boolean;
}


// Open-weight frontier models. The premise of this project is that the gap
// between these and the closed frontier models is now small enough that a good
// product built on them is competitive — so the catalogue leans on the strongest
// open models rather than trying to match GPT/Claude/Gemini weights directly.
//
// THIS IS THE ONLY MODEL CATALOGUE. The sidebar used to carry a second
// hardcoded array (AI_MODELS) whose ids had drifted from these, so most user
// selections resolved to nothing here and fell through to a legacy proxy. The
// picker is now derived from this list; do not reintroduce a parallel one.
//
// Every NVIDIA and Mistral id below was confirmed present in the live provider
// catalogue by `npm run verify:models`. Each model has a single source — NVIDIA,
// Mistral, TokenRouter, or Pollinations — never duplicated across providers, so
// the backend that answers always matches the model the user picked. Since
// 2026-09-13 every entry is also single-ROUTE: no entry carries a fallback leg
// of different weights under its name, whether the name is a set of weights
// ("DeepSeek V4 Flash") or a service/capability name ("Flyer", "Flyer Vision") —
// the maintainer overruled the old exceptions ("use real model not alias").
//
// Re-run `npm run verify:models` after changing anything here. Provider
// catalogues churn, and an unverified id fails at request time.
export const MODELS: ModelSpec[] = [
  // --- Chat / reasoning ----------------------------------------------------
  // The former default (3.12 → 2026-09-07; the default is now glm-5.3-free,
  // above). DeepSeek V4 Flash 0731 — the model "Flyer" originally named.
  // TTFB, measured 2026-09-07 after the quote-strip bug fix unblocked
  // probing: 144s streamed bare (status 200, first byte at 144s). With a
  // tools payload it never produced a first byte inside 300s on five
  // consecutive probes — one with the exact production five-tool shape.
  // Tool-capable and reasoning-capable. Vision is NOT supported, so image
  // turns still route through the vision engine (see VISION_ENGINE_MODEL in
  // ai.ts) rather than this entry.
  //
  // HISTORY — the chain this entry used to carry. It was added 2026-09-06 on
  // the user's direction as a three-leg all-NIM chain (flash → lightning-30b
  // → gpt-oss-120b), later re-cut as GLM → mistral-medium → flash, both times
  // under the "service name" exception to the one-source rule. That exception
  // was retired 2026-09-13 ("use real model not alias"): whichever weights
  // this picker entry names are the ones that answer, and a failed route is a
  // visible error the user can act on, not a silent swap. The probes that
  // shaped the old chains still matter as measurements of the individual
  // models (they are recorded on each model's own entry); they no longer
  // justify any chain shape.
  // The default, since 2026-09-07. GLM 5.3 (free tier) via TokenRouter — the
  // model a new conversation starts on, promoted on the user's explicit
  // direction after the Flash TTFB measurements came in: Flash answers bare
  // (200 at 144s streamed TTFB) but wedges with a tools payload (five probes,
  // five >300s aborts — one with the exact production five-tool shapes), so it
  // could not be a reliable *first* leg. GLM 5.3 measured 2.9s bare / 2.2s
  // with tools on the same day's probes, which is the "first message fast"
  // property the user asked the default to have.
  //
  // It streams `reasoning_content` deltas ahead of `content` — the same
  // reasoning-stream shape ai.ts already parses for kimi/nemotron — so the
  // thinking tier renders its reasoning live. isReasoning: true reflects that
  // observed behaviour, not a vendor spec sheet.
  //
  // FALLBACK CHAIN — RESTORED 2026-09-13 on the maintainer's explicit
  // direction. An earlier pass today read "use real model not alias" as an
  // order to delete this chain and went single-route; the maintainer has now
  // corrected that reading: the complaint was about mislabeled *entries*, not
  // about insurance on the default. The chain is back, two legs, both named:
  //   1. z-ai/glm-5.3-free (TokenRouter) — the default, 2.9s bare / 2.2s with
  //      tools (measured 2026-09-07).
  //   2. deepseek-ai/deepseek-v4-flash-0731 (NVIDIA) — 144s bare TTFB, so it
  //      must be LAST: only the last position gets the isLastRoute relaxation
  //      past the 22s first-byte cap. It wedges with a tools payload on this
  //      key, but a tools turn that falls this far is better served slowly
  //      than not at all.
  // A mistral middle leg was considered and left out deliberately: the
  // mistral-medium route is its own picker entry now, and the old
  // open-mistral-nemo leg (2026-09-12) skipped tool calls on streamed tool
  // passes — the exact failure a chain exists to absorb. flash's
  // firstByteAllowanceMs: 90_000 below is what keeps the client's guard ahead
  // of the 190s chain budget the server grants this entry.
  {
    id: "glm-5.3-free",
    // The picker name is "Flyer" (user-directed, 2026-09-07). The id stays
    // glm-5.3-free (the stable key for stored selections), so nothing breaks
    // for users who already have it selected.
    label: "Flyer",
    shortLabel: "Flyer",
    description: "The default model. GLM 5.3 reasoning with tools.",
    routes: [
      { provider: "tokenrouter", modelId: "z-ai/glm-5.3-free" },
      {
        provider: "nvidia",
        modelId: "deepseek-ai/deepseek-v4-flash-0731",
        // LAST leg only — this position's server-side isLastRoute relaxation
        // is what lets it spend the whole chain budget (144s TTFB measured).
        firstByteAllowanceMs: 90_000,
      },
    ],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
    emoji: "🪽",
    kind: "Chat",
    featured: true,
  },
  {
    id: "deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash",
    shortLabel: "DS V4 Flash",
    description: "DeepSeek's compact reasoning model.",
    // The previous default (3.12 → 2026-09-07), demoted but kept selectable.
    // Measured 2026-09-07: bare streamed TTFB 144s (200); with a tools payload
    // it wedged >300s on five consecutive probes.
    //
    // ITS OWN LEGS DELETED 2026-09-13 ("use real model not alias" — the
    // Lightning and gpt-oss legs answered under the Flash name on failover),
    // then the situation changed twice: flash stayed selectable under its own
    // name, and it was restored as the LAST leg of the Flyer chain above.
    // The two roles are the same weights wearing two honest hats: here it
    // answers under its own name (and needs the 90s allowance to make it
    // through its own 144s cold start), and there it is insurance under a
    // service name — the exception the maintainer has always granted the
    // default model.
    routes: [
      {
        provider: "nvidia",
        modelId: "deepseek-ai/deepseek-v4-flash-0731",
        // Measured 2026-09-07: 144s streamed bare TTFB on this key. Single
        // route, therefore the last route — the server gives it the whole
        // chain budget, and the client's guard must clear the same 144s or it
        // would abort the answer the user is waiting for.
        firstByteAllowanceMs: 90_000,
      },
    ],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
    emoji: "🪽",
    kind: "Chat",
    featured: true,
  },
  {
    id: "deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro",
    shortLabel: "DS V4 Pro",
    description: "DeepSeek's frontier reasoning model.",
    routes: [{ provider: "nvidia", modelId: "deepseek-ai/deepseek-v4-pro-0813" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
    emoji: "🐋",
    kind: "Chat",
    featured: true,
  },
  // Mistral Large, the previous default, demoted from the "Flyer" name (which
  // moved to deepseek-v4-flash-0731 above). Its unique selling point remains:
  // the one flagship that is both tool- AND vision-capable on a single route.
  //
  // HIDDEN 2026-09-11, two signals meeting the bar this file uses everywhere:
  // mistral-large-2512 has left Mistral's /v1/models listing, and the chat
  // endpoint answers 403 tier_not_allowed (code 1910) on the same key that
  // still 200s ministral-8b — the free-tier wall this catalogue already
  // documented for the glm chain (the catalogue entry above records it hitting
  // large before the EOL batch). Unlike a 429 this is not capacity: no retry
  // and no later session changes it, and unlike a 404 it is not ambiguous.
  //
  // Hidden rather than deleted: messages in Firestore carry this id and would
  // lose their byline on delete — the same reason glm-5.2 is hidden. To
  // restore: confirm the id is back in /v1/models AND a chat probe answers
  // on the free-tier key, then drop `hidden`.
  {
    id: "mistral-large",
    label: "Mistral Large",
    description: "Strong all-rounder that reads images and uses tools.",
    routes: [{ provider: "mistral", modelId: "mistral-large-2512" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    emoji: "🇫🇷",
    kind: "Chat",
    hidden: true,
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    description: "Moonshot's long-context reasoning model.",
    // Was moonshotai/kimi-k3 until 3.9. That id is still in NVIDIA's /v1/models
    // list but POST /v1/chat/completions returned 404 for it — the failure the
    // catalogue check alone cannot see. K3 is the current generation on the same
    // endpoint. Re-run scripts/verify-models.mjs after touching this: the probe
    // there is what separates "the id exists" from "the id answers".
    //
    // CAVEAT ADDED IN 3.11: "listed and not deployed" is a weaker conclusion than
    // it looked at the time. NVIDIA also 404s ids it is temporarily not serving —
    // nemotron-3-super-120b-a12b returned 404 three times running and then answered
    // three times running minutes later. So k3 may well have been alive and the
    // move to K3 made on a bad moment. No harm done, since K3 is the newer model
    // and answers in under a second, but the reasoning was luckier than it was
    // sound. `node scripts/probe-id.mjs moonshotai/kimi-k3 --times 3` settles it
    // if k3 is ever wanted back.
    routes: [{ provider: "nvidia", modelId: "moonshotai/kimi-k3" }],
    contextWindow: 256_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
    emoji: "🌙",
    kind: "Chat",
    featured: true,
  },
  {
    id: "nemotron-ultra",
    label: "Nemotron 3 Ultra 550B",
    shortLabel: "Nemotron Ultra",
    description: "NVIDIA's 550B flagship for agentic work.",
    // HISTORY: answered http-503 on a verify-models run in 3.10 — a saturated
    // capacity pool, which is what a 550B-A55B deployment does under load, not a
    // bad id (it has answered on every other run). Left featured and selectable
    // on the principle glm-5.2 established: one transient status is not evidence.
    //
    // That principle is worth stating carefully now that glm-5.2 has itself been
    // hidden, because the two cases are not the same and the difference is the
    // whole point. glm-5.2 was kept through an unresponsive probe and vindicated;
    // it was hidden only once a 410 Gone arrived *and* its id disappeared from
    // /v1/models. What retires a model here is an unambiguous permanent status
    // corroborated by a second independent signal — never a count of bad days.
    //
    // It did expose a real bug, though. 503 was treated as transient by both
    // RETRY_STATUSES and FAILOVER_STATUSES in api/llm.js but as permanent by the
    // final error classification, so this model — the one with a single route and
    // therefore no failover at all — surfaced the raw upstream error body in the
    // chat instead of "busy, try again". See OVERLOAD_STATUSES there.
    //
    // nemotron-super-120b below was added partly as the answer to this: same
    // family, a twelfth of the active parameters, so it should stay available when
    // this pool does not. Adding it as a *route* here would have been wrong —
    // different weights answering under this model's name is the one substitution
    // this catalogue refuses.
    routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
    emoji: "🔱",
    kind: "Chat",
    featured: true,
  },
  {
    id: "minimax-m3",
    label: "MiniMax M3",
    description: "MiniMax flagship chat model.",
    routes: [{ provider: "nvidia", modelId: "minimaxai/minimax-m3" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    emoji: "🚀",
    kind: "Chat",
    featured: true,
  },
  {
    id: "glm-5.2",
    label: "GLM 5.2",
    description: "Zhipu's frontier open reasoning model.",
    // Was hosted by NVIDIA. It is gone.
    //
    // HISTORY, in order, because the shape of it is the lesson:
    //   3.8 — the id verified but would not return a completion. 6 POST attempts
    //         (50-170s each, stream and non-stream, with and without the
    //         nca-allowed-client header) got no HTTP response at all.
    //   3.9 — it answered in 7.8s on the standard probe. So 3.8 was a cold or
    //         saturated capacity pool, not a bad id, and the model stayed
    //         selectable. This became the precedent for reading one unresponsive
    //         probe as provisional rather than as grounds for deletion.
    //   now — HTTP 410 Gone, and the id has disappeared from /v1/models (the
    //         catalogue went 103 → 102 entries).
    //
    // 410 is categorically different from everything above and from the 404s that
    // NVIDIA also returns for transient unavailability. 404 means "not found",
    // which a loaded pool and a retired model produce identically — that
    // ambiguity is exactly why 404 fails over and why one 404 is never evidence.
    // 410 means "was here, deliberately removed, do not ask again", and the
    // vanished catalogue entry is the corroborating second signal. Two independent
    // observations agreeing is the bar this file uses before hiding anything, and
    // 410 plus a shrunken catalogue clears it.
    //
    // So: hidden, not deleted. It was `featured: true` with a SINGLE route, which
    // meant every user who picked it from the front of the model list got a hard
    // failure with no failover path — the worst configuration a dead id can have.
    // Kept in MODELS (rather than deleted) because getModel resolves against
    // the full list, so every message already in Firestore that carries this id
    // keeps its "GLM 5.2" byline. There is no alias layer to consult.
    //
    // To restore: confirm `z-ai/glm-5.2` is back in /v1/models, then drop `hidden`
    // and re-probe. A 410 does not come back on its own.
    routes: [{ provider: "nvidia", modelId: "z-ai/glm-5.2" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
    emoji: "🔷",
    kind: "Chat",
    hidden: true,
  },
  {
    id: "llama-70b",
    label: "Llama 3.3 70B",
    description: "Reliable open all-rounder.",
    routes: [{ provider: "nvidia", modelId: "meta/llama-3.3-70b-instruct" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    emoji: "🐘",
    kind: "Chat",
    // Not `featured` and not selectable: this id is in NVIDIA's catalogue but its
    // POST never came back — 4 probe attempts across 3.9, two of them with a full
    // 60s deadline, while nine other NVIDIA routes on the same key answered in
    // under 2s. It has never once answered here — which is what separates it from
    // glm-5.2 above, whose bad run in 3.8 was followed by a clean 7.8s probe. (That
    // model is now hidden too, but for an unrelated and much clearer reason: a 410
    // and a vanished catalogue entry.)
    //
    // Hidden rather than deleted: messages already in Firestore carry this
    // id, so deleting it would strip their byline. getModel resolves against
    // the full MODELS list, not
    // SELECTABLE_MODELS, so hiding keeps every historical message readable while
    // making it impossible to pick a model that hangs the turn.
    //
    // To restore: drop `hidden`, run `node scripts/verify-models.mjs`, and only
    // keep the change if the probe prints a time for it.
    hidden: true,
  },
  {
    id: "codestral",
    label: "Codestral",
    description: "Code and programming specialist.",
    routes: [{ provider: "mistral", modelId: "codestral-latest" }],
    contextWindow: 256_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    emoji: "💻",
    kind: "Chat",
    featured: true,
  },
  {
    id: "mistral-medium",
    label: "Mistral Medium",
    description: "Balanced Mistral. Reads images.",
    routes: [{ provider: "mistral", modelId: "mistral-medium-latest" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    emoji: "🇫🇷",
    kind: "Chat",
  },
  {
    id: "mistral-small",
    label: "Mistral Small",
    description: "Fast, lightweight Mistral.",
    routes: [{ provider: "mistral", modelId: "mistral-small-latest" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    emoji: "🥖",
    kind: "Chat",
  },
  {
    id: "nemotron-super-49b",
    label: "Nemotron Super 49B",
    shortLabel: "Nemotron 49B",
    description: "NVIDIA mid-tier reasoning.",
    routes: [{ provider: "nvidia", modelId: "nvidia/llama-3.3-nemotron-super-49b-v1" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
    emoji: "🦁",
    kind: "Chat",
  },
  {
    id: "nemotron-super-120b",
    label: "Nemotron 3 Super 120B",
    shortLabel: "Nemotron 120B",
    description: "NVIDIA's 120B mixture-of-experts. Frontier-class, but only 12B active.",
    // Added in 3.10 to fill a real gap rather than to lengthen the list. The
    // catalogue jumped straight from nemotron-super-49b to the 550B ultra, and
    // ultra is the entry that answered http-503 on a verify-models run — a
    // featured single-route flagship with no failover available. A 120B-A12B sits
    // between the two and, with only 12B parameters active per token, should hold
    // capacity far better than a 550B-A55B pool.
    routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3-super-120b-a12b" }],
    // 128k is the nemotron-3 family default used by every other NVIDIA entry
    // here; it was NOT independently confirmed for this id. It feeds the token
    // budgeter only, and the family has never shipped a smaller window, so an
    // over-estimate would show up as an upstream context error rather than a
    // silently wrong answer.
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    // Hybrid-reasoning family, same as nemotron-ultra above. This flag has no
    // request-side effect — generateRoutedResponse sends no reasoning parameter —
    // it only governs whether a `reasoning_content` delta is surfaced, so a wrong
    // guess costs presentation, never a rejected payload.
    isReasoning: true,
    emoji: "🧠",
    kind: "Chat",
    // Featured on measured evidence, not on parameter count. First probe: 2090ms
    // to first byte, against 6257ms for the 550B ultra and 6484ms for the 49B
    // super on the same run and the same key. Three times quicker than both of
    // its neighbours in the lineup, which is the behaviour a 12B active slice
    // predicts and the reason this model earns a slot in the featured row.
    featured: true,
  },
  {
    id: "nemotron-lightning-30b",
    label: "Nemotron 3.5 Lightning 30B",
    shortLabel: "Nemotron Lightning",
    description: "Built for speed: 30B total, 3B active. Quick answers with tools.",
    // The speed tier between fast-small (hidden, 9B, internal use) and the
    // reasoning models, which take 1-8s to first byte. Nothing selectable was
    // optimised for latency before this.
    //
    // Featured on the second measurement, having been withheld on the first.
    //
    // Probe 1: 14711ms — the slowest route in the entire catalogue that run, for
    // the model named "lightning". Probe 2: **752ms**, the quickest NVIDIA route
    // in the catalogue that run (only Mistral's small models were faster, at
    // 511-556ms, and they are much smaller). Same id, same key, nothing changed
    // in between. So the first number was a scale-from-zero cold start on a model
    // nobody was using yet, and the entry was right to say so rather than to
    // average the two or to trust the name: at 14.7s the honest move would have
    // been to drop it, and at 752ms it earns the featured row and the word
    // "speed" in its description.
    //
    // This is the fourth time in three sessions that a second data point was the
    // difference between a fix and a mistaken deletion (see `nemotron-ultra`'s
    // 503 and the two cold starts cleared in 3.9). One probe of a route nobody
    // has warmed measures the scheduler, not the model.
    routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    // Deliberately not marked as reasoning: "lightning" is a latency-first
    // variant, and the family ships a separately-named `-reasoning` build for
    // that role. Costs presentation only if wrong (see the note above).
    emoji: "💨",
    kind: "Chat",
    featured: true,
  },
  {
    id: "flyer-free",
    label: "Flyer Free",
    description: "Keyless and always on. Works even without any API key.",
    // Pollinations needs no key or account, so this model answers even when the
    // keyed providers are unconfigured or rate limited. Its ids are Pollinations'
    // own model names, not shared with NVIDIA/Mistral, so nothing is duplicated.
    routes: [{ provider: "pollinations", modelId: "openai" }],
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsTools: false,
    emoji: "🎈",
    kind: "Chat",
  },

  // --- Vision --------------------------------------------------------------
  {
    id: "nemotron-vision",
    label: "Flyer Vision",
    description: "Reads images, screenshots and diagrams.",
    // WAS a deliberate exception to the same-model rule in ModelSpec.routes —
    // retired 2026-09-13 on the maintainer's explicit direction ("use real
    // model not alias"): the maintainer does not accept the capability-name
    // argument, so one picker entry now means one set of weights everywhere,
    // including here. The historical probe record below is kept because it is
    // the evidence for which leg survived (the 11B), not because the two-leg
    // shape it describes still exists. What it measured about the old 12B/8B
    // pair still governs nothing; what it established about orderings and
    // probe discipline still teaches. The old first leg
    // (nemotron-nano-12b-v2-vl) is dead anyway — 410 and delisted in the
    // 2026-08-26 EOL batch.
    //
    // The historical shape this entry had: two genuinely different weights
    // (a 12B v2 VL and an 8B v1 VL, later an 11B and an omni-30B), one
    // capability name, no model named in the description. The promise made to
    // the user was "this reads images", which both routes kept — that was the
    // argument for the exception, and the maintainer has overruled it.
    //
    // The historical probe record of the old 12B first leg:
    //   1722ms, timeout, ok, http-500, timeout, 3197ms,
    //   51473ms, 24981ms, 7718ms, http-500, http-500, 54826ms,
    //   timeout, timeout, http-500, http-500
    //
    // Seven of sixteen answered — and three of those seven took longer than the 22s
    // api/llm.js gives a non-final route, two of them longer than the whole 50s
    // CHAIN_DEADLINE_MS. So "answers" and "answers in time" are different numbers
    // here, and the useful one is the second: roughly four of sixteen. The last
    // four on that list are the 3.12 additions and every one of them is a
    // failure — two timeouts and two http-500s, the second 500 from a
    // verify-models.mjs run rather than a targeted probe. Four more
    // measurements did not change the shape of the distribution; they made the
    // good days look more like the outliers.
    //
    // The old ordering lesson, kept because the shape recurs: the decision to
    // keep the 12B first had been weighed against ~2.1s of retry cost, which is
    // right for the http-500 mode (BACKOFF_MS = 600+1500) and wrong by an order
    // of magnitude for the timeout mode — a non-final route is capped at
    // FIRST_BYTE_TIMEOUT_MS and not retried, so a dead first leg cost the full
    // 22 seconds. With the real distribution, 12B-first spent most requests
    // waiting (a quarter ate 22s of nothing plus the fallback's 5.8s, and a
    // further slice "succeeded" at 25-55s, worse than failing over would have
    // been). That is why the faster, more reliable model went first — a rule
    // that still applies to which single route this entry keeps.
    // RE-PINNED 2026-09-11. Both previous legs —
    //   nvidia/llama-3.1-nemotron-nano-vl-8b-v1 (primary, the "8B" above)
    //   nvidia/nemotron-nano-12b-v2-vl (the "12B" insurance)
    // — returned 410 AND left /v1/models (80 entries, neither present): the
    // 2026-08-26 EOL batch. 410 fails over, so both were removed rather than
    // kept as dead hops every image turn would pay for. Both replacements were
    // probed with REAL image payloads on the same day, not text-only 200s (the
    // nemotron-parse lesson: a text answer proves nothing about an image
    // contract):
    //
    //   meta/llama-3.2-11b-vision-instruct — 389-737ms, answered every probe,
    //     text and image, "Red" off a 1x1 PNG. Kept as the primary.
    //   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning — 2.2-3.6s with the
    //     same image, 4/4 spaced probes, but 503s ("Worker local total
    //     request limit reached 515/16") when hit back-to-back — a concurrency
    //     cap, not a verdict, and acceptable in the LAST-leg seat it holds:
    //     it only gets traffic when the 11B is down, which is rare.
    //
    // The insurance leg was briefly removed (2026-09-13, an over-broad reading
    // of "use real model not alias") and restored the same day on the
    // maintainer's correction — they did not ask for fallbacks to go, and this
    // entry is exactly the situation insurance exists for: one fast leg with
    // measured reliability, one slower leg with headroom.
    routes: [
      { provider: "nvidia", modelId: "meta/llama-3.2-11b-vision-instruct" },
      { provider: "nvidia", modelId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
    ],
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsTools: false,
    emoji: "👁️",
    kind: "Vision",
    featured: true,
  },

  // --- Utility -------------------------------------------------------------
  {
    id: "fast-small",
    label: "Flyer Mini",
    description: "Cheapest and quickest. Used internally for utility work.",
    // Two legs, restored 2026-09-13: the ministral-8b-latest leg was removed
    // the same day in an over-broad reading of "use real model not alias",
    // and the maintainer corrected that reading — they did not ask for
    // fallbacks to go. This entry is hidden, so the chain's reader is us:
    // title generation and the other utility calls keep working when either
    // provider is down, and an internal insurance leg is not an alias any
    // user reads.
    routes: [
      { provider: "nvidia", modelId: "nvidia/nvidia-nemotron-nano-9b-v2" },
      { provider: "mistral", modelId: "ministral-8b-latest" },
    ],
    contextWindow: 128_000,
    maxOutputTokens: 2048,
    supportsVision: false,
    supportsTools: true,
    emoji: "🪶",
    kind: "Chat",
    // Internal role (titles, short utility calls). Offering it as a chat option
    // would just be a worse version of every other entry.
    hidden: true,
  },

  // --- Image generation ----------------------------------------------------
  // These are not chat models: their routes point at Pollinations' image host,
  // and the image executor walks this chain rather than /api/llm.
  //
  // NVIDIA NIM's image models (nvidia/sana, stabilityai/sdxl-turbo) were
  // removed in 3.6: `npm run verify:models` probes the genai endpoint and they
  // 404 even with a valid key — the whole `/v1/genai/*` surface is gone, so a
  // live NVIDIA leg does not exist to walk. Pollinations is keyless and
  // always-on, so this chain is
  // what actually renders images.
  {
    id: "flux",
    label: "FLUX",
    description: "High-quality photorealistic images. Keyless.",
    routes: [{ provider: "pollinations", modelId: "flux" }],
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsVision: false,
    supportsTools: false,
    emoji: "🖼️",
    kind: "Image",
    featured: true,
  },
  {
    id: "turbo",
    label: "FLUX Turbo",
    description: "Fastest image generation. Keyless.",
    routes: [{ provider: "pollinations", modelId: "turbo" }],
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsVision: false,
    supportsTools: false,
    emoji: "⚡",
    kind: "Image",
  },
  {
    id: "stable-diffusion",
    label: "Stable Diffusion",
    description: "Classic versatile image model. Keyless.",
    routes: [{ provider: "pollinations", modelId: "stable-diffusion" }],
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsVision: false,
    supportsTools: false,
    emoji: "🌈",
    kind: "Image",
  },
];

// No legacy alias map any more (removed in 3.12 at the maintainer's direction).
// Old conversations whose modelId was renamed or retired simply do not resolve
// in getModel(); their byline falls back to a generic label and reopening one
// selects the default. The message content is untouched — only the stale label
// falls away. Keeping the alias layer was one-way compatibility debt: every
// rename had to be remembered here forever, and a value pointing at another
// key silently resolved to undefined (the exact bug the old test guarded).

const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/**
 * Look up a model by id.
 *
 * Returns undefined for an unknown id rather than guessing. Callers must
 * handle that by failing visibly: defaulting to some other model is how a
 * user ends up reading an answer from weights they did not pick.
 */
export function getModel(id: string): ModelSpec | undefined {
  return MODEL_BY_ID.get(id);
}

/** The model's own id back, or undefined if unknown. Kept because callers
 *  want a string (not a spec) for comparisons and persistence. */
export function canonicalModelId(id: string): string | undefined {
  return getModel(id)?.id;
}

/** Models the picker offers, in catalogue order. Excludes internal-only ones. */
export const SELECTABLE_MODELS: ModelSpec[] = MODELS.filter((m) => !m.hidden);

/** Short name for a chip or a message byline. */
export function modelDisplayName(id: string): string | undefined {
  const spec = getModel(id);
  return spec ? spec.shortLabel || spec.label : undefined;
}

export function isImageModel(id: string): boolean {
  return getModel(id)?.kind === "Image";
}

export function isVisionModel(id: string): boolean {
  return getModel(id)?.kind === "Vision";
}

/** True when this model accepts image input, whether or not it is vision-first. */
export function supportsVision(id: string): boolean {
  return getModel(id)?.supportsVision === true;
}

/** True when this model can be given tools. Gates the agent loop. */
export function supportsTools(id: string): boolean {
  return getModel(id)?.supportsTools === true;
}

/** The model used for internal utility work. Always the cheapest one. */
export const UTILITY_MODEL_ID = "fast-small";

// The model a new conversation starts on. Must be a live id in MODELS.
// glm-5.3-free since 2026-09-07 (user-directed; see its catalogue entry). The
// previous default, deepseek-v4-flash-0731, remains selectable and is the
// last leg of this model's chain.
export const DEFAULT_MODEL_ID = "glm-5.3-free";

/**
 * Walked in order by the image executor when a generation fails.
 *
 * NVIDIA NIM's image ids (sana, sdxl-turbo) were dropped in 3.6 — the
 * /v1/genai/* endpoint 404s for every model even with a valid key, so no live
 * NVIDIA image leg exists to walk. Every model here is keyless Pollinations.
 */
export const IMAGE_FALLBACK_CHAIN = ["flux", "turbo", "stable-diffusion"];

export const DEFAULT_IMAGE_MODEL_ID = "flux";

/** The vision model a non-vision chat model routes through for an attachment. */
export const DEFAULT_VISION_MODEL_ID = "nemotron-vision";


/**
 * Resolve a model to its route chain, dropping providers with no key configured.
 * `availableProviders` comes from the server, which is the only place that can
 * see which env keys are actually set.
 */
export function resolveRoutes(
  modelId: string,
  availableProviders: Set<ProviderId>,
): ModelRoute[] {
  const spec = getModel(modelId);
  if (!spec) return [];
  return spec.routes.filter((r) => availableProviders.has(r.provider));
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

/**
 * Whether a failed attempt should fall through to the next provider.
 *
 * 400/401/403 are deliberately excluded: a malformed request is ours, and a
 * rejected key is a configuration fault that failing over would hide, leaving us
 * silently running on backups while the primary stays broken. Those should surface
 * loudly.
 *
 * 404 used to be in that sentence and is not any more. It is not a configuration
 * fault on the provider this catalogue mostly runs on — NVIDIA returned 404 three
 * times running for an id that answered three times minutes later. api/_failover.js
 * holds the measurements and the argument.
 *
 * The set itself is NOT defined here any more. It used to be — a hand-copied
 * duplicate of the one in api/llm.js, which is the chain every production request
 * actually walks. The comment here said it "mirrored" the proxy, nothing checked
 * that, and so every test of this function was exercising a rule no request ever
 * reaches. A drift test pinned the two together as a stopgap; importing the single
 * definition removes the need for one.
 *
 * The import is from `api/`, not `src/`, because the constraint is one-directional:
 * api/llm.js is a plain-JS Vercel function with no build step and cannot import a
 * TypeScript module, while this file can import plain ESM. `_failover.js` is kept
 * dependency-free precisely so this import cannot pull server code (api/llm.js
 * itself reaches _meter.js → _auth.js: JWT verification and Redis) into the client
 * bundle. See that file's header.
 */
export function shouldFailover(status: number): boolean {
  return FAILOVER_STATUSES.has(status);
}

/** True when the status means "this provider is rate limited right now". */
export function isQuotaExhausted(status: number): boolean {
  return status === 429;
}
