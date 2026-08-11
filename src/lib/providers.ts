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

export type ProviderId = "nvidia" | "mistral" | "pollinations";

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

export const PROVIDER_ORDER: ProviderId[] = ["nvidia", "mistral", "pollinations"];


// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

export interface ModelRoute {
  provider: ProviderId;
  /** The exact model id this provider expects. */
  modelId: string;
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
   * Every route in a chain must be the SAME underlying model, just served by a
   * different provider. Falling back to a genuinely different model would mean
   * the user picks one thing and another answers — the failure this codebase
   * already refuses to allow in generateChatResponse (see ai.ts). A chain of
   * length 1 is normal and correct for a model only one provider hosts.
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
// Mistral, or Pollinations — never duplicated across providers, so the backend
// that answers always matches the model the user picked.
//
// Re-run `npm run verify:models` after changing anything here. Provider
// catalogues churn, and an unverified id fails at request time.
export const MODELS: ModelSpec[] = [
  // --- Chat / reasoning ----------------------------------------------------
  // The default. Mistral Large is the one flagship in this catalogue that is
  // both tool-capable and vision-capable on a single route, so it is the model
  // the product is named after and the one a new conversation starts on.
  {
    id: "mistral-large",
    label: "Flyer",
    shortLabel: "Flyer",
    description: "The default Flyer model. Strong all-rounder that reads images and uses tools.",
    routes: [{ provider: "mistral", modelId: "mistral-large-latest" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    emoji: "🪽",
    kind: "Chat",
    featured: true,
  },
  {
    id: "kimi-k2.6",
    label: "Kimi K2.6",
    description: "Moonshot's long-context reasoning model.",
    routes: [{ provider: "nvidia", modelId: "moonshotai/kimi-k2.6" }],
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
    featured: true,
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
    routes: [
      { provider: "nvidia", modelId: "nvidia/nemotron-nano-12b-v2-vl" },
      { provider: "nvidia", modelId: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" },
    ],
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsTools: false,
    emoji: "👁️",
    kind: "Vision",
    featured: true,
  },
  {
    id: "pixtral-12b",
    label: "Pixtral 12B",
    description: "Multimodal vision and chat.",
    routes: [{ provider: "mistral", modelId: "pixtral-12b-2409" }],
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsTools: false,
    emoji: "🖼️",
    kind: "Vision",
  },

  // --- Utility -------------------------------------------------------------
  {
    id: "fast-small",
    label: "Flyer Mini",
    description: "Cheapest and quickest. Used internally for utility work.",
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
  // These are not chat models: their routes point at image endpoints
  // (NVIDIA `/v1/genai/*`, Pollinations' image host), and the image executor
  // walks this chain rather than /api/llm. `npm run verify:models` checks these
  // ids against the genai catalogue separately from the chat ids.
  {
    id: "sana",
    label: "NVIDIA Sana",
    description: "Fast, crisp diffusion. The default image engine.",
    routes: [{ provider: "nvidia", modelId: "nvidia/sana" }],
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsVision: false,
    supportsTools: false,
    emoji: "✨",
    kind: "Image",
    featured: true,
  },
  {
    id: "sdxl-turbo",
    label: "SDXL Turbo",
    description: "Stability's fast SDXL. Second in the image chain.",
    routes: [{ provider: "nvidia", modelId: "stabilityai/sdxl-turbo" }],
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsVision: false,
    supportsTools: false,
    emoji: "🌀",
    kind: "Image",
  },
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

// Ids that older conversations persisted, pointing at their current equivalent.
//
// Message documents in Firestore store whatever id the picker used at the time.
// Renaming an id without this map would make every historical message resolve to
// nothing, so the UI would label it "AI" and a retry would route it as unknown.
// Entries are one-way and cheap to keep; add to this rather than mutating ids.
const LEGACY_MODEL_IDS: Record<string, string> = {
  "Flyer AI": "mistral-large",
  "mistral-large-latest": "mistral-large",
  "mistral-medium-latest": "mistral-medium",
  "mistral-small-latest": "mistral-small",
  "codestral-latest": "codestral",
  "devstral-latest": "codestral",
  "ministral-8b": "fast-small",
  "nemotron-3-ultra-550b": "nemotron-ultra",
  "llama-3.3-70b": "llama-70b",
  "nemotron-nano-9b": "fast-small",
  "vision-engine": "nemotron-vision",
  "vision-engine-2": "nemotron-vision",
  "vision-engine-3": "nemotron-vision",
  "pixtral-12b-2409": "pixtral-12b",
  "gptimage": "flux",

  // These three used to answer as a *different* model than their name claimed
  // (llama-4-maverick and qwen-3-next-80b both resolved to llama-3.1-70b,
  // minimax-m2.7 to llama-3.1-8b). The names are gone. Neither 3.1 model is in
  // the catalogue any more, so these point at the nearest live equivalent —
  // which means an old message's byline is approximate, not exact. That is the
  // unavoidable cost of having shipped the mislabelling; new messages are
  // labelled with the weights that actually produced them.
  "llama-4-maverick": "llama-70b",
  "qwen-3-next-80b": "llama-70b",
  "minimax-m2.7": "fast-small",
  "llama-8b": "fast-small",
  "step-3.7-flash": "nemotron-super-49b",

  // Gemini and DeepSeek were removed from the catalogue. Messages already in
  // Firestore still carry those ids, so they map to the nearest live model —
  // which means an old message's byline is approximate, not exact, exactly as
  // for the mislabelled ids above. Nothing re-routes to different weights at
  // request time: these only resolve a stored id to a label and a retry target.
  "gemini-flash": "mistral-large",
  "gemini-pro": "mistral-large",
  "gemini-flash-lite": "mistral-small",
  "gemini-2.5-flash": "mistral-large",
  "gemini-2.5-pro": "mistral-large",
  "gemini-2.5-flash-lite": "mistral-small",
  "gemini-1.5-flash": "mistral-large",
  "gemini-1.5-pro": "mistral-large",
  "deepseek-v4-flash": "mistral-large",
  "deepseek-v4-pro": "kimi-k2.6",
};




const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/**
 * Look up a model by id, resolving ids persisted by older versions.
 *
 * Returns undefined for a genuinely unknown id rather than guessing. Callers
 * must handle that by failing visibly: defaulting to some other model is how
 * a user ends up reading an answer from weights they did not pick.
 */
export function getModel(id: string): ModelSpec | undefined {
  const direct = MODEL_BY_ID.get(id);
  if (direct) return direct;
  const canonical = LEGACY_MODEL_IDS[id];
  return canonical ? MODEL_BY_ID.get(canonical) : undefined;
}

/** Canonical id for a possibly-legacy id, or undefined if unknown. */
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

export const DEFAULT_MODEL_ID = "mistral-large";

/** Walked in order by the image executor when a generation fails. */
export const IMAGE_FALLBACK_CHAIN = ["sana", "sdxl-turbo", "flux", "turbo", "stable-diffusion"];

export const DEFAULT_IMAGE_MODEL_ID = "sana";

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

// Statuses where the *next provider* is worth trying: the request was fine, this
// provider just cannot serve it right now (quota exhausted, pool saturated,
// upstream blip). NVIDIA's 529 is its "temporarily overloaded" signal.
const FAILOVER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Whether a failed attempt should fall through to the next provider.
 *
 * 401/403 (bad key) and 404 (unknown model) are deliberately excluded: those are
 * configuration faults that failing over would hide, leaving us silently running
 * on backups while the primary stays broken. They should surface loudly.
 */
export function shouldFailover(status: number): boolean {
  return FAILOVER_STATUSES.has(status);
}

/** True when the status means "this provider is rate limited right now". */
export function isQuotaExhausted(status: number): boolean {
  return status === 429;
}
