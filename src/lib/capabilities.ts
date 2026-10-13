// ---------------------------------------------------------------------------
// Capability Registry — Single Source of Truth
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
//
// Before this module, capability answers lived in four places:
//
//   1. PROVIDER table (providers.ts) — per-provider supportsTools, supportsVision
//   2. MODEL table (providers.ts) — per-model supportsTools, supportsVision
//   3. Helpers in providers.ts — supportsTools(id), supportsVision(id), isVisionModel, isImageModel
//   4. Wrappers in ai.ts — isVisionCapableModel, isVisionModel, isImageModel
//   5. Chat.tsx — useAgent calculation, effectiveModelId logic
//   6. Model picker — filters by hidden/featured
//
// This meant a model could be listed in the picker but not support tools
// (or vice versa), a vision fallback could route to a model that doesn't
// actually accept images, and the tool gate could disagree with the prompt's
// toolsAvailable flag. Every mismatch is a user-visible bug:
//
//   - Tools advertised but stripped → agent loop waits for calls that never come
//   - Image attached but vision model can't see it → "I can't see that"
//   - Picker shows a model the router doesn't know → silent fallback
//
// This module consolidates ALL capability decisions into one place. If a
// capability is displayed in the UI, it connects to a real implementation.
// If it's not available, it's clearly marked.
//
// The registry is built from the canonical MODELS catalogue in providers.ts
// and answers three classes of questions:
//
//   QUERY (UI)        → can the user pick this? what can it do?
//   ROUTE (router)    → which model actually receives this request?
//   EXECUTE (agent)   → are tools on? is vision on? what's the prompt flag?
//
// All three read the SAME derived data. No more drift.
//
//
// INVARIANTS (tested in capabilities.test.ts)
//
//   1. SELECTABLE_MODELS ⊆ registry.keys() — every pickable model has an entry
//   2. registry[m].supportsTools === supportsTools(m.id) — no drift from old helpers
//   3. registry[m].supportsVision === supportsVision(m.id) — same
//   4. effectiveModel(m, hasImages) returns a model that supportsVision
//   5. useAgent(m, hasImages, isArena, isImageGen) matches the old Chat.tsx logic
//   6. promptToolsAvailable(m, hasImages, isArena, isImageGen) === useAgent(...)
//   7. hidden models never appear in the picker
//   8. Image models never have tools, never have vision
//   9. Vision models always have supportsVision: true
//
// ---------------------------------------------------------------------------

import {
  MODELS,
  SELECTABLE_MODELS,
  DEFAULT_MODEL_ID,
  DEFAULT_VISION_MODEL_ID,
  UTILITY_MODEL_ID,
  type ModelSpec,
  type ModelRoute,
  type ProviderId,
  getModel as catalogueGetModel,
} from "./providers";

/** The canonical capability record for a single model. */
export interface ModelCapabilities {
  /** Stable internal id. */
  id: string;
  /** Human label. */
  label: string;
  /** Short label for chips. */
  shortLabel: string;
  /** What kind of model this is. */
  kind: "Chat" | "Vision" | "Image";
  /** Whether this model appears in the picker. */
  featured: boolean;
  /** Internal-only (titles, utility). Not in picker. */
  hidden: boolean;

  // ---- Capabilities ----

  /** Can this model execute tools? */
  supportsTools: boolean;
  /** Can this model accept image inputs? */
  supportsVision: boolean;
  /** Is this a reasoning model (streams reasoning_content)? */
  isReasoning: boolean;
  /** Total context window. */
  contextWindow: number;
  /** Max output tokens. */
  maxOutputTokens: number;

  // ---- Routing ----

  /** The declared route chain, in order. */
  routes: ModelRoute[];
  /** The provider that serves the PRIMARY route (routes[0].provider). */
  primaryProvider: ProviderId;

  // ---- Derived (computed once at build time) ----

  /** True when this model can be the effective target for a vision turn. */
  isVisionCapable: boolean;
  /** True when this model is an Image generation model. */
  isImageModel: boolean;
  /** True when this model is a Vision-first model. */
  isVisionModel: boolean;

  // ---- Execution (context-dependent, computed per-turn) ----

  /**
   * Whether the agent loop (tools) is enabled for this model in the given
   * context. This is the SINGLE decision point — the prompt, the agent loop,
   * and the attribution all read this.
   */
  useAgent: (opts: ExecutionContext) => boolean;

  /**
   * The model id that will actually receive the request, given images.
   * This is the model whose capabilities (tools/vision) apply to the turn.
   */
  effectiveModel: (hasImages: boolean) => string;

  /**
   * The value to pass to the system prompt's `toolsAvailable` flag.
   * MUST equal `useAgent` for the same context — the two disagreeing is
   * exactly what produces fabricated tool output or a hedging model.
   */
  promptToolsAvailable: (opts: ExecutionContext) => boolean;

  /**
   * The value to pass to the system prompt for the model's display name.
   * Uses the effective model's label when a vision fallback kicks in.
   */
  promptModelName: (hasImages: boolean) => string;
}

/** Context needed to make execution-time capability decisions. */
export interface ExecutionContext {
  /** Whether the user has attached images this turn. */
  hasImages: boolean;
  /** Whether the conversation is in Arena mode (tools always off). */
  isArenaMode: boolean;
  /** Whether the selected model is an Image generation model. */
  isImageGen: boolean;
  /** Global kill switch for tool calling (AGENT_TOOLS_ENABLED). */
  agentToolsEnabled: boolean;
}

/** The registry: model id → capabilities. Built once at import. */
const CAPABILITY_REGISTRY = new Map<string, ModelCapabilities>();

/** Build a ModelCapabilities from a ModelSpec. */
function buildCapabilities(spec: ModelSpec): ModelCapabilities {
  const primaryRoute = spec.routes[0];
  const primaryProvider = primaryRoute?.provider ?? "nvidia";

  // Derived flags
  const isVisionCapable = spec.supportsVision === true;
  const isImageModel = spec.kind === "Image";
  const isVisionModel = spec.kind === "Vision";

  // Execution-time decisions — pure functions of context
  const computeUseAgent = (ctx: ExecutionContext): boolean => {
    // Image models never use the agent loop
    if (ctx.isImageGen) return false;
    // Arena mode never uses the agent loop
    if (ctx.isArenaMode) return false;
    // Global kill switch
    if (!ctx.agentToolsEnabled) return false;
    // The effective model must support tools
    const effId = ctx.hasImages && isVisionCapable ? spec.id : (ctx.hasImages ? DEFAULT_VISION_MODEL_ID : spec.id);
    const effSpec = catalogueGetModel(effId);
    if (!effSpec) return false;
    return effSpec.supportsTools === true;
  };

  const effectiveModel = (hasImages: boolean): string => {
    // Image models route to themselves
    if (isImageModel) return spec.id;
    // Vision-capable models handle images themselves
    if (hasImages && isVisionCapable) return spec.id;
    // Non-vision models fall back to the vision engine
    if (hasImages) return DEFAULT_VISION_MODEL_ID;
    return spec.id;
  };

  const promptToolsAvailable = (ctx: ExecutionContext): boolean => {
    // MUST match computeUseAgent exactly
    return computeUseAgent(ctx);
  };

  const promptModelName = (hasImages: boolean): string => {
    const effId = effectiveModel(hasImages);
    const effSpec = catalogueGetModel(effId);
    return effSpec?.label ?? spec.label;
  };

  return {
    id: spec.id,
    label: spec.label,
    shortLabel: spec.shortLabel ?? spec.label,
    kind: spec.kind,
    featured: spec.featured ?? false,
    hidden: spec.hidden ?? false,
    supportsTools: spec.supportsTools === true,
    supportsVision: spec.supportsVision === true,
    isReasoning: spec.isReasoning === true,
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
    routes: spec.routes,
    primaryProvider,
    isVisionCapable,
    isImageModel,
    isVisionModel,
    useAgent: computeUseAgent,
    effectiveModel,
    promptToolsAvailable,
    promptModelName,
  };
}

// Build the registry from the canonical MODELS array
for (const spec of MODELS) {
  CAPABILITY_REGISTRY.set(spec.id, buildCapabilities(spec));
}

/** Get capabilities for a model id. Returns undefined for unknown ids. */
export function getCapabilities(id: string): ModelCapabilities | undefined {
  return CAPABILITY_REGISTRY.get(id);
}

/** Get capabilities, throwing if the model is unknown. */
export function requireCapabilities(id: string): ModelCapabilities {
  const caps = CAPABILITY_REGISTRY.get(id);
  if (!caps) {
    throw new Error(`Unknown model id: ${id}`);
  }
  return caps;
}

/** All models that can be picked in the UI (not hidden). */
export function getSelectableCapabilities(): ModelCapabilities[] {
  return SELECTABLE_MODELS.map((m) => CAPABILITY_REGISTRY.get(m.id)!).filter(Boolean);
}

/** All models that are featured (shown by default in the picker). */
export function getFeaturedCapabilities(): ModelCapabilities[] {
  return getSelectableCapabilities().filter((c) => c.featured);
}

/** Models grouped by kind for the picker. */
export function getGroupedCapabilities(): Map<"Chat" | "Vision" | "Image", ModelCapabilities[]> {
  const grouped = new Map<"Chat" | "Vision" | "Image", ModelCapabilities[]>([
    ["Chat", []],
    ["Vision", []],
    ["Image", []],
  ]);
  for (const caps of getSelectableCapabilities()) {
    grouped.get(caps.kind)?.push(caps);
  }
  return grouped;
}

/** The default model's capabilities. */
export function getDefaultCapabilities(): ModelCapabilities {
  return requireCapabilities(DEFAULT_MODEL_ID);
}

/** The vision engine model's capabilities. */
export function getVisionEngineCapabilities(): ModelCapabilities {
  return requireCapabilities(DEFAULT_VISION_MODEL_ID);
}

/** The utility model's capabilities. */
export function getUtilityCapabilities(): ModelCapabilities {
  return requireCapabilities(UTILITY_MODEL_ID);
}

/**
 * Resolve the route chain for a model, filtered by available providers.
 * This is the single routing function — api/llm.js and the client both
 * need the same answer, so it lives here.
 */
export function resolveRouteChain(modelId: string, availableProviders: Set<ProviderId>): ModelRoute[] {
  const caps = getCapabilities(modelId);
  if (!caps) return [];
  return caps.routes.filter((r) => availableProviders.has(r.provider));
}

/**
 * Check if a model id is valid (exists in the catalogue).
 * Use this instead of getModel(id) !== undefined when you only need a boolean.
 */
export function isKnownModel(id: string): boolean {
  return CAPABILITY_REGISTRY.has(id);
}

/**
 * Check if a model supports tools. Single source of truth.
 * Replaces supportsTools() from providers.ts and ai.ts.
 */
export function modelSupportsTools(id: string): boolean {
  return getCapabilities(id)?.supportsTools === true;
}

/**
 * Check if a model supports vision (image inputs). Single source of truth.
 * Replaces supportsVision() from providers.ts and ai.ts.
 */
export function modelSupportsVision(id: string): boolean {
  return getCapabilities(id)?.supportsVision === true;
}

/**
 * Check if a model is a vision-first model (kind === "Vision").
 * Replaces isVisionModel() from providers.ts and ai.ts.
 */
export function modelIsVisionModel(id: string): boolean {
  return getCapabilities(id)?.isVisionModel === true;
}

/**
 * Check if a model is an image generation model (kind === "Image").
 * Replaces isImageModel() from providers.ts and ai.ts.
 */
export function modelIsImageModel(id: string): boolean {
  return getCapabilities(id)?.isImageModel === true;
}

/**
 * Check if a model can handle vision turns (either vision-first or vision-capable).
 * Replaces isVisionCapableModel() from ai.ts.
 */
export function modelIsVisionCapable(id: string): boolean {
  return getCapabilities(id)?.isVisionCapable === true;
}

/**
 * Compute the effective model id for a turn, given images.
 * This is the model that will actually receive the request.
 */
export function getEffectiveModelId(selectedModelId: string, hasImages: boolean): string {
  const caps = getCapabilities(selectedModelId);
  if (!caps) return DEFAULT_MODEL_ID;
  return caps.effectiveModel(hasImages);
}

/**
 * Compute whether the agent loop should run for this turn.
 * This is the SINGLE decision point — Chat.tsx, the prompt builder,
 * and the agent loop all use this.
 */
export function computeUseAgent(
  selectedModelId: string,
  ctx: ExecutionContext
): boolean {
  const caps = getCapabilities(selectedModelId);
  if (!caps) return false;
  return caps.useAgent(ctx);
}

/**
 * Compute the toolsAvailable flag for the system prompt.
 * MUST match shouldUseAgent for the same context.
 */
export function getPromptToolsAvailable(
  selectedModelId: string,
  ctx: ExecutionContext
): boolean {
  const caps = getCapabilities(selectedModelId);
  if (!caps) return false;
  return caps.promptToolsAvailable(ctx);
}

/**
 * Get the model name to pass to the system prompt.
 * Uses the effective model's label when a vision fallback kicks in.
 */
export function getPromptModelName(selectedModelId: string, hasImages: boolean): string {
  const caps = getCapabilities(selectedModelId);
  if (!caps) return "Flyer";
  return caps.promptModelName(hasImages);
}

/**
 * Get the effective model's capabilities for a turn.
 * Use this when you need to know what the ACTUAL serving model can do.
 */
export function getEffectiveCapabilities(selectedModelId: string, hasImages: boolean): ModelCapabilities {
  const effId = getEffectiveModelId(selectedModelId, hasImages);
  return requireCapabilities(effId);
}