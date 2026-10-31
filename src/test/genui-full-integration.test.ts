import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, StreamResult, ToolSchema } from "@/lib/ai";
import type { ToolDefinition } from "@/lib/tools/types";
import type { InteractiveComponent } from "@/lib/interactive-types";

const routed = vi.hoisted(() => vi.fn());
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/ai", () => ({ generateRoutedResponse: routed }));
vi.mock("@/lib/tools", () => ({
  getTool: (name: string) => registry.get(name),
  toolSchemas: () =>
    [...registry.keys()].map((name) => ({
      type: "function",
      function: { name, description: name, parameters: {} },
    })) as ToolSchema[],
  toolRecoveryInfos: () => [...registry.keys()].map((name) => ({ name, required: [], properties: {} })),
}));

vi.mock("@/lib/providers", () => {
  return {
    MODELS: [
      {
        id: "glm-5.3-flash",
        label: "Flyer",
        supportsTools: true,
        supportsVision: false,
        routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" }],
        contextWindow: 128_000,
        maxOutputTokens: 8192,
        kind: "Chat",
        isReasoning: true,
        featured: true,
      },
    ],
    SELECTABLE_MODELS: [],
    DEFAULT_MODEL_ID: "glm-5.3-flash",
    DEFAULT_VISION_MODEL_ID: "nemotron-vision",
    getModel: (id: string) => ({
      id: "glm-5.3-flash",
      label: "Flyer",
      supportsTools: true,
      supportsVision: false,
      routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" }],
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      kind: "Chat",
      isReasoning: true,
    }),
    supportsTools: (id: string) => true,
  };
});

vi.mock("@/lib/capabilities", () => {
  return {
    getCapabilities: (id: string) => {
      if (id === "glm-5.3-flash") {
        return {
          id: "glm-5.3-flash",
          label: "Flyer",
          supportsTools: true,
          supportsVision: false,
          isReasoning: true,
          contextWindow: 128_000,
          maxOutputTokens: 8192,
          routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" }],
          primaryProvider: "nvidia",
          isVisionCapable: false,
          isImageModel: false,
          isVisionModel: false,
          useAgent: (ctx: any) => {
            if (ctx.isImageGen) return false;
            if (ctx.isArenaMode) return false;
            if (!ctx.agentToolsEnabled) return false;
            const effId = ctx.hasImages ? "nemotron-vision" : "glm-5.3-flash";
            return effId === "glm-5.3-flash";
          },
          effectiveModel: (hasImages: boolean) => hasImages ? "nemotron-vision" : "glm-5.3-flash",
          promptToolsAvailable: (ctx: any) => {
            if (ctx.isImageGen) return false;
            if (ctx.isArenaMode) return false;
            if (!ctx.agentToolsEnabled) return false;
            const effId = ctx.hasImages ? "nemotron-vision" : "glm-5.3-flash";
            return effId === "glm-5.3-flash";
          },
          promptModelName: (hasImages: boolean) => hasImages ? "Flyer Vision" : "Flyer",
        };
      }
      return undefined;
    },
    requireCapabilities: (id: string) => {
      // This is not used in the test, but we need to mock it
      if (id === "glm-5.3-flash") {
        return {
          id: "glm-5.3-flash",
          label: "Flyer",
          supportsTools: true,
          supportsVision: false,
          isReasoning: true,
          contextWindow: 128_000,
          maxOutputTokens: 8192,
          routes: [{ provider: "nvidia", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" }],
          primaryProvider: "nvidia",
          isVisionCapable: false,
          isImageModel: false,
          isVisionModel: false,
          useAgent: (ctx: any) => {
            if (ctx.isImageGen) return false;
            if (ctx.isArenaMode) return false;
            if (!ctx.agentToolsEnabled) return false;
            const effId = ctx.hasImages ? "nemotron-vision" : "glm-5.3-flash";
            return effId === "glm-5.3-flash";
          },
          effectiveModel: (hasImages: boolean) => hasImages ? "nemotron-vision" : "glm-5.3-flash",
          promptToolsAvailable: (ctx: any) => {
            if (ctx.isImageGen) return false;
            if (ctx.isArenaMode) return false;
            if (!ctx.agentToolsEnabled) return false;
            const effId = ctx.hasImages ? "nemotron-vision" : "glm-5.3-flash";
            return effId === "glm-5.3-flash";
          },
          promptModelName: (hasImages: boolean) => hasImages ? "Flyer Vision" : "Flyer",
        };
      }
      throw new Error(`Unknown model id: ${id}`);
    },
    modelSupportsTools: (id: string) => id === "glm-5.3-flash",
    modelSupportsVision: (id: string) => id === "nemotron-vision",
    computeUseAgent: (selectedModelId: string, ctx: any) => {
      if (ctx.isImageGen) return false;
      if (ctx.isArenaMode) return false;
      if (!ctx.agentToolsEnabled) return false;
      const effId = ctx.hasImages ? "nemotron-vision" : "glm-5.3-flash";
      return effId === "glm-5.3-flash";
    },
    getPromptToolsAvailable: (selectedModelId: string, ctx: any) => {
      if (ctx.isImageGen) return false;
      if (ctx.isArenaMode) return false;
      if (!ctx.agentToolsEnabled) return false;
      const effId = ctx.hasImages ? "nemotron-vision" : "glm-5.3-flash";
      return effId === "glm-5.3-flash";
    },
  };
});

vi.mock("@/lib/execution-modes", () => {
  return {
    ExecutionMode: ["auto", "quick", "research", "build"],
    EXECUTION_MODES: {
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
    },
    resolveExecutionContext: (mode: string, selectedModelId: string, context: any, registry: any) => {
      const caps = registry.getCapabilities(selectedModelId);
      const effectiveModelId = caps?.effectiveModel(context.hasImages) ?? selectedModelId;
      const modelNameForPrompt = caps?.promptModelName(context.hasImages) ?? selectedModelId;
      const effectiveCaps = registry.getCapabilities(effectiveModelId);
      const effectiveSupportsTools = effectiveCaps?.supportsTools ?? false;

      // resolveAutoGate for allowTools
      const allowTools = effectiveSupportsTools && !context.isArenaMode && !context.isImageGen && context.agentToolsEnabled;

      return {
        mode,
        allowTools,
        forceDeepThink: false,
        forceWebSearch: false,
        preferSpeed: false,
        allowArtifacts: true,
        maxToolCalls: 10,
        useUtilityModel: true,
        effectiveModelId,
        modelNameForPrompt,
      };
    },
    getDefaultMode: () => "auto",
  };
});

const { runAgentTurn, MAX_STEPS } = await import("@/lib/agent");

const TOOL_MODEL = "glm-5.3-flash";

type Turn = {
  text?: string;
  calls?: Array<{ id: string; name: string; argumentsJson: string }>;
};

function script(...turns: Turn[]) {
  let i = 0;
  routed.mockImplementation(
    async (
      _messages: ChatMessage[],
      _modelId: string,
      onChunk: (t: string) => void,
    ): Promise<StreamResult> => {
      const turn = turns[i] ?? {};
      i += 1;
      if (turn.text) onChunk(turn.text);
      return {
        toolCalls: (turn.calls ?? []).map((c) => ({ ...c })),
        sawContent: !!turn.text,
        finishReason: turn.calls?.length ? "tool_calls" : "stop",
      };
    },
  );
}

function tool(name: string, execute: ToolDefinition["execute"]) {
  const spy = vi.fn(execute);
  registry.set(name, { name, schema: { type: "function", function: { name, description: "", parameters: {} } }, execute: spy });
  return spy;
}

function makeEquationSolver(overrides: Partial<InteractiveComponent> = {}): InteractiveComponent {
  return {
    type: "equation_solver",
    title: "Solve x^2 - 4 = 0",
    expression: "x^2 - 4",
    variable: "x",
    method: "auto",
    instanceId: "eq_123",
    ...overrides,
  } as InteractiveComponent;
}

const USER: ChatMessage[] = [{ role: "user", content: "Create an equation solver for x^2 - 4 = 0" }];

beforeEach(() => {
  routed.mockReset();
  registry.clear();
});

describe("runAgentTurn — full GenUI integration", () => {
  it("should execute render_component tool with default model in auto mode", async () => {
    const renderComponent = tool("render_component", async (args, ctx) => {
      const component = args.component as InteractiveComponent;
      if (!ctx.artifacts.interactiveComponents) {
        ctx.artifacts.interactiveComponents = [];
      }
      ctx.artifacts.interactiveComponents.push(component);
      return { ok: true, componentType: component.type, instanceId: component.instanceId };
    });

    script(
      {
        calls: [{
          id: "c1",
          name: "render_component",
          argumentsJson: JSON.stringify({
            component: makeEquationSolver()
          })
        }]
      },
      { text: "Here's the equation solver." },
    );
    const result = await runAgentTurn({
      messages: USER,
      modelId: TOOL_MODEL,
      onChunk: () => {},
      signal: undefined,
      deepThink: false,
      attachments: [],
    });

    // The model should have called the tool
    expect(renderComponent).toHaveBeenCalledTimes(1);
    expect(result.artifacts.interactiveComponents).toHaveLength(1);
    expect(result.artifacts.interactiveComponents?.[0].type).toBe("equation_solver");
    expect(result.steps).toBe(1);
  });
});