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

function requestMessages(n: number): ChatMessage[] {
  return routed.mock.calls[n][0] as ChatMessage[];
}

const USER: ChatMessage[] = [{ role: "user", content: "hi" }];

beforeEach(() => {
  routed.mockReset();
  registry.clear();
});

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

function makeFunctionPlotter(overrides: Partial<InteractiveComponent> = {}): InteractiveComponent {
  return {
    type: "function_plotter",
    title: "Plot sin(x)",
    expression: "sin(x)",
    domain: [-10, 10],
    instanceId: "fp_456",
    ...overrides,
  } as InteractiveComponent;
}

describe("runAgentTurn — render_component tool", () => {
  it("executes render_component and adds component to artifacts", async () => {
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

    expect(renderComponent).toHaveBeenCalledTimes(1);
    expect(result.artifacts.interactiveComponents).toHaveLength(1);
    expect(result.artifacts.interactiveComponents?.[0].type).toBe("equation_solver");
    expect(result.steps).toBe(1);
  });

  it("renders multiple components in one turn", async () => {
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
        calls: [
          {
            id: "c1",
            name: "render_component",
            argumentsJson: JSON.stringify({
              component: makeEquationSolver()
            })
          },
          {
            id: "c2",
            name: "render_component",
            argumentsJson: JSON.stringify({
              component: makeFunctionPlotter()
            })
          },
        ]
      },
      { text: "Here are both components." },
    );
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    expect(renderComponent).toHaveBeenCalledTimes(2);
    expect(result.artifacts.interactiveComponents).toHaveLength(2);
    expect(result.artifacts.interactiveComponents?.[0].type).toBe("equation_solver");
    expect(result.artifacts.interactiveComponents?.[1].type).toBe("function_plotter");
  });

  it("returns validation error for invalid component spec", async () => {
    const renderComponent = tool("render_component", async (args, ctx) => {
      const component = args.component as { type?: string } | undefined;
      if (!component || !component.type) {
        return { ok: false, error: "Component validation failed: missing type" };
      }
      return { ok: true, componentType: component.type };
    });
    script(
      {
        calls: [{
          id: "c1",
          name: "render_component",
          argumentsJson: JSON.stringify({
            component: {
              title: "Missing type"
            }
          })
        }]
      },
      { text: "I couldn't render that." },
    );
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    expect(renderComponent).toHaveBeenCalledTimes(1);
    expect(result.artifacts.interactiveComponents).toBeUndefined();
    expect(result.steps).toBe(1);
  });
});