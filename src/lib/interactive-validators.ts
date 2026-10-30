// ---------------------------------------------------------------------------
// Interactive Component Validators & Calculator Functions
// ---------------------------------------------------------------------------
//
// Validation logic for each component type and registered calculator functions.
// These are pure functions that can be tested independently.
//
// ---------------------------------------------------------------------------

import {
  InteractiveComponent,
  InteractiveComponentType,
  ValidationResult,
  ComponentLimits,
  CalculatorComponent,
  ChartComponent,
  DataTableComponent,
  MapComponent,
  BillSplitterComponent,
  UnitConverterComponent,
  PlannerComponent,
  QuizComponent,
  ComparisonComponent,
  SimulationComponent,
  LiveWidgetComponent,
  LiveWidgetType,
  LiveWidgetConfig,
  LiveWidgetData,
  EquationSolverComponent,
  FunctionPlotterComponent,
  SurfacePlotterComponent,
  GeometryComponent,
  CalculusVisualizationComponent,
  SeriesVisualizationComponent,
} from "./interactive-types";
import { getSimulation } from "./simulations";

/** Default limits for all components. */
const DEFAULT_LIMITS: ComponentLimits = {
  maxFields: 20,
  maxDataPoints: 500,
  maxRows: 1000,
  maxColumns: 50,
  maxMarkers: 100,
  maxItems: 50,
  maxQuestions: 30,
  maxCriteria: 15,
  maxTextLength: 5000,
};

/** Helper to create a validation result. */
function ok(warnings: string[] = []): ValidationResult {
  return { valid: true, errors: [], warnings };
}

function fail(errors: string[], warnings: string[] = []): ValidationResult {
  return { valid: false, errors, warnings };
}

function checkLimit(value: number, limit: number | undefined, name: string): string | null {
  if (limit !== undefined && value > limit) {
    return `${name} exceeds limit of ${limit} (got ${value})`;
  }
  return null;
}

/** Validate a calculator component. */
export function validateCalculator(component: CalculatorComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Calculator must have a title");
  }
  if (component.title && component.title.length > (DEFAULT_LIMITS.maxTextLength || 5000)) {
    errors.push("Title exceeds maximum length");
  }

  if (!component.fields || component.fields.length === 0) {
    errors.push("Calculator must have at least one field");
  } else {
    const limitError = checkLimit(component.fields.length, DEFAULT_LIMITS.maxFields, "Fields");
    if (limitError) errors.push(limitError);

    const seenIds = new Set<string>();
    for (const field of component.fields) {
      if (!field.id || !field.label) {
        errors.push("Each field must have an id and label");
        break;
      }
      if (seenIds.has(field.id)) {
        errors.push(`Duplicate field id: ${field.id}`);
        break;
      }
      seenIds.add(field.id);

      if (field.type === "number") {
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
          warnings.push(`Field ${field.id}: min > max`);
        }
        if (field.step !== undefined && field.step <= 0) {
          warnings.push(`Field ${field.id}: step must be positive`);
        }
      }

      if (field.type === "select" && (!field.options || field.options.length === 0)) {
        warnings.push(`Select field ${field.id} has no options`);
      }
    }
  }

  if (!component.formula || component.formula.trim().length === 0) {
    errors.push("Calculator must have a formula identifier");
  }

  if (!component.inputs || Object.keys(component.inputs).length === 0) {
    warnings.push("Calculator has no initial inputs");
  } else {
    for (const [key, value] of Object.entries(component.inputs)) {
      if (typeof value !== "number" && typeof value !== "string") {
        warnings.push(`Input ${key} has invalid type`);
      }
    }
  }

  if (component.precision !== undefined && (component.precision < 0 || component.precision > 10)) {
    warnings.push("Precision should be between 0 and 10");
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a chart component. */
export function validateChart(component: ChartComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Chart must have a title");
  }

  const validChartTypes = [
    "bar", "line", "scatter", "pie", "donut", "area",
    "histogram", "box_plot", "heatmap", "radar", "treemap", "waterfall", "funnel", "sankey", "network_graph"
  ] as const;
  if (!validChartTypes.includes(component.chartType)) {
    errors.push(`Invalid chart type: ${component.chartType}`);
  }

  if (!component.data || component.data.length === 0) {
    errors.push("Chart must have at least one dataset");
  } else {
    let totalPoints = 0;
    for (const dataset of component.data) {
      if (!dataset.label) {
        warnings.push("Dataset missing label");
      }
      if (!dataset.data || dataset.data.length === 0) {
        warnings.push(`Dataset ${dataset.label} has no data points`);
      }
      totalPoints += dataset.data?.length || 0;
    }
    const limitError = checkLimit(totalPoints, DEFAULT_LIMITS.maxDataPoints, "Data points");
    if (limitError) errors.push(limitError);
  }

  // Cartesian charts
  if (["line", "scatter", "bar", "histogram", "waterfall"].includes(component.chartType)) {
    if (!component.xKey) {
      warnings.push(`${component.chartType} charts should specify xKey`);
    }
    if (!component.yKeys || component.yKeys.length === 0) {
      warnings.push(`${component.chartType} charts should specify yKeys`);
    }
  }

  if (["pie", "donut", "funnel"].includes(component.chartType)) {
    if (!component.labelKey || !component.valueKey) {
      warnings.push(`${component.chartType} charts should specify labelKey and valueKey`);
    }
  }

  if (component.chartType === "box_plot") {
    if (!component.yKeys || component.yKeys.length === 0) {
      warnings.push("box_plot charts should specify yKeys");
    }
  }

  if (["heatmap", "radar"].includes(component.chartType)) {
    if (!component.categoryKey || !component.seriesKey || !component.valueKey) {
      warnings.push(`${component.chartType} charts should specify categoryKey, seriesKey, and valueKey`);
    }
  }

  if (component.chartType === "treemap") {
    if (!component.labelKey || !component.valueKey) {
      warnings.push("treemap charts should specify labelKey and valueKey");
    }
  }

  if (component.chartType === "sankey") {
    if (!component.sourceKey || !component.targetKey || !component.weightKey) {
      warnings.push("sankey charts should specify sourceKey, targetKey, and weightKey");
    }
  }

  if (component.chartType === "network_graph") {
    if (!component.nodeIdKey || !component.linkSourceKey || !component.linkTargetKey) {
      warnings.push("network_graph charts should specify nodeIdKey, linkSourceKey, and linkTargetKey");
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a data table component. */
export function validateDataTable(component: DataTableComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Data table must have a title");
  }

  if (!component.columns || component.columns.length === 0) {
    errors.push("Data table must have at least one column");
  } else {
    const limitError = checkLimit(component.columns.length, DEFAULT_LIMITS.maxColumns, "Columns");
    if (limitError) errors.push(limitError);

    const seenKeys = new Set<string>();
    for (const col of component.columns) {
      if (!col.key || !col.header) {
        errors.push("Each column must have a key and header");
        break;
      }
      if (seenKeys.has(col.key)) {
        errors.push(`Duplicate column key: ${col.key}`);
        break;
      }
      seenKeys.add(col.key);
    }
  }

  if (!component.rows || component.rows.length === 0) {
    warnings.push("Data table has no rows");
  } else {
    const limitError = checkLimit(component.rows.length, DEFAULT_LIMITS.maxRows, "Rows");
    if (limitError) errors.push(limitError);

    // Check that rows have data for all columns
    if (component.columns) {
      const columnKeys = new Set(component.columns.map(c => c.key));
      for (let i = 0; i < Math.min(component.rows.length, 5); i++) {
        const rowKeys = new Set(Object.keys(component.rows[i]));
        for (const key of columnKeys) {
          if (!rowKeys.has(key)) {
            warnings.push(`Row ${i} missing column: ${key}`);
          }
        }
      }
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a map component. */
export function validateMap(component: MapComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Map must have a title");
  }

  if (!component.center || component.center.length !== 2) {
    errors.push("Map must have center coordinates [lat, lng]");
  } else {
    const [lat, lng] = component.center;
    if (lat < -90 || lat > 90) errors.push("Latitude must be between -90 and 90");
    if (lng < -180 || lng > 180) errors.push("Longitude must be between -180 and 180");
  }

  if (component.zoom !== undefined && (component.zoom < 0 || component.zoom > 20)) {
    warnings.push("Zoom should be between 0 and 20");
  }

  if (component.markers) {
    const limitError = checkLimit(component.markers.length, DEFAULT_LIMITS.maxMarkers, "Markers");
    if (limitError) errors.push(limitError);

    const seenIds = new Set<string>();
    for (const marker of component.markers) {
      if (!marker.id || !marker.position || marker.position.length !== 2) {
        errors.push("Each marker must have an id and position [lat, lng]");
        break;
      }
      if (seenIds.has(marker.id)) {
        errors.push(`Duplicate marker id: ${marker.id}`);
        break;
      }
      seenIds.add(marker.id);

      const [lat, lng] = marker.position;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        warnings.push(`Marker ${marker.id} has invalid coordinates`);
      }
    }
  }

  if (component.paths) {
    for (const path of component.paths) {
      if (!path.id || !path.coordinates || path.coordinates.length < 2) {
        errors.push("Each path must have an id and at least 2 coordinates");
        break;
      }
      for (const [lat, lng] of path.coordinates) {
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          warnings.push(`Path ${path.id} has invalid coordinates`);
        }
      }
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a bill splitter component. */
export function validateBillSplitter(component: BillSplitterComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Bill splitter must have a title");
  }

  if (component.total === undefined || component.total < 0) {
    errors.push("Total must be a non-negative number");
  }

  if (component.people === undefined || component.people < 1) {
    errors.push("People must be at least 1");
  } else if (component.people > 100) {
    warnings.push("Large number of people; consider if this is correct");
  }

  if (component.tipPercent !== undefined && (component.tipPercent < 0 || component.tipPercent > 100)) {
    warnings.push("Tip percent should be between 0 and 100");
  }

  if (component.taxPercent !== undefined && (component.taxPercent < 0 || component.taxPercent > 100)) {
    warnings.push("Tax percent should be between 0 and 100");
  }

  if (component.customSplits) {
    if (component.customSplits.length !== component.people) {
      warnings.push("Custom splits count doesn't match people count");
    }
    const totalSplit = component.customSplits.reduce((sum, s) => sum + s.amount, 0);
    if (Math.abs(totalSplit - component.total) > 0.01) {
      warnings.push("Custom splits don't add up to total");
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a unit converter component. */
export function validateUnitConverter(component: UnitConverterComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Unit converter must have a title");
  }

  const validCategories = ["length", "weight", "temperature", "volume", "area", "speed", "time", "data", "pressure"] as const;
  if (!validCategories.includes(component.category)) {
    errors.push(`Invalid category: ${component.category}`);
  }

  if (!component.fromUnit || !component.toUnit) {
    errors.push("Unit converter must specify fromUnit and toUnit");
  } else if (component.fromUnit === component.toUnit) {
    warnings.push("fromUnit and toUnit are the same");
  }

  if (typeof component.value !== "number" || !isFinite(component.value)) {
    errors.push("Value must be a finite number");
  }

  if (!component.availableUnits || component.availableUnits.length === 0) {
    warnings.push("No available units provided");
  } else {
    const units = new Set(component.availableUnits.map(u => u.value));
    if (!units.has(component.fromUnit)) warnings.push("fromUnit not in availableUnits");
    if (!units.has(component.toUnit)) warnings.push("toUnit not in availableUnits");
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a planner component. */
export function validatePlanner(component: PlannerComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Planner must have a title");
  }

  const validModes = ["timeline", "schedule", "budget", "tasks"] as const;
  if (!validModes.includes(component.mode)) {
    errors.push(`Invalid planner mode: ${component.mode}`);
  }

  if (!component.items || component.items.length === 0) {
    warnings.push("Planner has no items");
  } else {
    const limitError = checkLimit(component.items.length, DEFAULT_LIMITS.maxItems, "Items");
    if (limitError) errors.push(limitError);

    const seenIds = new Set<string>();
    for (const item of component.items) {
      if (!item.id || !item.name) {
        errors.push("Each item must have an id and name");
        break;
      }
      if (seenIds.has(item.id)) {
        errors.push(`Duplicate item id: ${item.id}`);
        break;
      }
      seenIds.add(item.id);

      if (typeof item.value !== "number") {
        warnings.push(`Item ${item.id} has non-numeric value`);
      }

      if (item.dependencies) {
        for (const dep of item.dependencies) {
          if (!seenIds.has(dep) && !component.items.some(i => i.id === dep)) {
            warnings.push(`Item ${item.id} depends on unknown item: ${dep}`);
          }
        }
      }
    }
  }

  if (component.mode === "budget") {
    if (component.totalBudget === undefined || component.totalBudget < 0) {
      warnings.push("Budget mode should have a totalBudget");
    }
    const total = component.items.reduce((sum, i) => sum + i.value, 0);
    if (component.totalBudget !== undefined && total > component.totalBudget) {
      warnings.push("Items total exceeds budget");
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a quiz component. */
export function validateQuiz(component: QuizComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Quiz must have a title");
  }

  if (!component.questions || component.questions.length === 0) {
    errors.push("Quiz must have at least one question");
  } else {
    const limitError = checkLimit(component.questions.length, DEFAULT_LIMITS.maxQuestions, "Questions");
    if (limitError) errors.push(limitError);

    const seenIds = new Set<string>();
    for (const q of component.questions) {
      if (!q.id || !q.question) {
        errors.push("Each question must have an id and question text");
        break;
      }
      if (seenIds.has(q.id)) {
        errors.push(`Duplicate question id: ${q.id}`);
        break;
      }
      seenIds.add(q.id);

      const validTypes = ["multiple_choice", "true_false", "short_answer", "flashcard"] as const;
      if (!validTypes.includes(q.type)) {
        errors.push(`Invalid question type: ${q.type}`);
      }

      if (q.type === "multiple_choice") {
        if (!q.options || q.options.length < 2) {
          errors.push("Multiple choice questions need at least 2 options");
        } else {
          const optIds = new Set<string>();
          for (const opt of q.options) {
            if (!opt.id || !opt.text) {
              errors.push("Each option must have id and text");
              break;
            }
            if (optIds.has(opt.id)) {
              errors.push(`Duplicate option id in question ${q.id}`);
              break;
            }
            optIds.add(opt.id);
          }
        }
      }

      if (!q.correctAnswer) {
        errors.push(`Question ${q.id} has no correct answer`);
      } else if (Array.isArray(q.correctAnswer)) {
        if (q.correctAnswer.length === 0) {
          warnings.push(`Question ${q.id} has empty correct answer array`);
        }
      } else if (typeof q.correctAnswer !== "string") {
        errors.push(`Question ${q.id} correct answer must be string or string[]`);
      }

      if (q.points !== undefined && (q.points < 0 || q.points > 100)) {
        warnings.push(`Question ${q.id} points out of reasonable range`);
      }
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a comparison component. */
export function validateComparison(component: ComparisonComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Comparison must have a title");
  }

  if (!component.items || component.items.length < 2) {
    errors.push("Comparison needs at least 2 items");
  } else {
    const limitError = checkLimit(component.items.length, DEFAULT_LIMITS.maxItems, "Items");
    if (limitError) errors.push(limitError);

    const seenIds = new Set<string>();
    for (const item of component.items) {
      if (!item.id || !item.name) {
        errors.push("Each item must have an id and name");
        break;
      }
      if (seenIds.has(item.id)) {
        errors.push(`Duplicate item id: ${item.id}`);
        break;
      }
      seenIds.add(item.id);
    }
  }

  if (!component.criteria || component.criteria.length === 0) {
    errors.push("Comparison must have at least one criterion");
  } else {
    const limitError = checkLimit(component.criteria.length, DEFAULT_LIMITS.maxCriteria, "Criteria");
    if (limitError) errors.push(limitError);

    const seenIds = new Set<string>();
    for (const crit of component.criteria) {
      if (!crit.id || !crit.label) {
        errors.push("Each criterion must have an id and label");
        break;
      }
      if (seenIds.has(crit.id)) {
        errors.push(`Duplicate criterion id: ${crit.id}`);
        break;
      }
      seenIds.add(crit.id);

      const validTypes = ["text", "number", "boolean", "rating", "yes_no"] as const;
      if (!validTypes.includes(crit.type)) {
        errors.push(`Invalid criterion type: ${crit.type}`);
      }
    }
  }

  // Check that all items have values for all criteria
  if (component.items && component.criteria) {
    const criterionIds = new Set(component.criteria.map(c => c.id));
    for (const item of component.items) {
      for (const critId of criterionIds) {
        if (!(critId in item.values)) {
          warnings.push(`Item ${item.id} missing value for criterion ${critId}`);
        }
      }
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a simulation component. */
export function validateSimulation(component: SimulationComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Simulation must have a title");
  }

  if (!component.simulationId) {
    errors.push("Simulation must have a simulationId");
  } else {
    const template = getSimulation(component.simulationId);
    if (!template) {
      errors.push(`Unknown simulation: ${component.simulationId}`);
    } else {
      // Validate parameters against template
      for (const param of template.parameters) {
        const value = component.parameters[param.id];
        if (value === undefined) {
          warnings.push(`Missing parameter: ${param.id} (using default: ${param.default})`);
        } else if (param.type === "number") {
          const num = Number(value);
          if (isNaN(num)) {
            errors.push(`Parameter ${param.id} must be a number`);
          } else if (param.min !== undefined && num < param.min) {
            errors.push(`${param.id} below minimum ${param.min}`);
          } else if (param.max !== undefined && num > param.max) {
            errors.push(`${param.id} above maximum ${param.max}`);
          }
        } else if (param.type === "select" && param.options) {
          const validValues = param.options.map(o => o.value);
          if (typeof value === "string" || typeof value === "number") {
            if (!validValues.includes(value)) {
              warnings.push(`Parameter ${param.id} has unexpected value: ${value}`);
            }
          }
        }
      }
    }
  }

  if (component.speed !== undefined && (component.speed < 0.1 || component.speed > 10)) {
    warnings.push("Speed should be between 0.1 and 10");
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Valid widget types for live widgets */
const VALID_WIDGET_TYPES: LiveWidgetType[] = [
  "weather", "currency", "stocks", "sports", "news", "crypto", "world_clock", "countdown"
];

/** Required config fields per widget type */
const REQUIRED_CONFIG: Record<LiveWidgetType, string[]> = {
  weather: ["location"],
  currency: ["fromCurrency", "toCurrency"],
  stocks: ["symbols"],
  sports: ["league"],
  news: ["category"],
  crypto: ["coins"],
  world_clock: ["timezones"],
  countdown: ["targetDate"],
};

/** Validate a live widget component. */
export function validateLiveWidget(component: LiveWidgetComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Live widget must have a title");
  }

  if (!component.widgetType) {
    errors.push("Live widget must have a widgetType");
  } else if (!VALID_WIDGET_TYPES.includes(component.widgetType)) {
    errors.push(`Invalid widget type: ${component.widgetType}`);
  }

  if (!component.config) {
    errors.push("Live widget must have a config");
  } else {
    const required = REQUIRED_CONFIG[component.widgetType] || [];
    for (const field of required) {
      const value = component.config[field as keyof LiveWidgetConfig];
      if (value === undefined || value === null || (Array.isArray(value) && value.length === 0) || (typeof value === "string" && value.trim() === "")) {
        errors.push(`Live widget ${component.widgetType} requires config field: ${field}`);
      }
    }

    // Validate refresh interval
    if (component.config.refreshInterval) {
      const validIntervals = ["manual", "30s", "1m", "5m", "15m"];
      if (!validIntervals.includes(component.config.refreshInterval)) {
        warnings.push(`Invalid refresh interval: ${component.config.refreshInterval}`);
      }
    }

    // Validate layout
    if (component.config.layout) {
      const validLayouts = ["compact", "detailed", "dashboard"];
      if (!validLayouts.includes(component.config.layout)) {
        warnings.push(`Invalid layout: ${component.config.layout}`);
      }
    }

    // Widget-specific validations
    if (component.widgetType === "weather" && component.config.units) {
      if (!["metric", "imperial"].includes(component.config.units)) {
        warnings.push("Weather units must be 'metric' or 'imperial'");
      }
    }

    if (component.widgetType === "world_clock" && component.config.format) {
      if (!["12h", "24h"].includes(component.config.format)) {
        warnings.push("World clock format must be '12h' or '24h'");
      }
    }

    if (component.widgetType === "countdown" && component.config.targetDate) {
      const target = new Date(component.config.targetDate).getTime();
      if (isNaN(target)) {
        errors.push("Countdown targetDate must be a valid ISO date string");
      }
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate an equation solver component. */
export function validateEquationSolver(component: EquationSolverComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Equation solver must have a title");
  }

  if (!component.expression || component.expression.trim().length === 0) {
    errors.push("Equation solver must have an expression");
  }

  if (component.method && !["newton", "bisection", "secant", "auto"].includes(component.method)) {
    errors.push(`Invalid method: ${component.method}`);
  }

  if (component.method === "bisection" && !component.interval) {
    errors.push("Bisection method requires an interval");
  }

  if (component.method === "newton" && component.initialGuess === undefined) {
    warnings.push("Newton method works best with an initialGuess");
  }

  if (component.interval) {
    const [min, max] = component.interval;
    if (min >= max) {
      errors.push("Interval min must be less than max");
    }
    if (!isFinite(min) || !isFinite(max)) {
      errors.push("Interval bounds must be finite");
    }
  }

  if (component.tolerance !== undefined && (component.tolerance <= 0 || component.tolerance > 1)) {
    warnings.push("Tolerance should be between 0 and 1");
  }

  if (component.maxIterations !== undefined && (component.maxIterations < 1 || component.maxIterations > 10000)) {
    warnings.push("Max iterations should be between 1 and 10000");
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a function plotter component. */
export function validateFunctionPlotter(component: FunctionPlotterComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Function plotter must have a title");
  }

  if (!component.expression || component.expression.trim().length === 0) {
    errors.push("Function plotter must have an expression");
  }

  if (!component.domain || component.domain.length !== 2) {
    errors.push("Function plotter must have a domain [min, max]");
  } else {
    const [min, max] = component.domain;
    if (min >= max) {
      errors.push("Domain min must be less than max");
    }
    if (!isFinite(min) || !isFinite(max)) {
      errors.push("Domain bounds must be finite");
    }
  }

  if (component.plotType && !["cartesian", "parametric", "polar"].includes(component.plotType)) {
    errors.push(`Invalid plot type: ${component.plotType}`);
  }

  if (component.plotType === "parametric" && !component.yExpression) {
    errors.push("Parametric plots require yExpression");
  }

  if (component.samples !== undefined && (component.samples < 10 || component.samples > 10000)) {
    warnings.push("Samples should be between 10 and 10000");
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a surface plotter component. */
export function validateSurfacePlotter(component: SurfacePlotterComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Surface plotter must have a title");
  }

  if (!component.expression || component.expression.trim().length === 0) {
    errors.push("Surface plotter must have an expression");
  }

  if (!component.xDomain || component.xDomain.length !== 2) {
    errors.push("Surface plotter must have an xDomain [min, max]");
  } else {
    const [min, max] = component.xDomain;
    if (min >= max) errors.push("xDomain min must be less than max");
  }

  if (!component.yDomain || component.yDomain.length !== 2) {
    errors.push("Surface plotter must have a yDomain [min, max]");
  } else {
    const [min, max] = component.yDomain;
    if (min >= max) errors.push("yDomain min must be less than max");
  }

  if (component.resolution !== undefined && (component.resolution < 5 || component.resolution > 200)) {
    warnings.push("Resolution should be between 5 and 200");
  }

  if (component.colorScheme && !["height", "slope", "curvature"].includes(component.colorScheme)) {
    warnings.push(`Unknown color scheme: ${component.colorScheme}`);
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a geometry component. */
export function validateGeometry(component: GeometryComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Geometry component must have a title");
  }

  if (!component.constructions || component.constructions.length === 0) {
    warnings.push("Geometry component has no constructions");
  } else {
    const validOps = ["point", "line", "segment", "circle", "circle_three_points", "polygon", "intersect_lines", "intersect_line_circle", "midpoint", "perp_bisector"] as const;
    const seenLabels = new Set<string>();

    for (const step of component.constructions) {
      if (!validOps.includes(step.op)) {
        errors.push(`Invalid construction operation: ${step.op}`);
      }

      if (step.label) {
        if (seenLabels.has(step.label)) {
          errors.push(`Duplicate label: ${step.label}`);
        }
        seenLabels.add(step.label);
      }

      // Validate required params per operation
      switch (step.op) {
        case "point":
          if (typeof step.params.x !== "number" || typeof step.params.y !== "number") {
            errors.push("Point requires numeric x and y params");
          }
          break;
        case "line":
        case "segment":
          if (!step.params.point1 || !step.params.point2) {
            errors.push(`${step.op} requires point1 and point2 params`);
          }
          break;
        case "circle":
          if (!step.params.center || typeof step.params.radius !== "number") {
            errors.push("Circle requires center and radius params");
          }
          break;
        case "circle_three_points":
          if (!step.params.point1 || !step.params.point2 || !step.params.point3) {
            errors.push("Circle through three points requires point1, point2, point3 params");
          }
          break;
        case "polygon":
          if (!Array.isArray(step.params.points) || step.params.points.length < 3) {
            errors.push("Polygon requires points array with at least 3 labels");
          }
          break;
        case "intersect_lines":
          if (!step.params.line1 || !step.params.line2) {
            errors.push("Line intersection requires line1 and line2 params");
          }
          break;
        case "intersect_line_circle":
          if (!step.params.line || !step.params.circle) {
            errors.push("Line-circle intersection requires line and circle params");
          }
          break;
        case "midpoint":
          if (!step.params.point1 || !step.params.point2) {
            errors.push("Midpoint requires point1 and point2 params");
          }
          break;
        case "perp_bisector":
          if (!step.params.point1 || !step.params.point2) {
            errors.push("Perpendicular bisector requires point1 and point2 params");
          }
          break;
      }
    }
  }

  if (component.measurements) {
    const validMeasurements = ["distance", "angle", "area", "perimeter", "midpoint", "intersection"] as const;
    for (const m of component.measurements) {
      if (!validMeasurements.includes(m.type)) {
        errors.push(`Invalid measurement type: ${m.type}`);
      }
      if (!m.objects || m.objects.length === 0) {
        errors.push("Measurement must specify objects");
      }
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a calculus visualization component. */
export function validateCalculusVisualization(component: CalculusVisualizationComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Calculus visualization must have a title");
  }

  if (!component.expression || component.expression.trim().length === 0) {
    errors.push("Calculus visualization must have an expression");
  }

  if (!["tangent", "area", "taylor", "limit"].includes(component.vizType)) {
    errors.push(`Invalid visualization type: ${component.vizType}`);
  }

  if (!component.domain || component.domain.length !== 2) {
    errors.push("Calculus visualization must have a domain [min, max]");
  } else {
    const [min, max] = component.domain;
    if (min >= max) errors.push("Domain min must be less than max");
  }

  switch (component.vizType) {
    case "tangent":
      if (component.point === undefined) {
        errors.push("Tangent visualization requires a point");
      } else if (component.point < component.domain[0] || component.point > component.domain[1]) {
        warnings.push("Tangent point is outside the domain");
      }
      break;
    case "area":
      if (!component.interval || component.interval.length !== 2) {
        errors.push("Area visualization requires an interval [a, b]");
      } else if (component.interval[0] >= component.interval[1]) {
        errors.push("Area interval start must be less than end");
      }
      if (component.areaMethod && !["left", "right", "midpoint", "trapezoid"].includes(component.areaMethod)) {
        warnings.push(`Unknown area method: ${component.areaMethod}`);
      }
      if (component.partitions !== undefined && (component.partitions < 1 || component.partitions > 1000)) {
        warnings.push("Partitions should be between 1 and 1000");
      }
      break;
    case "taylor":
      if (component.center === undefined) {
        errors.push("Taylor series requires a center point");
      }
      if (component.order === undefined || component.order < 0 || component.order > 20) {
        errors.push("Taylor series requires order between 0 and 20");
      }
      break;
    case "limit":
      if (component.target === undefined) {
        errors.push("Limit evaluation requires a target point");
      }
      if (component.limitDirection && !["left", "right", "both"].includes(component.limitDirection)) {
        warnings.push(`Unknown limit direction: ${component.limitDirection}`);
      }
      break;
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Validate a series visualization component. */
export function validateSeriesVisualization(component: SeriesVisualizationComponent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!component.title || component.title.trim().length === 0) {
    errors.push("Series visualization must have a title");
  }

  if (!component.termExpression || component.termExpression.trim().length === 0) {
    errors.push("Series visualization must have a term expression");
  }

  if (component.maxTerms !== undefined && (component.maxTerms < 1 || component.maxTerms > 500)) {
    warnings.push("Max terms should be between 1 and 500");
  }

  if (component.tolerance !== undefined && (component.tolerance <= 0 || component.tolerance > 1)) {
    warnings.push("Tolerance should be between 0 and 1");
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

/** Generic validator dispatcher. */
export function validateComponent(component: InteractiveComponent): ValidationResult {
  switch (component.type) {
    case "calculator":
    case "percentage_calculator":
    case "compound_interest_calculator":
    case "time_calculator":
    case "grade_calculator":
      return validateCalculator(component as CalculatorComponent);
    case "chart":
      return validateChart(component as ChartComponent);
    case "data_table":
      return validateDataTable(component as DataTableComponent);
    case "map":
      return validateMap(component as MapComponent);
    case "bill_splitter":
      return validateBillSplitter(component as BillSplitterComponent);
    case "unit_converter":
      return validateUnitConverter(component as UnitConverterComponent);
    case "planner":
      return validatePlanner(component as PlannerComponent);
    case "quiz":
      return validateQuiz(component as QuizComponent);
    case "comparison":
      return validateComparison(component as ComparisonComponent);
    case "simulation":
      return validateSimulation(component as SimulationComponent);
    case "live_widget":
      return validateLiveWidget(component as LiveWidgetComponent);
    case "equation_solver":
      return validateEquationSolver(component as EquationSolverComponent);
    case "function_plotter":
      return validateFunctionPlotter(component as FunctionPlotterComponent);
    case "surface_plotter":
      return validateSurfacePlotter(component as SurfacePlotterComponent);
    case "geometry":
      return validateGeometry(component as GeometryComponent);
    case "calculus_visualization":
      return validateCalculusVisualization(component as CalculusVisualizationComponent);
    case "series_visualization":
      return validateSeriesVisualization(component as SeriesVisualizationComponent);
    default:
      return fail([`Unknown component type: ${(component as InteractiveComponent).type}`]);
  }
}

/* ------------------------------------------------------------------------- */
/* Calculator Functions Registry                                              */
/* ------------------------------------------------------------------------- */

/** Calculator function signature. */
export type CalculatorFn = (inputs: Record<string, number>) => number | { hours: number; minutes: number };

/** Registry of calculator formulas. */
export const calculatorRegistry = new Map<string, CalculatorFn>();

/** Register a calculator function. */
export function registerCalculator(name: string, fn: CalculatorFn): void {
  calculatorRegistry.set(name, fn);
}

/** Get a calculator function. */
export function getCalculator(name: string): CalculatorFn | undefined {
  return calculatorRegistry.get(name);
}

/** Built-in calculator functions. */

// Basic arithmetic
registerCalculator("add", ({ a, b }) => a + b);
registerCalculator("subtract", ({ a, b }) => a - b);
registerCalculator("multiply", ({ a, b }) => a * b);
registerCalculator("divide", ({ a, b }) => b !== 0 ? a / b : NaN);

// Percentage calculators
registerCalculator("percentage_of", ({ value, percent }) => value * (percent / 100));
registerCalculator("percent_change", ({ old, new: newVal }) => old !== 0 ? ((newVal - old) / Math.abs(old)) * 100 : NaN);
registerCalculator("percent_of_total", ({ part, total }) => total !== 0 ? (part / total) * 100 : NaN);
registerCalculator("tip_calculator", ({ total, percent }) => total * (percent / 100));
registerCalculator("discount", ({ original, percent }) => original * (1 - percent / 100));

// Compound interest
registerCalculator("compound_interest", ({ principal, rate, time, frequency = 1 }) =>
  principal * Math.pow(1 + rate / (100 * frequency), frequency * time)
);
registerCalculator("future_value", ({ present, rate, periods }) =>
  present * Math.pow(1 + rate / 100, periods)
);
registerCalculator("present_value", ({ future, rate, periods }) =>
  future / Math.pow(1 + rate / 100, periods)
);
registerCalculator("loan_payment", ({ principal, rate, periods }) => {
  const r = rate / 100 / 12;
  return principal * r * Math.pow(1 + r, periods) / (Math.pow(1 + r, periods) - 1);
});

// Time calculators
registerCalculator("time_add", ({ hours, minutes, addHours, addMinutes }) => {
  const total = hours * 60 + minutes + (addHours || 0) * 60 + (addMinutes || 0);
  return Math.floor(total / 60) + (total % 60) / 100; // Returns H.MM format
});
registerCalculator("time_diff", ({ startHours, startMinutes, endHours, endMinutes }) => {
  const start = startHours * 60 + startMinutes;
  const end = endHours * 60 + endMinutes;
  const diff = end >= start ? end - start : end + 24 * 60 - start;
  return Math.floor(diff / 60) + (diff % 60) / 100;
});
registerCalculator("hours_to_decimal", ({ hours, minutes }) => hours + minutes / 60);
registerCalculator("decimal_to_hours", ({ decimal }) => ({
  hours: Math.floor(decimal),
  minutes: Math.round((decimal % 1) * 60),
}));

// Grade calculators
registerCalculator("weighted_grade", ({ assignments }) => {
  if (!Array.isArray(assignments) || assignments.length === 0) return 0;
  const totalWeight = assignments.reduce((sum, a) => sum + (a.weight || 0), 0);
  if (totalWeight === 0) return 0;
  return assignments.reduce((sum, a) => sum + (a.score || 0) * (a.weight || 0), 0) / totalWeight;
});
registerCalculator("final_grade_needed", ({ current, target, currentWeight, finalWeight }) => {
  if (finalWeight === 0) return NaN;
  return (target - current * (currentWeight / 100)) / (finalWeight / 100);
});
registerCalculator("gpa_calculator", ({ grades }) => {
  if (!Array.isArray(grades) || grades.length === 0) return 0;
  return grades.reduce((sum, g) => sum + (g.points || 0) * (g.credits || 0), 0) /
    grades.reduce((sum, g) => sum + (g.credits || 0), 0);
});

// Geometry
registerCalculator("circle_area", ({ radius }) => Math.PI * radius * radius);
registerCalculator("circle_circumference", ({ radius }) => 2 * Math.PI * radius);
registerCalculator("rectangle_area", ({ width, height }) => width * height);
registerCalculator("rectangle_perimeter", ({ width, height }) => 2 * (width + height));
registerCalculator("triangle_area", ({ base, height }) => 0.5 * base * height);
registerCalculator("cylinder_volume", ({ radius, height }) => Math.PI * radius * radius * height);
registerCalculator("sphere_volume", ({ radius }) => (4/3) * Math.PI * Math.pow(radius, 3));

/* ------------------------------------------------------------------------- */
/* Unit Conversion Data                                                       */
/* ------------------------------------------------------------------------- */

export interface UnitDefinition {
  value: string;
  label: string;
  symbol?: string;
  toBase: number; // Multiplier to convert to base unit
  fromBase: number; // Multiplier to convert from base unit
}

export const UNIT_DEFINITIONS: Record<string, UnitDefinition[]> = {
  length: [
    { value: "meter", label: "Meter", symbol: "m", toBase: 1, fromBase: 1 },
    { value: "kilometer", label: "Kilometer", symbol: "km", toBase: 1000, fromBase: 0.001 },
    { value: "centimeter", label: "Centimeter", symbol: "cm", toBase: 0.01, fromBase: 100 },
    { value: "millimeter", label: "Millimeter", symbol: "mm", toBase: 0.001, fromBase: 1000 },
    { value: "inch", label: "Inch", symbol: "in", toBase: 0.0254, fromBase: 39.3701 },
    { value: "foot", label: "Foot", symbol: "ft", toBase: 0.3048, fromBase: 3.28084 },
    { value: "yard", label: "Yard", symbol: "yd", toBase: 0.9144, fromBase: 1.09361 },
    { value: "mile", label: "Mile", symbol: "mi", toBase: 1609.34, fromBase: 0.000621371 },
  ],
  weight: [
    { value: "kilogram", label: "Kilogram", symbol: "kg", toBase: 1, fromBase: 1 },
    { value: "gram", label: "Gram", symbol: "g", toBase: 0.001, fromBase: 1000 },
    { value: "pound", label: "Pound", symbol: "lb", toBase: 0.453592, fromBase: 2.20462 },
    { value: "ounce", label: "Ounce", symbol: "oz", toBase: 0.0283495, fromBase: 35.274 },
    { value: "ton", label: "Metric Ton", symbol: "t", toBase: 1000, fromBase: 0.001 },
    { value: "stone", label: "Stone", symbol: "st", toBase: 6.35029, fromBase: 0.157473 },
  ],
  temperature: [
    { value: "celsius", label: "Celsius", symbol: "°C", toBase: 1, fromBase: 1 },
    { value: "fahrenheit", label: "Fahrenheit", symbol: "°F", toBase: 1, fromBase: 1 },
    { value: "kelvin", label: "Kelvin", symbol: "K", toBase: 1, fromBase: 1 },
  ],
  volume: [
    { value: "liter", label: "Liter", symbol: "L", toBase: 1, fromBase: 1 },
    { value: "milliliter", label: "Milliliter", symbol: "mL", toBase: 0.001, fromBase: 1000 },
    { value: "gallon", label: "US Gallon", symbol: "gal", toBase: 3.78541, fromBase: 0.264172 },
    { value: "quart", label: "US Quart", symbol: "qt", toBase: 0.946353, fromBase: 1.05669 },
    { value: "pint", label: "US Pint", symbol: "pt", toBase: 0.473176, fromBase: 2.11338 },
    { value: "cup", label: "US Cup", symbol: "cup", toBase: 0.236588, fromBase: 4.22675 },
    { value: "fluid_ounce", label: "Fluid Ounce", symbol: "fl oz", toBase: 0.0295735, fromBase: 33.814 },
  ],
  area: [
    { value: "square_meter", label: "Square Meter", symbol: "m²", toBase: 1, fromBase: 1 },
    { value: "square_kilometer", label: "Square Kilometer", symbol: "km²", toBase: 1e6, fromBase: 1e-6 },
    { value: "square_foot", label: "Square Foot", symbol: "ft²", toBase: 0.092903, fromBase: 10.7639 },
    { value: "square_yard", label: "Square Yard", symbol: "yd²", toBase: 0.836127, fromBase: 1.19599 },
    { value: "acre", label: "Acre", symbol: "ac", toBase: 4046.86, fromBase: 0.000247105 },
    { value: "hectare", label: "Hectare", symbol: "ha", toBase: 10000, fromBase: 0.0001 },
  ],
  speed: [
    { value: "mps", label: "Meters per Second", symbol: "m/s", toBase: 1, fromBase: 1 },
    { value: "kph", label: "Kilometers per Hour", symbol: "km/h", toBase: 0.277778, fromBase: 3.6 },
    { value: "mph", label: "Miles per Hour", symbol: "mph", toBase: 0.44704, fromBase: 2.23694 },
    { value: "knot", label: "Knot", symbol: "kn", toBase: 0.514444, fromBase: 1.94384 },
  ],
  time: [
    { value: "second", label: "Second", symbol: "s", toBase: 1, fromBase: 1 },
    { value: "minute", label: "Minute", symbol: "min", toBase: 60, fromBase: 1/60 },
    { value: "hour", label: "Hour", symbol: "h", toBase: 3600, fromBase: 1/3600 },
    { value: "day", label: "Day", symbol: "d", toBase: 86400, fromBase: 1/86400 },
    { value: "week", label: "Week", symbol: "wk", toBase: 604800, fromBase: 1/604800 },
    { value: "month", label: "Month (30 days)", symbol: "mo", toBase: 2592000, fromBase: 1/2592000 },
    { value: "year", label: "Year (365 days)", symbol: "yr", toBase: 31536000, fromBase: 1/31536000 },
  ],
  data: [
    { value: "bit", label: "Bit", symbol: "b", toBase: 1, fromBase: 1 },
    { value: "byte", label: "Byte", symbol: "B", toBase: 8, fromBase: 0.125 },
    { value: "kilobyte", label: "Kilobyte", symbol: "KB", toBase: 8192, fromBase: 1/8192 },
    { value: "megabyte", label: "Megabyte", symbol: "MB", toBase: 8388608, fromBase: 1/8388608 },
    { value: "gigabyte", label: "Gigabyte", symbol: "GB", toBase: 8589934592, fromBase: 1/8589934592 },
    { value: "terabyte", label: "Terabyte", symbol: "TB", toBase: 8796093022208, fromBase: 1/8796093022208 },
  ],
  pressure: [
    { value: "pascal", label: "Pascal", symbol: "Pa", toBase: 1, fromBase: 1 },
    { value: "kilopascal", label: "Kilopascal", symbol: "kPa", toBase: 1000, fromBase: 0.001 },
    { value: "bar", label: "Bar", symbol: "bar", toBase: 100000, fromBase: 1e-5 },
    { value: "psi", label: "PSI", symbol: "psi", toBase: 6894.76, fromBase: 0.000145038 },
    { value: "atm", label: "Atmosphere", symbol: "atm", toBase: 101325, fromBase: 9.86923e-6 },
  ],
};

/** Convert between units. */
export function convertUnit(
  value: number,
  fromUnit: string,
  toUnit: string,
  category: string
): number {
  const units = UNIT_DEFINITIONS[category];
  if (!units) throw new Error(`Unknown category: ${category}`);

  const fromDef = units.find(u => u.value === fromUnit);
  const toDef = units.find(u => u.value === toUnit);

  if (!fromDef || !toDef) throw new Error(`Unknown unit in category ${category}`);

  // Special handling for temperature
  if (category === "temperature") {
    return convertTemperature(value, fromUnit, toUnit);
  }

  // Convert to base, then to target
  const baseValue = value * fromDef.toBase;
  return baseValue * toDef.fromBase;
}

function convertTemperature(value: number, from: string, to: string): number {
  // Convert to Celsius first
  let celsius: number;
  switch (from) {
    case "celsius": celsius = value; break;
    case "fahrenheit": celsius = (value - 32) * 5/9; break;
    case "kelvin": celsius = value - 273.15; break;
    default: throw new Error(`Unknown temperature unit: ${from}`);
  }

  // Convert from Celsius to target
  switch (to) {
    case "celsius": return celsius;
    case "fahrenheit": return celsius * 9/5 + 32;
    case "kelvin": return celsius + 273.15;
    default: throw new Error(`Unknown temperature unit: ${to}`);
  }
}

/** Get available units for a category. */
export function getUnitsForCategory(category: string): UnitDefinition[] {
  return UNIT_DEFINITIONS[category] || [];
}

/* ------------------------------------------------------------------------- */
/* Registry Initialization                                                    */
/* ------------------------------------------------------------------------- */

import { interactiveComponentRegistry } from "./interactive-types";

/** Initialize the component registry with all validators. */
export function initializeComponentRegistry(): void {
  interactiveComponentRegistry.register({
    type: "calculator",
    name: "Calculator",
    description: "General purpose calculator with customizable fields",
    validate: validateCalculator,
    defaults: { precision: 2, showExplanation: true },
    limits: { maxFields: 20, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "percentage_calculator",
    name: "Percentage Calculator",
    description: "Calculate percentages, tips, discounts, and percent changes",
    validate: validateCalculator,
    defaults: { precision: 2, showExplanation: true, formula: "percentage_of" },
    limits: { maxFields: 10, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "compound_interest_calculator",
    name: "Compound Interest Calculator",
    description: "Calculate compound interest, future value, and loan payments",
    validate: validateCalculator,
    defaults: { precision: 2, showExplanation: true, formula: "compound_interest" },
    limits: { maxFields: 10, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "time_calculator",
    name: "Time Calculator",
    description: "Add/subtract time, convert between formats",
    validate: validateCalculator,
    defaults: { precision: 2, showExplanation: true, formula: "time_add" },
    limits: { maxFields: 10, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "grade_calculator",
    name: "Grade Calculator",
    description: "Calculate weighted grades, GPA, and final exam targets",
    validate: validateCalculator,
    defaults: { precision: 2, showExplanation: true, formula: "weighted_grade" },
    limits: { maxFields: 20, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "chart",
    name: "Chart",
    description: "Interactive data visualizations (bar, line, pie, scatter, area)",
    validate: validateChart,
    defaults: { chartType: "bar", options: { responsive: true, legend: true, grid: true } },
    limits: { maxDataPoints: 500, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "data_table",
    name: "Data Table",
    description: "Sortable, filterable, paginated data tables",
    validate: validateDataTable,
    defaults: { sortable: true, filterable: true, paginated: true, pageSize: 25 },
    limits: { maxRows: 1000, maxColumns: 50, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "map",
    name: "Interactive Map",
    description: "Geographic maps with markers and paths",
    validate: validateMap,
    defaults: { zoom: 10, tileProvider: "openstreetmap", showPopups: true, height: 400 },
    limits: { maxMarkers: 100, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "bill_splitter",
    name: "Bill Splitter",
    description: "Split bills with tips, tax, and custom allocations",
    validate: validateBillSplitter,
    defaults: { tipPercent: 15, taxPercent: 0, currency: "$" },
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "unit_converter",
    name: "Unit Converter",
    description: "Convert between units across multiple categories",
    validate: validateUnitConverter,
    defaults: {},
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "planner",
    name: "Planner",
    description: "Task timelines, schedules, budgets, and project planning",
    validate: validatePlanner,
    defaults: { mode: "tasks" },
    limits: { maxItems: 50, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "quiz",
    name: "Quiz / Flashcards",
    description: "Interactive quizzes and flashcard study modes",
    validate: validateQuiz,
    defaults: { mode: "practice", shuffle: false, showExplanations: true },
    limits: { maxQuestions: 30, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "comparison",
    name: "Comparison Table",
    description: "Side-by-side comparison of items across criteria",
    validate: validateComparison,
    defaults: { orientation: "horizontal" },
    limits: { maxItems: 10, maxCriteria: 15, maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "simulation",
    name: "Interactive Simulation",
    description: "Educational simulations for physics, math, CS, chemistry, and economics",
    validate: validateSimulation,
    defaults: { running: false, speed: 1, parameters: {} },
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "equation_solver",
    name: "Equation Solver",
    description: "Find roots of equations using Newton-Raphson, bisection, or secant methods",
    validate: validateEquationSolver,
    defaults: { method: "auto", tolerance: 1e-10, maxIterations: 100 },
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "function_plotter",
    name: "Function Plotter",
    description: "2D function plots (cartesian, parametric, polar)",
    validate: validateFunctionPlotter,
    defaults: { plotType: "cartesian", samples: 500, variable: "x" },
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "surface_plotter",
    name: "Surface Plotter",
    description: "3D surface plots z = f(x, y)",
    validate: validateSurfacePlotter,
    defaults: { resolution: 50, colorScheme: "height", wireframe: false },
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "geometry",
    name: "Geometry Construction",
    description: "Interactive geometric constructions and measurements",
    validate: validateGeometry,
    defaults: { showGrid: true, showAxes: true },
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "calculus_visualization",
    name: "Calculus Visualization",
    description: "Visualize tangent lines, areas under curves, Taylor series, and limits",
    validate: validateCalculusVisualization,
    defaults: { variable: "x", areaMethod: "midpoint", partitions: 20 },
    limits: { maxTextLength: 5000 },
  });

  interactiveComponentRegistry.register({
    type: "series_visualization",
    name: "Series Visualization",
    description: "Visualize infinite series convergence and partial sums",
    validate: validateSeriesVisualization,
    defaults: { maxTerms: 100, tolerance: 1e-10, variable: "n" },
    limits: { maxTextLength: 5000 },
  });
}

// Auto-initialize on module load
initializeComponentRegistry();