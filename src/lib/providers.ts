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
  label: string;
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
}

// Open-weight frontier models. The premise of this project is that the gap
// between these and the closed frontier models is now small enough that a good
// product built on them is competitive — so the catalogue leans on the strongest
// open models rather than trying to match GPT/Claude/Gemini weights directly.
//
// Every NVIDIA and Mistral id below was confirmed present in the live provider
// catalogue by `npm run verify:models`. Each model has a single source — NVIDIA,
// Mistral, or Pollinations — never duplicated across providers, so the backend
// that answers always matches the model the user picked.
//
// Re-run `npm run verify:models` after changing anything here. Provider
// catalogues churn, and an unverified id fails at request time.
export const MODELS: ModelSpec[] = [
  {
    id: "deepseek-v4-pro",
    label: "Flyer Max",
    description: "Frontier open reasoning model. Best for hard problems.",
    routes: [{ provider: "nvidia", modelId: "deepseek-ai/deepseek-v4-pro" }],
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
  },
  {
    id: "deepseek-v4-flash",
    label: "Flyer Fast",
    description: "Frontier quality at speed. Good default for everyday use.",
    routes: [{ provider: "nvidia", modelId: "deepseek-ai/deepseek-v4-flash" }],
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
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
  },
  {
    id: "nemotron-ultra",
    label: "Nemotron Ultra",
    description: "NVIDIA's 550B flagship for agentic work.",
    routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    isReasoning: true,
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
  },
  {
    id: "mistral-large",
    label: "Mistral Large",
    description: "Mistral's flagship. Handles images too.",
    routes: [{ provider: "mistral", modelId: "mistral-large-latest" }],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
  },
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
  },
  {
    id: "fast-small",
    label: "Flyer Mini",
    description: "Cheapest and quickest. Used internally for classification.",
    routes: [
      { provider: "nvidia", modelId: "nvidia/nvidia-nemotron-nano-9b-v2" },
      { provider: "mistral", modelId: "ministral-8b-latest" },
    ],
    contextWindow: 128_000,
    maxOutputTokens: 2048,
    supportsVision: false,
    supportsTools: true,
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
  },
];


const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): ModelSpec | undefined {
  return MODEL_BY_ID.get(id);
}

/** The model used for internal classification work. Always the cheapest one. */
export const UTILITY_MODEL_ID = "fast-small";

export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

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
