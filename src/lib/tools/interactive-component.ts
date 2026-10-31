import { interactiveComponentRegistry, type InteractiveComponent } from "@/lib/interactive-types";
import type { ToolDefinition, ToolArtifacts, ToolContext, ToolResult } from "./types";
import type { ToolSchema } from "@/lib/ai";

export const INTERACTIVE_COMPONENT_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "render_component",
    description:
      "Render an interactive component inline in the chat. Use this PROACTIVELY when the user's request involves math, data visualization, geometry, calculus, series, or any interactive exploration. The component appears as an interactive widget the user can manipulate immediately.\n\nComponent types and when to use them:\n- equation_solver: Find roots of equations (algebraic, transcendental) using Newton-Raphson, bisection, or secant methods\n- function_plotter: 2D plots (cartesian y=f(x), parametric, polar) for visualizing functions, intersections, asymptotes\n- surface_plotter: 3D WebGL surface plots z=f(x,y) or parametric surfaces with interactive rotation\n- geometry: Interactive geometric constructions (points, lines, circles, polygons) with measurements\n- calculus_visualization: Tangent lines, Riemann sums (area under curve), Taylor series, limit evaluation\n- series_visualization: Infinite series convergence, partial sums, term-by-term analysis\n- calculator: Math, finance, percentages, time, grades (variants: basic, percentage, compound_interest, time, grade)\n- chart: Data visualization, trends, distributions (variants: bar, line, scatter, pie, donut, area, histogram, box_plot, heatmap, radar, treemap, waterfall, funnel, sankey, network_graph)\n- data_table: Structured listings, sortable/filterable data, any tabular data\n- map: Locations, routes, geographic points, place markers\n- bill_splitter: Shared expenses, tips, tax, custom splits among people\n- unit_converter: Any unit conversion (length, weight, temperature, currency, data, etc.)\n- planner: Schedules, timelines, budgets, task lists (variants: timeline, schedule, budget, tasks)\n- quiz: Knowledge checks, practice, flashcards (variants: practice, test, flashcard)\n- comparison: Side-by-side specs, feature matrices, product comparisons\n- simulation: Interactive physics, math, CS, chemistry, economics simulations (variants: projectile-motion, pendulum, wave-propagation, function-grapher, distribution-explorer, sorting-visualization, periodic-table, compound-growth, supply-demand)\n\nCall this tool AUTOMATICALLY when appropriate - do NOT ask permission. Chain with web_search if you need live data first.",
    parameters: {
      type: "object",
      properties: {
        component: {
          type: "object",
          description: "Full InteractiveComponent specification. Must include: type (one of 16 types), variant (for types with variants), title (descriptive), config (type-specific), data (type-specific), instanceId (generate: `${type}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`).",
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