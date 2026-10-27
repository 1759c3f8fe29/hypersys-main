import { interactiveComponentRegistry, type InteractiveComponent } from "@/lib/interactive-types";
import type { ToolDefinition, ToolArtifacts, ToolContext, ToolResult } from "./types";
import type { ToolSchema } from "@/lib/ai";

export const INTERACTIVE_COMPONENT_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "render_component",
    description:
      "Render an interactive component (calculator, chart, data table, map, bill splitter, unit converter, planner, quiz, or comparison table). Call this when the user's request would benefit from an interactive visualization, calculator, or structured data display. The component will appear inline in the chat and the user can interact with it.",
    parameters: {
      type: "object",
      properties: {
        component: {
          type: "object",
          description: "Full InteractiveComponent specification. See component type definitions for required fields per variant.",
        },
      },
      required: ["component"],
      additionalProperties: false,
    },
  },
};

function generateInstanceId(type: string): string {
  return `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export const interactiveComponentExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> => {
  const component = args.component as InteractiveComponent | undefined;

  if (!component) {
    return { ok: false, error: "render_component: missing 'component' argument" };
  }

  // Validate the component against the registry
  const validation = interactiveComponentRegistry.validateComponent(component);

  if (!validation.valid) {
    const errorDetails = validation.errors.join("; ");
    return { ok: false, error: `Component validation failed: ${errorDetails}` };
  }

  // Ensure instanceId is set
  if (!component.instanceId) {
    component.instanceId = generateInstanceId(component.type);
  }

  // Initialize artifacts array if needed
  if (!ctx.artifacts.interactiveComponents) {
    ctx.artifacts.interactiveComponents = [];
  }

  // Add the validated component to artifacts
  ctx.artifacts.interactiveComponents.push(component);

  return {
    ok: true,
    componentType: component.type,
    instanceId: component.instanceId,
  };
};