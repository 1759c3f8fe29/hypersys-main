// ---------------------------------------------------------------------------
// Execution Modes — Real Behaviour, Not Labels
// ---------------------------------------------------------------------------
//
// The spec names four modes: Auto / Quick / Research / Build. They must change
// actual behaviour, not just paint a chip. Each mode is a bundle of concrete
// capability gates that the send path already respects:
//
//   Quick     → tools OFF, deepThink OFF, webSearch OFF, prefer speed
//   Research  → tools ON, deepThink ON, webSearch ON, thorough
//   Build     → tools ON, deepThink OFF, webSearch OFF, artifact-heavy
//   Auto      → system decides based on model capabilities and context
//
// The capability registry (capabilities.ts) is the single source of truth for
// what a model CAN do. Execution modes decide what we LET it do.
//
// ---------------------------------------------------------------------------

export type ExecutionMode = "auto" | "quick" | "research" | "build";

export interface ExecutionModeConfig {
  /** Human label for the UI. */
  label: string;
  /** Short label for chips. */
  shortLabel: string;
  /** Emoji for visual distinction. */
  emoji: string;
  /** Description of what this mode does. */
  description: string;

  // Capability gates — these override model capabilities

  /** Allow the agent loop (tools). */
  allowTools: boolean | "auto";
  /** Force deep reasoning prompt. */
  forceDeepThink: boolean | "auto";
  /** Force web search on every turn. */
  forceWebSearch: boolean | "auto";
  /** Prefer speed — affects model selection and timeouts. */
  preferSpeed: boolean;
  /** Allow artifact creation (code, files, etc.). */
  allowArtifacts: boolean;
  /** Max tool calls per turn (0 = unlimited, auto = model default). */
  maxToolCalls: number | "auto";
  /** Whether to use the utility model for classification. */
  useUtilityModel: boolean;
}

export const EXECUTION_MODES: Record<ExecutionMode, ExecutionModeConfig> = {
  auto: {
    label: "Auto",
    shortLabel: "Auto",
    emoji: "⚡",
    description: "System chooses based on model and context",
    allowTools: "auto",
    forceDeepThink: "auto",
    forceWebSearch: "auto",
    preferSpeed: false,
    allowArtifacts: true,
    maxToolCalls: "auto",
    useUtilityModel: true,
  },
  quick: {
    label: "Quick",
    shortLabel: "Quick",
    emoji: "💨",
    description: "Fast answers, no tools, no search",
    allowTools: false,
    forceDeepThink: false,
    forceWebSearch: false,
    preferSpeed: true,
    allowArtifacts: false,
    maxToolCalls: 0,
    useUtilityModel: false,
  },
  research: {
    label: "Research",
    shortLabel: "Research",
    emoji: "🔬",
    description: "Deep reasoning, web search, thorough analysis",
    allowTools: true,
    forceDeepThink: true,
    forceWebSearch: true,
    preferSpeed: false,
    allowArtifacts: true,
    maxToolCalls: "auto",
    useUtilityModel: true,
  },
  build: {
    label: "Build",
    shortLabel: "Build",
    emoji: "🛠️",
    description: "Code, files, artifacts — tool-heavy execution",
    allowTools: true,
    forceDeepThink: false,
    forceWebSearch: false,
    preferSpeed: false,
    allowArtifacts: true,
    maxToolCalls: "auto",
    useUtilityModel: false,
  },
};

/**
 * Resolve an "auto" gate to a concrete boolean based on model capabilities
 * and context. This is the ONLY place "auto" is interpreted.
 */
export function resolveAutoGate(
  mode: ExecutionMode,
  gate: "allowTools" | "forceDeepThink" | "forceWebSearch",
  context: {
    /** The selected model's capabilities. */
    modelSupportsTools: boolean;
    modelSupportsVision: boolean;
    /** The effective model's capabilities (after vision fallback). */
    effectiveSupportsTools: boolean;
    effectiveSupportsVision: boolean;
    hasImages: boolean;
    isImageGen: boolean;
    isArenaMode: boolean;
    agentToolsEnabled: boolean;
  }
): boolean {
  const config = EXECUTION_MODES[mode];
  const value = config[gate];

  if (value !== "auto") return value;

  // Auto resolution logic
  switch (gate) {
    case "allowTools":
      // Tools on if the EFFECTIVE model supports them, not arena, not image gen, global enabled
      return (
        context.effectiveSupportsTools &&
        !context.isArenaMode &&
        !context.isImageGen &&
        context.agentToolsEnabled
      );

    case "forceDeepThink":
      // Deep think for reasoning models when not in arena, no images, not image gen
      // Uses effective model's tool support (deep think needs tools)
      return (
        context.effectiveSupportsTools &&
        !context.hasImages &&
        !context.isImageGen &&
        !context.isArenaMode
      );

    case "forceWebSearch":
      // Web search for non-vision, non-image-gen, non-arena turns
      // Uses effective model's tool support (web search needs tools)
      return (
        !context.hasImages &&
        !context.isImageGen &&
        !context.isArenaMode &&
        context.effectiveSupportsTools
      );

    default:
      return false;
  }
}

/**
 * Compute the effective execution context for a turn, combining:
 * - The selected execution mode
 * - Model capabilities (from the registry)
 * - Turn context (images, arena, etc.)
 */
export interface ResolvedExecutionContext {
  mode: ExecutionMode;
  allowTools: boolean;
  forceDeepThink: boolean;
  forceWebSearch: boolean;
  preferSpeed: boolean;
  allowArtifacts: boolean;
  maxToolCalls: number;
  useUtilityModel: boolean;
  effectiveModelId: string;
  modelNameForPrompt: string;
}

export function resolveExecutionContext(
  mode: ExecutionMode,
  selectedModelId: string,
  context: {
    hasImages: boolean;
    isArenaMode: boolean;
    isImageGen: boolean;
    agentToolsEnabled: boolean;
  },
  // Registry functions — passed in to avoid circular deps
  registry: {
    getCapabilities: (id: string) => {
      supportsTools: boolean;
      supportsVision: boolean;
      effectiveModel: (hasImages: boolean) => string;
      promptModelName: (hasImages: boolean) => string;
    } | undefined;
  }
): ResolvedExecutionContext {
  const config = EXECUTION_MODES[mode];
  const caps = registry.getCapabilities(selectedModelId);
  const modelSupportsTools = caps?.supportsTools ?? false;
  const modelSupportsVision = caps?.supportsVision ?? false;

  const effectiveModelId = caps?.effectiveModel(context.hasImages) ?? selectedModelId;
  const modelNameForPrompt = caps?.promptModelName(context.hasImages) ?? selectedModelId;

  // Get effective model capabilities (after vision fallback)
  const effectiveCaps = registry.getCapabilities(effectiveModelId);
  const effectiveSupportsTools = effectiveCaps?.supportsTools ?? false;
  const effectiveSupportsVision = effectiveCaps?.supportsVision ?? false;

  return {
    mode,
    allowTools: resolveAutoGate(mode, "allowTools", {
      modelSupportsTools,
      modelSupportsVision,
      effectiveSupportsTools,
      effectiveSupportsVision,
      hasImages: context.hasImages,
      isImageGen: context.isImageGen,
      isArenaMode: context.isArenaMode,
      agentToolsEnabled: context.agentToolsEnabled,
    }),
    forceDeepThink: resolveAutoGate(mode, "forceDeepThink", {
      modelSupportsTools,
      modelSupportsVision,
      effectiveSupportsTools,
      effectiveSupportsVision,
      hasImages: context.hasImages,
      isImageGen: context.isImageGen,
      isArenaMode: context.isArenaMode,
      agentToolsEnabled: context.agentToolsEnabled,
    }),
    forceWebSearch: resolveAutoGate(mode, "forceWebSearch", {
      modelSupportsTools,
      modelSupportsVision,
      effectiveSupportsTools,
      effectiveSupportsVision,
      hasImages: context.hasImages,
      isImageGen: context.isImageGen,
      isArenaMode: context.isArenaMode,
      agentToolsEnabled: context.agentToolsEnabled,
    }),
    preferSpeed: config.preferSpeed,
    allowArtifacts: config.allowArtifacts,
    maxToolCalls: config.maxToolCalls === "auto" ? 10 : config.maxToolCalls,
    useUtilityModel: config.useUtilityModel,
    effectiveModelId,
    modelNameForPrompt,
  };
}

/**
 * Get the mode order for UI display.
 */
export function getModeOrder(): ExecutionMode[] {
  return ["auto", "quick", "research", "build"];
}

/**
 * Check if a mode requires a model with tools.
 */
export function modeRequiresTools(mode: ExecutionMode): boolean {
  const config = EXECUTION_MODES[mode];
  return config.allowTools === true || config.allowTools === "auto";
}

/**
 * Get the default mode (persisted or auto).
 */
export function getDefaultMode(): ExecutionMode {
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem("flyer-execution-mode");
      if (saved && (["auto", "quick", "research", "build"] as string[]).includes(saved)) {
        return saved as ExecutionMode;
      }
    } catch {
      // Private browsing, ignore
    }
  }
  return "auto";
}

/**
 * Persist the selected mode.
 */
export function setDefaultMode(mode: ExecutionMode): void {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("flyer-execution-mode", mode);
    } catch {
      // Private browsing, ignore
    }
  }
}