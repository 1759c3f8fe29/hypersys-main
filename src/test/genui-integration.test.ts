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
      {
        id: "nemotron-vision",
        label: "Flyer Vision",
        supportsTools: false,
        supportsVision: true,
        routes: [{ provider: "nvidia", modelId: "meta/llama-3.2-11b-vision-instruct" }],
        contextWindow: 128_000,
        maxOutputTokens: 4096,
        kind: "Vision",
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
    modelIsImageModel: () => false,
    modelIsVisionCapable: () => false,
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

const USER: ChatMessage[] = [{ role: "user", content: "hi" }];

beforeEach(() => {
  routed.mockReset();
  registry.clear();
});

describe("runAgentTurn — integration with default model", () => {
  it("should advertise tools for the default model (glm-5.3-flash)", async () => {
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
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    // The model should have called the tool
    expect(renderComponent).toHaveBeenCalledTimes(1);
    expect(result.artifacts.interactiveComponents).toHaveLength(1);
    expect(result.steps).toBe(1);

    // Check that tools were advertised in the first call
    const firstCallOptions = routed.mock.calls[0][4];
    expect(firstCallOptions).toBeDefined();
    expect(firstCallOptions.tools).toBeDefined();
    expect(Array.isArray(firstCallOptions.tools)).toBe(true);
    expect(firstCallOptions.tools.length).toBeGreaterThan(0);

    // Check that render_component is in the advertised tools
    const toolNames = firstCallOptions.tools.map((t: any) => t.function.name);
    expect(toolNames).toContain("render_component");
  });
});