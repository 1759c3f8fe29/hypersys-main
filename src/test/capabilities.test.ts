// ---------------------------------------------------------------------------
// Capability Registry — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests the invariants that make the registry a single source of truth:
//   1. SELECTABLE_MODELS ⊆ registry.keys()
//   2. registry[m].supportsTools === supportsTools(m.id) — no drift from old helpers
//   3. registry[m].supportsVision === supportsVision(m.id) — same
//   4. effectiveModel(m, hasImages) returns a model that supportsVision
//   5. useAgent(m, hasImages, isArena, isImageGen) matches the old Chat.tsx logic
//   6. promptToolsAvailable(m, hasImages, isArena, isImageGen) === useAgent(...)
//   7. hidden models never appear in the picker
//   8. Image models never have tools, never have vision
//   9. Vision models always have supportsVision: true
//
// Also tests the execution context functions against known scenarios.

import { describe, it, expect } from "vitest";
import {
  getCapabilities,
  requireCapabilities,
  getSelectableCapabilities,
  getFeaturedCapabilities,
  getGroupedCapabilities,
  getDefaultCapabilities,
  getVisionEngineCapabilities,
  getUtilityCapabilities,
  resolveRouteChain,
  isKnownModel,
  modelSupportsTools,
  modelSupportsVision,
  modelIsVisionModel,
  modelIsImageModel,
  modelIsVisionCapable,
  getEffectiveModelId,
  computeUseAgent,
  getPromptToolsAvailable,
  getPromptModelName,
  getEffectiveCapabilities,
  type ModelCapabilities,
  type ExecutionContext,
} from "@/lib/capabilities";
import {
  MODELS,
  SELECTABLE_MODELS,
  DEFAULT_MODEL_ID,
  DEFAULT_VISION_MODEL_ID,
  UTILITY_MODEL_ID,
  supportsTools as legacySupportsTools,
  supportsVision as legacySupportsVision,
  isVisionModel as legacyIsVisionModel,
  isImageModel as legacyIsImageModel,
} from "@/lib/providers";
import { AGENT_TOOLS_ENABLED } from "@/lib/agent";

describe("Capability Registry — Structure", () => {
  it("has an entry for every model in MODELS", () => {
    for (const spec of MODELS) {
      const caps = getCapabilities(spec.id);
      expect(caps).toBeDefined();
      expect(caps?.id).toBe(spec.id);
    }
  });

  it("SELECTABLE_MODELS is a subset of registry keys", () => {
    for (const spec of SELECTABLE_MODELS) {
      const caps = getCapabilities(spec.id);
      expect(caps).toBeDefined();
      expect(caps?.hidden).toBe(false);
    }
  });

  it("hidden models are not in SELECTABLE_MODELS", () => {
    for (const caps of getSelectableCapabilities()) {
      expect(caps.hidden).toBe(false);
    }
  });

  it("featured models are a subset of selectable models", () => {
    const featured = getFeaturedCapabilities();
    const selectable = getSelectableCapabilities();
    for (const caps of featured) {
      expect(selectable.some((s) => s.id === caps.id)).toBe(true);
    }
  });

  it("grouped capabilities cover all selectable models exactly once", () => {
    const grouped = getGroupedCapabilities();
    const allGrouped: ModelCapabilities[] = [];
    for (const [, models] of grouped) {
      allGrouped.push(...models);
    }
    const selectable = getSelectableCapabilities();
    expect(allGrouped.length).toBe(selectable.length);
    for (const caps of selectable) {
      expect(allGrouped.some((g) => g.id === caps.id)).toBe(true);
    }
  });
});

describe("Capability Registry — Drift from legacy helpers", () => {
  it("supportsTools matches legacy supportsTools for every model", () => {
    for (const spec of MODELS) {
      const caps = getCapabilities(spec.id)!;
      const legacy = legacySupportsTools(spec.id);
      expect(caps.supportsTools).toBe(legacy);
    }
  });

  it("supportsVision matches legacy supportsVision for every model", () => {
    for (const spec of MODELS) {
      const caps = getCapabilities(spec.id)!;
      const legacy = legacySupportsVision(spec.id);
      expect(caps.supportsVision).toBe(legacy);
    }
  });

  it("isVisionModel matches legacy isVisionModel for every model", () => {
    for (const spec of MODELS) {
      const caps = getCapabilities(spec.id)!;
      const legacy = legacyIsVisionModel(spec.id);
      expect(caps.isVisionModel).toBe(legacy);
    }
  });

  it("isImageModel matches legacy isImageModel for every model", () => {
    for (const spec of MODELS) {
      const caps = getCapabilities(spec.id)!;
      const legacy = legacyIsImageModel(spec.id);
      expect(caps.isImageModel).toBe(legacy);
    }
  });
});

describe("Capability Registry — Kind invariants", () => {
  it("Image models never have tools", () => {
    for (const spec of MODELS) {
      if (spec.kind === "Image") {
        const caps = getCapabilities(spec.id)!;
        expect(caps.supportsTools).toBe(false);
        expect(caps.supportsVision).toBe(false);
      }
    }
  });

  it("Vision models always have supportsVision: true", () => {
    for (const spec of MODELS) {
      if (spec.kind === "Vision") {
        const caps = getCapabilities(spec.id)!;
        expect(caps.supportsVision).toBe(true);
        expect(caps.isVisionCapable).toBe(true);
      }
    }
  });

  it("Chat models with supportsVision have isVisionCapable: true", () => {
    for (const spec of MODELS) {
      if (spec.kind === "Chat" && spec.supportsVision) {
        const caps = getCapabilities(spec.id)!;
        expect(caps.isVisionCapable).toBe(true);
      }
    }
  });

  it("Chat models without supportsVision have isVisionCapable: false", () => {
    for (const spec of MODELS) {
      if (spec.kind === "Chat" && !spec.supportsVision) {
        const caps = getCapabilities(spec.id)!;
        expect(caps.isVisionCapable).toBe(false);
      }
    }
  });
});

describe("Capability Registry — Effective model resolution", () => {
  it("Image models always route to themselves", () => {
    for (const spec of MODELS) {
      if (spec.kind === "Image") {
        const caps = getCapabilities(spec.id)!;
        expect(caps.effectiveModel(true)).toBe(spec.id);
        expect(caps.effectiveModel(false)).toBe(spec.id);
      }
    }
  });

  it("Vision-capable models handle images themselves", () => {
    for (const spec of MODELS) {
      if (spec.supportsVision && spec.kind !== "Image") {
        const caps = getCapabilities(spec.id)!;
        expect(caps.effectiveModel(true)).toBe(spec.id);
      }
    }
  });

  it("Non-vision models fall back to vision engine when images attached", () => {
    for (const spec of MODELS) {
      if (!spec.supportsVision && spec.kind !== "Image") {
        const caps = getCapabilities(spec.id)!;
        expect(caps.effectiveModel(true)).toBe(DEFAULT_VISION_MODEL_ID);
      }
    }
  });

  it("Non-vision models use themselves when no images", () => {
    for (const spec of MODELS) {
      if (!spec.supportsVision && spec.kind !== "Image") {
        const caps = getCapabilities(spec.id)!;
        expect(caps.effectiveModel(false)).toBe(spec.id);
      }
    }
  });

  it("effective model for vision fallback always supports vision", () => {
    for (const spec of MODELS) {
      if (spec.kind !== "Image") {
        const caps = getCapabilities(spec.id)!;
        const effId = caps.effectiveModel(true);
        const effCaps = getCapabilities(effId)!;
        expect(effCaps.supportsVision).toBe(true);
      }
    }
  });

  it("getEffectiveModelId matches the instance method", () => {
    for (const spec of SELECTABLE_MODELS) {
      const caps = getCapabilities(spec.id)!;
      expect(getEffectiveModelId(spec.id, true)).toBe(caps.effectiveModel(true));
      expect(getEffectiveModelId(spec.id, false)).toBe(caps.effectiveModel(false));
    }
  });
});

describe("Capability Registry — Agent loop decisions (useAgent)", () => {
  const baseCtx: ExecutionContext = {
    hasImages: false,
    isArenaMode: false,
    isImageGen: false,
    agentToolsEnabled: AGENT_TOOLS_ENABLED,
  };

  it("Image models never use agent", () => {
    for (const spec of MODELS) {
      if (spec.kind === "Image") {
        const caps = getCapabilities(spec.id)!;
        const ctx: ExecutionContext = { ...baseCtx, isImageGen: true };
        expect(caps.useAgent(ctx)).toBe(false);
        expect(computeUseAgent(spec.id, ctx)).toBe(false);
      }
    }
  });

  it("Arena mode never uses agent", () => {
    for (const spec of SELECTABLE_MODELS) {
      if (spec.kind !== "Image") {
        const ctx: ExecutionContext = { ...baseCtx, isArenaMode: true };
        expect(computeUseAgent(spec.id, ctx)).toBe(false);
      }
    }
  });

  it("Global kill switch (AGENT_TOOLS_ENABLED) disables agent", () => {
    for (const spec of SELECTABLE_MODELS) {
      if (spec.kind !== "Image") {
        const ctx: ExecutionContext = { ...baseCtx, agentToolsEnabled: false };
        expect(computeUseAgent(spec.id, ctx)).toBe(false);
      }
    }
  });

  it("Models without tool support never use agent", () => {
    for (const spec of SELECTABLE_MODELS) {
      if (spec.kind !== "Image" && !spec.supportsTools) {
        const ctx: ExecutionContext = { ...baseCtx };
        expect(computeUseAgent(spec.id, ctx)).toBe(false);
      }
    }
  });

  it("Default model (glm-5.3-flash) uses agent when no images", () => {
    const ctx: ExecutionContext = { ...baseCtx };
    expect(computeUseAgent(DEFAULT_MODEL_ID, ctx)).toBe(true);
  });

  it("Default model does NOT use agent when images attached (falls back to vision engine without tools)", () => {
    // The default model (glm-5.3-flash) has supportsVision: false, so it falls
    // back to nemotron-vision which has supportsTools: false. The agent loop
    // is correctly disabled in this case.
    const ctx: ExecutionContext = { ...baseCtx, hasImages: true };
    expect(computeUseAgent(DEFAULT_MODEL_ID, ctx)).toBe(false);
  });

  it("Non-vision models with tools lose agent when images attached (fallback to vision engine)", () => {
    // Find a chat model with tools but no vision
    const nonVisionToolModel = SELECTABLE_MODELS.find(
      (m) => m.kind === "Chat" && m.supportsTools && !m.supportsVision
    );
    if (nonVisionToolModel) {
      const ctxNoImages: ExecutionContext = { ...baseCtx, hasImages: false };
      const ctxWithImages: ExecutionContext = { ...baseCtx, hasImages: true };
      expect(computeUseAgent(nonVisionToolModel.id, ctxNoImages)).toBe(true);
      // The vision engine (nemotron-vision) does NOT support tools
      expect(computeUseAgent(nonVisionToolModel.id, ctxWithImages)).toBe(false);
    }
  });

  it("useAgent and computeUseAgent agree for all selectable models", () => {
    const contexts: ExecutionContext[] = [
      { ...baseCtx },
      { ...baseCtx, hasImages: true },
      { ...baseCtx, isArenaMode: true },
      { ...baseCtx, isImageGen: true },
      { ...baseCtx, agentToolsEnabled: false },
    ];

    for (const spec of SELECTABLE_MODELS) {
      for (const ctx of contexts) {
        const caps = getCapabilities(spec.id)!;
        expect(caps.useAgent(ctx)).toBe(computeUseAgent(spec.id, ctx));
      }
    }
  });
});

describe("Capability Registry — Prompt flags match execution decisions", () => {
  const baseCtx: ExecutionContext = {
    hasImages: false,
    isArenaMode: false,
    isImageGen: false,
    agentToolsEnabled: AGENT_TOOLS_ENABLED,
  };

  it("promptToolsAvailable equals useAgent for all contexts", () => {
    const contexts: ExecutionContext[] = [
      { ...baseCtx },
      { ...baseCtx, hasImages: true },
      { ...baseCtx, isArenaMode: true },
      { ...baseCtx, isImageGen: true },
      { ...baseCtx, agentToolsEnabled: false },
    ];

    for (const spec of SELECTABLE_MODELS) {
      for (const ctx of contexts) {
        const caps = getCapabilities(spec.id)!;
        expect(caps.promptToolsAvailable(ctx)).toBe(caps.useAgent(ctx));
        expect(getPromptToolsAvailable(spec.id, ctx)).toBe(computeUseAgent(spec.id, ctx));
      }
    }
  });

  it("promptModelName returns effective model's label when images attached", () => {
    // Non-vision model with vision fallback
    const nonVisionModel = SELECTABLE_MODELS.find(
      (m) => m.kind === "Chat" && !m.supportsVision
    );
    if (nonVisionModel) {
      const caps = getCapabilities(nonVisionModel.id)!;
      const visionEngine = getCapabilities(DEFAULT_VISION_MODEL_ID)!;
      expect(caps.promptModelName(true)).toBe(visionEngine.label);
      expect(getPromptModelName(nonVisionModel.id, true)).toBe(visionEngine.label);
    }
  });

  it("promptModelName returns own label when no images", () => {
    for (const spec of SELECTABLE_MODELS) {
      const caps = getCapabilities(spec.id)!;
      expect(caps.promptModelName(false)).toBe(caps.label);
      expect(getPromptModelName(spec.id, false)).toBe(caps.label);
    }
  });

  it("promptModelName returns own label for vision-capable models with images", () => {
    for (const spec of SELECTABLE_MODELS) {
      if (spec.supportsVision && spec.kind !== "Image") {
        const caps = getCapabilities(spec.id)!;
        expect(caps.promptModelName(true)).toBe(caps.label);
        expect(getPromptModelName(spec.id, true)).toBe(caps.label);
      }
    }
  });
});

describe("Capability Registry — Route chain resolution", () => {
  it("resolveRouteChain returns all routes when all providers available", () => {
    const allProviders = new Set(["nvidia", "mistral", "pollinations", "groq"] as const);
    for (const spec of MODELS) {
      const chain = resolveRouteChain(spec.id, allProviders);
      expect(chain.length).toBe(spec.routes.length);
    }
  });

  it("resolveRouteChain filters by available providers", () => {
    const nvidiaOnly = new Set(["nvidia"] as const);
    for (const spec of MODELS) {
      const chain = resolveRouteChain(spec.id, nvidiaOnly);
      for (const route of chain) {
        expect(route.provider).toBe("nvidia");
      }
    }
  });

  it("resolveRouteChain returns empty for unknown model", () => {
    const allProviders = new Set(["nvidia", "mistral", "pollinations", "groq"] as const);
    expect(resolveRouteChain("unknown-model", allProviders)).toEqual([]);
  });

  it("default model has two routes (nvidia then groq)", () => {
    const allProviders = new Set(["nvidia", "mistral", "pollinations", "groq"] as const);
    const chain = resolveRouteChain(DEFAULT_MODEL_ID, allProviders);
    expect(chain.length).toBe(2);
    expect(chain[0].provider).toBe("nvidia");
    expect(chain[0].modelId).toBe("z-ai/glm-5.3-flash");
    expect(chain[1].provider).toBe("groq");
    expect(chain[1].modelId).toBe("qwen/qwen3.8-27b");
  });
});

describe("Capability Registry — Known model check", () => {
  it("isKnownModel returns true for all MODELS", () => {
    for (const spec of MODELS) {
      expect(isKnownModel(spec.id)).toBe(true);
    }
  });

  it("isKnownModel returns false for unknown ids", () => {
    expect(isKnownModel("unknown")).toBe(false);
    expect(isKnownModel("")).toBe(false);
  });
});

describe("Capability Registry — Specific model assertions", () => {
  it("default model is glm-5.3-flash", () => {
    const caps = getDefaultCapabilities();
    expect(caps.id).toBe("glm-5.3-flash");
    expect(caps.label).toBe("Flyer");
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsVision).toBe(false); // Falls back to nemotron-vision for images
    expect(caps.isReasoning).toBe(true);
    expect(caps.routes.length).toBe(2);
  });

  it("vision engine is nemotron-vision", () => {
    const caps = getVisionEngineCapabilities();
    expect(caps.id).toBe("nemotron-vision");
    expect(caps.kind).toBe("Vision");
    expect(caps.supportsVision).toBe(true);
    expect(caps.supportsTools).toBe(false);
    expect(caps.routes.length).toBe(2);
    // Both routes are NVIDIA
    expect(caps.routes[0].provider).toBe("nvidia");
    expect(caps.routes[1].provider).toBe("nvidia");
  });

  it("utility model is fast-small", () => {
    const caps = getUtilityCapabilities();
    expect(caps.id).toBe("fast-small");
    expect(caps.kind).toBe("Chat");
    expect(caps.hidden).toBe(true);
    expect(caps.supportsTools).toBe(true);
    expect(caps.routes.length).toBe(2);
    expect(caps.routes[0].provider).toBe("nvidia");
    expect(caps.routes[1].provider).toBe("mistral");
  });

  it("qwen 3.8 27B (groq) has label on route for attribution", () => {
    const caps = getDefaultCapabilities();
    const qwenRoute = caps.routes.find((r) => r.modelId === "qwen/qwen3.8-27b");
    expect(qwenRoute).toBeDefined();
    expect(qwenRoute?.label).toBe("Qwen 3.8 27B");
  });

  it("nemotron-vision second leg has label", () => {
    const caps = getVisionEngineCapabilities();
    const omniRoute = caps.routes.find((r) => r.modelId === "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    expect(omniRoute).toBeDefined();
    expect(omniRoute?.label).toBe("Nemotron Nano Omni");
  });

  it("fast-small second leg has label", () => {
    const caps = getUtilityCapabilities();
    const ministralRoute = caps.routes.find((r) => r.modelId === "ministral-8b-latest");
    expect(ministralRoute).toBeDefined();
    expect(ministralRoute?.label).toBe("Ministral 8B");
  });
});

describe("Capability Registry — getEffectiveCapabilities", () => {
  it("returns vision engine caps for default model with images (default is not vision-capable)", () => {
    const eff = getEffectiveCapabilities(DEFAULT_MODEL_ID, true);
    expect(eff.id).toBe(DEFAULT_VISION_MODEL_ID);
    expect(eff.supportsVision).toBe(true);
  });

  it("returns vision engine caps for non-vision model with images", () => {
    const nonVisionModel = SELECTABLE_MODELS.find(
      (m) => m.kind === "Chat" && !m.supportsVision
    );
    if (nonVisionModel) {
      const eff = getEffectiveCapabilities(nonVisionModel.id, true);
      expect(eff.id).toBe(DEFAULT_VISION_MODEL_ID);
      expect(eff.supportsVision).toBe(true);
    }
  });

  it("returns own caps for model without images", () => {
    for (const spec of SELECTABLE_MODELS) {
      if (spec.kind !== "Image") {
        const eff = getEffectiveCapabilities(spec.id, false);
        expect(eff.id).toBe(spec.id);
      }
    }
  });
});

describe("Capability Registry — Helper functions match registry", () => {
  it("modelSupportsTools matches registry", () => {
    for (const spec of MODELS) {
      expect(modelSupportsTools(spec.id)).toBe(getCapabilities(spec.id)?.supportsTools ?? false);
    }
  });

  it("modelSupportsVision matches registry", () => {
    for (const spec of MODELS) {
      expect(modelSupportsVision(spec.id)).toBe(getCapabilities(spec.id)?.supportsVision ?? false);
    }
  });

  it("modelIsVisionModel matches registry", () => {
    for (const spec of MODELS) {
      expect(modelIsVisionModel(spec.id)).toBe(getCapabilities(spec.id)?.isVisionModel ?? false);
    }
  });

  it("modelIsImageModel matches registry", () => {
    for (const spec of MODELS) {
      expect(modelIsImageModel(spec.id)).toBe(getCapabilities(spec.id)?.isImageModel ?? false);
    }
  });

  it("modelIsVisionCapable matches registry", () => {
    for (const spec of MODELS) {
      expect(modelIsVisionCapable(spec.id)).toBe(getCapabilities(spec.id)?.isVisionCapable ?? false);
    }
  });
});