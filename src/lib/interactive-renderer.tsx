// ---------------------------------------------------------------------------
// Interactive Content Renderer — Main Entry Point
// ---------------------------------------------------------------------------
//
// Renders validated interactive components safely. Each component type
// has its own renderer component, and this orchestrates them.
//
// ---------------------------------------------------------------------------

import { InteractiveComponent, InteractiveComponentType, ValidationResult } from "./interactive-types";
import { validateComponent } from "./interactive-validators";
import CalculatorRenderer from "../components/interactive/CalculatorRenderer";
import ChartRenderer from "../components/interactive/ChartRenderer";
import DataTableRenderer from "../components/interactive/DataTableRenderer";
import MapRenderer from "../components/interactive/MapRenderer";
import BillSplitterRenderer from "../components/interactive/BillSplitterRenderer";
import UnitConverterRenderer from "../components/interactive/UnitConverterRenderer";
import PlannerRenderer from "../components/interactive/PlannerRenderer";
import QuizRenderer from "../components/interactive/QuizRenderer";
import ComparisonRenderer from "../components/interactive/ComparisonRenderer";
import SimulationRenderer from "../components/interactive/SimulationRenderer";
import LiveWidgetRenderer from "../components/interactive/LiveWidgetRenderer";
import EquationSolverRenderer from "../components/interactive/EquationSolverRenderer";
import FunctionPlotterRenderer from "../components/interactive/FunctionPlotterRenderer";
import SurfacePlotterRenderer from "../components/interactive/SurfacePlotterRenderer";
import GeometryRenderer from "../components/interactive/GeometryRenderer";
import CalculusVisualizationRenderer from "../components/interactive/CalculusVisualizationRenderer";
import SeriesVisualizationRenderer from "../components/interactive/SeriesVisualizationRenderer";

export interface RendererProps {
  component: InteractiveComponent;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
  /** Unique instance ID for this render (for multiple same-type components). */
  instanceId?: string;
}

/** Map component types to their renderer components. */
const rendererMap: Record<InteractiveComponentType, React.ComponentType<RendererProps>> = {
  calculator: CalculatorRenderer,
  percentage_calculator: CalculatorRenderer,
  compound_interest_calculator: CalculatorRenderer,
  time_calculator: CalculatorRenderer,
  grade_calculator: CalculatorRenderer,
  chart: ChartRenderer,
  data_table: DataTableRenderer,
  map: MapRenderer,
  bill_splitter: BillSplitterRenderer,
  unit_converter: UnitConverterRenderer,
  planner: PlannerRenderer,
  quiz: QuizRenderer,
  comparison: ComparisonRenderer,
  simulation: SimulationRenderer,
  live_widget: LiveWidgetRenderer,
  equation_solver: EquationSolverRenderer,
  function_plotter: FunctionPlotterRenderer,
  surface_plotter: SurfacePlotterRenderer,
  geometry: GeometryRenderer,
  calculus_visualization: CalculusVisualizationRenderer,
  series_visualization: SeriesVisualizationRenderer,
};

/** Result of attempting to render a component. */
interface RenderResult {
  valid: boolean;
  component: InteractiveComponent;
  validation: ValidationResult;
  element: React.ReactElement | null;
}

/**
 * Validates and renders an interactive component.
 * Returns a render result that includes validation status and the element (or null if invalid).
 */
export function renderInteractiveComponent(
  component: InteractiveComponent,
  props: Omit<RendererProps, "component"> = {}
): RenderResult {
  const validation = validateComponent(component);

  if (!validation.valid) {
    return {
      valid: false,
      component,
      validation,
      element: null,
    };
  }

  const Renderer = rendererMap[component.type];
  if (!Renderer) {
    return {
      valid: false,
      component,
      validation: { valid: false, errors: [`No renderer for type: ${component.type}`], warnings: [] },
      element: null,
    };
  }

  const instanceId = props.instanceId || component.key || `${component.type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return {
    valid: true,
    component,
    validation,
    element: (
      <Renderer
        key={instanceId}
        component={component}
        instanceId={instanceId}
        onUpdate={props.onUpdate}
        className={props.className}
      />
    ),
  };
}

/**
 * React component that safely renders an interactive component with validation.
 * Shows validation errors inline if the component is invalid.
 */
import React from "react";

interface InteractiveContentRendererProps {
  component: InteractiveComponent;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
  instanceId?: string;
  /** If true, shows validation warnings as non-blocking notices. */
  showWarnings?: boolean;
}

export function InteractiveContentRenderer({
  component,
  onUpdate,
  className = "",
  instanceId,
  showWarnings = true,
}: InteractiveContentRendererProps) {
  const result = renderInteractiveComponent(component, { onUpdate, className, instanceId });

  if (!result.valid) {
    return (
      <div className={`interactive-content-error ${className}`} role="alert">
        <div className="error-header">
          <span className="error-icon" aria-hidden="true">⚠️</span>
          <span className="error-title">Invalid Interactive Component</span>
          <span className="error-type">{component.type}</span>
        </div>
        <div className="error-details">
          <h4>Validation Errors:</h4>
          <ul>
            {result.validation.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
          {showWarnings && result.validation.warnings.length > 0 && (
            <>
              <h4>Warnings:</h4>
              <ul>
                {result.validation.warnings.map((warn, i) => (
                  <li key={i}>{warn}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        <details className="error-raw-data">
          <summary>Show raw component data</summary>
          <pre>{JSON.stringify(component, null, 2)}</pre>
        </details>
      </div>
    );
  }

  return (
    <div className={`interactive-content-wrapper ${className}`} data-component-type={component.type} data-instance-id={instanceId}>
      {showWarnings && result.validation.warnings.length > 0 && (
        <div className="interactive-warnings" role="status" aria-live="polite">
          {result.validation.warnings.map((warn, i) => (
            <div key={i} className="warning-item">
              <span className="warning-icon" aria-hidden="true">⚠️</span>
              <span>{warn}</span>
            </div>
          ))}
        </div>
      )}
      {result.element}
    </div>
  );
}

export default InteractiveContentRenderer;