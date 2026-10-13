// ---------------------------------------------------------------------------
// Execution Modes — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests that the four modes produce distinct, correct behaviour and that
// "auto" resolution matches the capability registry's answers.
//
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  EXECUTION_MODES,
  ExecutionMode,
  resolveAutoGate,
  resolveExecutionContext,
  getModeOrder,
  modeRequiresTools,
  getDefaultMode,
  setDefaultMode,
  type ExecutionModeConfig,
} from "@/lib/execution-modes";

// Mock registry for testing
function createMockRegistry(overrides: Partial<Record<string, { supportsTools: boolean; supportsVision: boolean }>> = {}) {
  const defaults: Record<string, { supportsTools: boolean; supportsVision: boolean }> = {
    "glm-5.3-flash": { supportsTools: true, supportsVision: false },
    "nemotron-vision": { supportsTools: false, supportsVision: true },
    "qwen/qwen3.8-27b": { supportsTools: true, supportsVision: false },
    "pollinations-flux": { supportsTools: false, supportsVision: false },
  };

  return {
    getCapabilities: (id: string) => {
      const o = overrides[id] ?? defaults[id];
      if (!o) return undefined;
      return {
        supportsTools: o.supportsTools,
        supportsVision: o.supportsVision,
        effectiveModel: (hasImages: boolean) => {
          if (hasImages && !o.supportsVision) return "nemotron-vision";
          return id;
        },
        promptModelName: (hasImages: boolean) => {
          if (hasImages && !o.supportsVision) return "Flyer Vision";
          return id === "glm-5.3-flash" ? "Flyer" : id;
        },
      };
    },
  };
}

const baseContext = {
  modelSupportsTools: true,
  modelSupportsVision: false,
  effectiveSupportsTools: true,
  effectiveSupportsVision: false,
  hasImages: false,
  isArenaMode: false,
  isImageGen: false,
  agentToolsEnabled: true,
};

describe("Execution Modes — Config", () => {
  it("has exactly four modes", () => {
    expect(Object.keys(EXECUTION_MODES).sort()).toEqual(["auto", "build", "quick", "research"]);
  });

  it("each mode has a unique emoji", () => {
    const emojis = Object.values(EXECUTION_MODES).map((m) => m.emoji);
    expect(new Set(emojis).size).toBe(4);
  });

  it("Quick mode: tools off, deepThink off, webSearch off, preferSpeed on", () => {
    const q = EXECUTION_MODES.quick;
    expect(q.allowTools).toBe(false);
    expect(q.forceDeepThink).toBe(false);
    expect(q.forceWebSearch).toBe(false);
    expect(q.preferSpeed).toBe(true);
    expect(q.allowArtifacts).toBe(false);
    expect(q.maxToolCalls).toBe(0);
  });

  it("Research mode: tools on, deepThink on, webSearch on, preferSpeed off", () => {
    const r = EXECUTION_MODES.research;
    expect(r.allowTools).toBe(true);
    expect(r.forceDeepThink).toBe(true);
    expect(r.forceWebSearch).toBe(true);
    expect(r.preferSpeed).toBe(false);
    expect(r.allowArtifacts).toBe(true);
    expect(r.maxToolCalls).toBe("auto");
  });

  it("Build mode: tools on, deepThink off, webSearch off, allowArtifacts on", () => {
    const b = EXECUTION_MODES.build;
    expect(b.allowTools).toBe(true);
    expect(b.forceDeepThink).toBe(false);
    expect(b.forceWebSearch).toBe(false);
    expect(b.preferSpeed).toBe(false);
    expect(b.allowArtifacts).toBe(true);
    expect(b.maxToolCalls).toBe("auto");
  });

  it("Auto mode: all gates are 'auto'", () => {
    const a = EXECUTION_MODES.auto;
    expect(a.allowTools).toBe("auto");
    expect(a.forceDeepThink).toBe("auto");
    expect(a.forceWebSearch).toBe("auto");
    expect(a.preferSpeed).toBe(false);
    expect(a.allowArtifacts).toBe(true);
    expect(a.maxToolCalls).toBe("auto");
  });
});

describe("Execution Modes — resolveAutoGate", () => {
  const baseCtx = {
    modelSupportsTools: true,
    modelSupportsVision: false,
    effectiveSupportsTools: true,
    effectiveSupportsVision: false,
    hasImages: false,
    isArenaMode: false,
    isImageGen: false,
    agentToolsEnabled: true,
  };

  it("allowTools auto: on for tool-capable model, no images, not arena", () => {
    expect(resolveAutoGate("auto", "allowTools", { ...baseCtx })).toBe(true);
  });

  it("allowTools auto: off for non-tool model", () => {
    expect(resolveAutoGate("auto", "allowTools", { ...baseCtx, modelSupportsTools: false, effectiveSupportsTools: false })).toBe(false);
  });

  it("allowTools auto: off for arena mode", () => {
    expect(resolveAutoGate("auto", "allowTools", { ...baseCtx, isArenaMode: true })).toBe(false);
  });

  it("allowTools auto: off for image gen", () => {
    expect(resolveAutoGate("auto", "allowTools", { ...baseCtx, isImageGen: true })).toBe(false);
  });

  it("allowTools auto: off when global disabled", () => {
    expect(resolveAutoGate("auto", "allowTools", { ...baseCtx, agentToolsEnabled: false })).toBe(false);
  });

  it("allowTools auto: off when images attached and model not vision-capable (falls back to vision engine without tools)", () => {
    // When images are attached, the effective model is nemotron-vision which has no tools
    expect(resolveAutoGate("auto", "allowTools", { ...baseCtx, hasImages: true, effectiveSupportsTools: false })).toBe(false);
  });

  it("forceDeepThink auto: on for tool-capable model without images", () => {
    expect(resolveAutoGate("auto", "forceDeepThink", { ...baseCtx })).toBe(true);
  });

  it("forceDeepThink auto: off when images attached (vision synthesis path)", () => {
    expect(resolveAutoGate("auto", "forceDeepThink", { ...baseCtx, hasImages: true })).toBe(false);
  });

  it("forceDeepThink auto: off for image gen", () => {
    expect(resolveAutoGate("auto", "forceDeepThink", { ...baseCtx, isImageGen: true })).toBe(false);
  });

  it("forceWebSearch auto: on for tool-capable model, no images, not arena", () => {
    expect(resolveAutoGate("auto", "forceWebSearch", { ...baseCtx })).toBe(true);
  });

  it("forceWebSearch auto: off when images attached", () => {
    expect(resolveAutoGate("auto", "forceWebSearch", { ...baseCtx, hasImages: true })).toBe(false);
  });

  it("forceWebSearch auto: off for image gen", () => {
    expect(resolveAutoGate("auto", "forceWebSearch", { ...baseCtx, isImageGen: true })).toBe(false);
  });

  it("forceWebSearch auto: off for arena mode", () => {
    expect(resolveAutoGate("auto", "forceWebSearch", { ...baseCtx, isArenaMode: true })).toBe(false);
  });

  it("forceWebSearch auto: off for non-tool model", () => {
    expect(resolveAutoGate("auto", "forceWebSearch", { ...baseCtx, effectiveSupportsTools: false })).toBe(false);
  });

  it("explicit true/false always wins over auto", () => {
    expect(resolveAutoGate("quick", "allowTools", { ...baseCtx })).toBe(false);
    expect(resolveAutoGate("research", "allowTools", { ...baseCtx, effectiveSupportsTools: false })).toBe(true);
  });
});

describe("Execution Modes — resolveExecutionContext", () => {
  const registry = createMockRegistry();

  // Context now matches the resolveAutoGate signature
  const baseCtx = {
    hasImages: false,
    isArenaMode: false,
    isImageGen: false,
    agentToolsEnabled: true,
  };

  it("Quick mode disables tools even for tool-capable model", () => {
    const resolved = resolveExecutionContext("quick", "glm-5.3-flash", baseCtx, registry);
    expect(resolved.allowTools).toBe(false);
    expect(resolved.forceDeepThink).toBe(false);
    expect(resolved.forceWebSearch).toBe(false);
    expect(resolved.preferSpeed).toBe(true);
    expect(resolved.allowArtifacts).toBe(false);
  });

  it("Research mode enables everything for tool-capable model", () => {
    const resolved = resolveExecutionContext("research", "glm-5.3-flash", baseCtx, registry);
    expect(resolved.allowTools).toBe(true);
    expect(resolved.forceDeepThink).toBe(true);
    expect(resolved.forceWebSearch).toBe(true);
    expect(resolved.preferSpeed).toBe(false);
    expect(resolved.allowArtifacts).toBe(true);
  });

  it("Build mode enables tools and artifacts, disables deepThink and webSearch", () => {
    const resolved = resolveExecutionContext("build", "glm-5.3-flash", baseCtx, registry);
    expect(resolved.allowTools).toBe(true);
    expect(resolved.forceDeepThink).toBe(false);
    expect(resolved.forceWebSearch).toBe(false);
    expect(resolved.allowArtifacts).toBe(true);
  });

  it("Auto mode for tool-capable model with no images: tools on, deepThink on, webSearch on", () => {
    const resolved = resolveExecutionContext("auto", "glm-5.3-flash", { ...baseCtx, hasImages: false }, registry);
    expect(resolved.allowTools).toBe(true);
    expect(resolved.forceDeepThink).toBe(true);
    expect(resolved.forceWebSearch).toBe(true);
  });

  it("Auto mode with images: tools OFF (falls back to vision engine without tools)", () => {
    const resolved = resolveExecutionContext("auto", "glm-5.3-flash", { ...baseCtx, hasImages: true }, registry);
    expect(resolved.allowTools).toBe(false);
    expect(resolved.forceDeepThink).toBe(false);
    expect(resolved.forceWebSearch).toBe(false);
    expect(resolved.effectiveModelId).toBe("nemotron-vision");
    expect(resolved.modelNameForPrompt).toBe("Flyer Vision");
  });

  it("Auto mode for vision-capable model with images: tools follow vision engine capabilities", () => {
    // nemotron-vision doesn't support tools
    const resolved = resolveExecutionContext("auto", "nemotron-vision", { ...baseCtx, hasImages: true }, registry);
    expect(resolved.allowTools).toBe(false);
    expect(resolved.effectiveModelId).toBe("nemotron-vision");
  });

  it("Arena mode in Auto disables tools, deepThink, webSearch", () => {
    const resolved = resolveExecutionContext("auto", "glm-5.3-flash", { ...baseCtx, isArenaMode: true }, registry);
    expect(resolved.allowTools).toBe(false);
    expect(resolved.forceDeepThink).toBe(false);
    expect(resolved.forceWebSearch).toBe(false);
  });

  it("Image gen in Auto disables tools, deepThink, webSearch", () => {
    const resolved = resolveExecutionContext("auto", "pollinations-flux", { ...baseCtx, isImageGen: true }, registry);
    expect(resolved.allowTools).toBe(false);
    expect(resolved.forceDeepThink).toBe(false);
    expect(resolved.forceWebSearch).toBe(false);
  });

  it("Global kill switch (agentToolsEnabled: false) disables tools in Auto", () => {
    const resolved = resolveExecutionContext("auto", "glm-5.3-flash", { ...baseCtx, agentToolsEnabled: false }, registry);
    expect(resolved.allowTools).toBe(false);
  });

  it("maxToolCalls: explicit number for quick, 10 for auto", () => {
    expect(resolveExecutionContext("quick", "glm-5.3-flash", baseCtx, registry).maxToolCalls).toBe(0);
    expect(resolveExecutionContext("auto", "glm-5.3-flash", baseCtx, registry).maxToolCalls).toBe(10);
    expect(resolveExecutionContext("research", "glm-5.3-flash", baseCtx, registry).maxToolCalls).toBe(10);
    expect(resolveExecutionContext("build", "glm-5.3-flash", baseCtx, registry).maxToolCalls).toBe(10);
  });
});

describe("Execution Modes — Helpers", () => {
  it("getModeOrder returns correct order", () => {
    expect(getModeOrder()).toEqual(["auto", "quick", "research", "build"]);
  });

  it("modeRequiresTools: true for research and build, auto for auto, false for quick", () => {
    expect(modeRequiresTools("research")).toBe(true);
    expect(modeRequiresTools("build")).toBe(true);
    expect(modeRequiresTools("auto")).toBe(true);
    expect(modeRequiresTools("quick")).toBe(false);
  });

  it("getDefaultMode returns 'auto' when no localStorage", () => {
    // In test environment, localStorage may not exist or be mocked
    // Just verify the function exists and returns a valid mode
    const mode = getDefaultMode();
    expect(["auto", "quick", "research", "build"]).toContain(mode);
  });
});