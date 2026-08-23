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
    id: "kimi-k3",
    label: "Kimi K3",
    description: "Moonshot's long-context reasoning model.",
    // Was moonshotai/kimi-k2.6 until 3.9. That id is still in NVIDIA's /v1/models
    // list but POST /v1/chat/completions returned 404 for it — the failure the
    // catalogue check alone cannot see. K3 is the current generation on the same
    // endpoint. Re-run scripts/verify-models.mjs after touching this: the probe
    // there is what separates "the id exists" from "the id answers".
    //
    // CAVEAT ADDED IN 3.11: "listed and not deployed" is a weaker conclusion than
    // it looked at the time. NVIDIA also 404s ids it is temporarily not serving —
    // nemotron-3-super-120b-a12b returned 404 three times running and then answered
    // three times running minutes later. So k2.6 may well have been alive and the
    // move to K3 made on a bad moment. No harm done, since K3 is the newer model
    // and answers in under a second, but the reasoning was luckier than it was
    // sound. `node scripts/probe-id.mjs moonshotai/kimi-k2.6 --times 3` settles it
    // if k2.6 is ever wanted back.
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
    // Kept in MODELS (rather than moved to LEGACY_MODEL_IDS) because getModel
    // resolves against the full list, so every message already in Firestore that
    // carries this id keeps its "GLM 5.2" byline. A legacy alias would also be
    // *unreachable* — MODEL_BY_ID is checked first — and the suite asserts against
    // exactly that shadowing.
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
    // Hidden rather than deleted, which is the whole reason the flag is worth
    // having: three LEGACY_MODEL_IDS entries resolve to `llama-70b`
    // (llama-3.3-70b, llama-4-maverick, qwen-3-next-80b), so deleting it would
    // strip the byline off every message those ids labelled and make a retry
    // route as unknown. getModel resolves against the full MODELS list, not
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
    // A DELIBERATE EXCEPTION to the same-model rule in ModelSpec.routes above,
    // documented here so it does not read as an oversight and get "fixed" by
    // deleting the second route. It is worth deleting on a first read — the second
    // leg is the flakier model and, because the first leg has never failed, it is
    // never actually reached. See the insurance argument below before removing it.
    //
    // These two ids are genuinely different weights (12B v2 VL and 8B v1 VL), not
    // one model on two providers. The rule exists so a user who picks a model
    // cannot be answered by different weights wearing its name; here there is no
    // such name to misattribute. "Flyer Vision" is a capability, like flyer-free,
    // and the description names no model — so the promise made to the user is
    // "this reads images", which both routes keep. Every other entry in this file
    // names its weights and must obey the rule strictly.
    //
    // The exception is load-bearing, because one of the two routes is unusable as a
    // primary. nemotron-nano-12b-v2-vl over sixteen probes in 3.9-3.12:
    //
    //   1722ms, timeout, ok, http-500, timeout, 3197ms,
    //   51473ms, 24981ms, 7718ms, http-500, http-500, 54826ms,
    //   timeout, timeout, http-500, http-500
    //
    // Seven of sixteen answered — and three of those seven took longer than the 22s
    // api/llm.js gives a non-final route, two of them longer than the whole 50s
    // CHAIN_DEADLINE_MS. So "answers" and "answers in time" are different numbers
    // here, and the useful one is the second: roughly four of sixteen.
    //
    // The last four on that list are the 3.12 additions and every one of them is a
    // failure — two timeouts and two http-500s, the second 500 from a
    // verify-models.mjs run rather than a targeted probe, so it is not one bad
    // moment observed twice. Four more measurements have not changed the shape of
    // the distribution; they have made the good days look more like the outliers.
    //
    // The 8B has answered every probe it has ever been given (5777ms most recently).
    //
    // ORDER WAS SWAPPED IN 3.11, and the earlier decision to keep the 12B first was
    // made against a wrong cost. That comment said "a bad run adds ~2.1s plus the
    // dead attempts, which is the number to weigh" — true for the http-500 mode
    // (api/llm.js retries a 500 twice, BACKOFF_MS = 600+1500), and wrong by an order
    // of magnitude for the timeout mode. callProvider does not retry a timeout at
    // all: it caps a non-final route at FIRST_BYTE_TIMEOUT_MS and returns, so a
    // timed-out first leg costs the full **22 seconds** before the second leg is
    // asked. The decision was weighed against 2.1s when half the observed failures
    // cost ten times that.
    //
    // With the real distribution, 12B-first spends most requests waiting: a quarter
    // of them eat 22s of nothing and then the 8B's 5.8s, and a further slice
    // "succeed" at 25-55s, which is worse than failing over would have been. The
    // expected dead wait exceeds the entire successful latency of the fallback.
    // 8B-first is ~5.8s flat with no tail.
    //
    // WHAT THIS TRADE ACTUALLY IS, stated honestly: measured reliability bought with
    // unmeasured quality. Nothing here has compared the two models' vision output;
    // the 12B is newer and larger and is *presumably* better, and on its good days
    // it is faster too (1722/3197ms). That is given up. For a *featured* capability
    // it is still the right trade — a 25s stare at a spinner reads as a broken app,
    // and both routes keep the promise the description makes — but it is a trade,
    // not an upgrade.
    //
    // The 12B is not dead code in second position, it is insurance, and weak
    // insurance: meta/llama-3.3-70b-instruct went from working to permanently
    // unresponsive inside this catalogue's lifetime, so a second leg is worth
    // having — but if the 8B ever dies, this one answers inside the budget about a
    // third of the time. Better than a hard failure, not much better.
    //
    // FLIP IT BACK only on evidence of a different distribution: five consecutive
    // clean probes *all under 22s*, which at the current in-budget rate of four in
    // sixteen is a fluke of about 1 in 1000 — and the streak counter is at zero, not
    // partway there, because the four most recent probes on record all failed.
    // `node scripts/probe-id.mjs nvidia/nemotron-nano-12b-v2-vl --times 5` is that
    // measurement, and it flags any run over 22s explicitly, because a route that
    // answers at 51s looks green in a probe and fails over in production.
    routes: [
      { provider: "nvidia", modelId: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" },
      { provider: "nvidia", modelId: "nvidia/nemotron-nano-12b-v2-vl" },
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
  // live NVIDIA leg does not exist to walk. Their persisted ids resolve through
  // LEGACY_MODEL_IDS. Pollinations is keyless and always-on, so this chain is
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

// Ids that older conversations persisted, pointing at their current equivalent.
//
// Message documents in Firestore store whatever id the picker used at the time.
// Renaming an id without this map would make every historical message resolve to
// nothing, so the UI would label it "AI" and a retry would route it as unknown.
// Entries are one-way and cheap to keep; add to this rather than mutating ids.
//
// Every *value* must be a live id in MODELS above — never another key in this
// map. getModel does exactly one alias hop, so a chained entry silently resolves
// to undefined. Exported (read-only) so src/test/providers.test.ts can enforce
// both halves of that rule; nothing outside the tests should need it.
export const LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
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
  // Mistral retired pixtral-12b-2409 from its catalogue (verified in 3.6), so
  // both spellings resolve to the live NVIDIA vision engine.
  "pixtral-12b-2409": "nemotron-vision",
  "pixtral-12b": "nemotron-vision",
  // NVIDIA NIM's image gen ids died with the /v1/genai/* surface. Persisted
  // conversations that selected them resolve to the keyless chain instead.
  "sana": "flux",
  "sdxl-turbo": "flux",
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
  // Repointed with the k2.6 -> k3 rename. Values in this map must be *live
  // catalogue ids*, never another key: getModel does exactly one alias hop
  // (LEGACY_MODEL_IDS[id] then MODEL_BY_ID.get), so a value that is itself a
  // legacy id resolves to undefined and the message loses its byline.
  "deepseek-v4-pro": "kimi-k3",
  "kimi-k2.6": "kimi-k3",
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
