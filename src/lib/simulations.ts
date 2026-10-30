// ---------------------------------------------------------------------------
// Scientific & Educational Simulation Engine
// ---------------------------------------------------------------------------
//
// Reusable simulation templates for physics, mathematics, computer science,
// chemistry/biology, and business/economics. Each simulation is a validated
// template with safe parameter schemas — NOT arbitrary code execution.
//
// ---------------------------------------------------------------------------

export type SimulationCategory =
  | "physics"
  | "mathematics"
  | "computer_science"
  | "chemistry_biology"
  | "business_economics";

export interface SimulationParameter {
  id: string;
  label: string;
  type: "number" | "select" | "boolean" | "range";
  min?: number;
  max?: number;
  step?: number;
  default: number | string | boolean;
  options?: { value: string | number; label: string }[];
  unit?: string;
  description?: string;
}

export interface SimulationState {
  /** Current parameter values */
  parameters: Record<string, number | string | boolean>;
  /** Whether simulation is running */
  running: boolean;
  /** Current time step */
  timeStep: number;
  /** Animation speed multiplier */
  speed: number;
  /** Frame data for rendering */
  frameData: SimulationFrameData;
}

export interface SimulationFrameData {
  /** Points for plotting */
  points?: { x: number; y: number; label?: string; color?: string }[];
  /** Lines for plotting */
  lines?: { points: { x: number; y: number }[]; color?: string; label?: string }[];
  /** Shapes for canvas rendering */
  shapes?: SimulationShape[];
  /** Text annotations */
  annotations?: { x: number; y: number; text: string; color?: string }[];
  /** Metrics to display */
  metrics?: Record<string, string | number>;
  /** Custom data for specific simulations */
  custom?: Record<string, unknown>;
}

export interface SimulationShape {
  type: "circle" | "rectangle" | "line" | "polygon" | "path";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  radius?: number;
  points?: { x: number; y: number }[];
  color?: string;
  fill?: string;
  strokeWidth?: number;
}

export interface SimulationTemplate {
  id: string;
  name: string;
  category: SimulationCategory;
  description: string;
  parameters: SimulationParameter[];
  /** Initial state */
  initialState: Partial<SimulationState>;
  /** Step function - advances simulation by one time step */
  step: (state: SimulationState, dt: number) => SimulationState;
  /** Reset to initial state */
  reset: (state: SimulationState) => SimulationState;
  /** Render hints for the UI */
  renderHints: {
    /** Canvas dimensions */
    width: number;
    height: number;
    /** Coordinate system bounds */
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
    /** Whether to show grid */
    showGrid?: boolean;
    /** Whether to show axes */
    showAxes?: boolean;
  };
  /** Educational metadata */
  educational?: {
    concepts: string[];
    learningObjectives: string[];
    suggestedExperiments: string[];
  };
}

/** Registry of all available simulations */
export const simulationRegistry = new Map<string, SimulationTemplate>();

/** Register a simulation template */
export function registerSimulation(template: SimulationTemplate): void {
  simulationRegistry.set(template.id, template);
}

/** Get a simulation template */
export function getSimulation(id: string): SimulationTemplate | undefined {
  return simulationRegistry.get(id);
}

/** List all simulations, optionally filtered by category */
export function listSimulations(category?: SimulationCategory): SimulationTemplate[] {
  const all = Array.from(simulationRegistry.values());
  if (category) return all.filter(s => s.category === category);
  return all;
}

/** Create initial state for a simulation */
export function createSimulationState(template: SimulationTemplate): SimulationState {
  const params: Record<string, number | string | boolean> = {};
  for (const p of template.parameters) {
    params[p.id] = p.default;
  }
  return {
    parameters: params,
    running: false,
    timeStep: 0,
    speed: 1,
    frameData: {},
    ...template.initialState,
  };
}

/* ============================================================================
 * PHYSICS SIMULATIONS
 * ============================================================================ */

// Projectile Motion
registerSimulation({
  id: "projectile-motion",
  name: "Projectile Motion",
  category: "physics",
  description: "Interactive projectile motion with gravity, air resistance, and launch parameters",
  parameters: [
    { id: "initialVelocity", label: "Initial Velocity", type: "number", min: 1, max: 100, step: 1, default: 30, unit: "m/s" },
    { id: "launchAngle", label: "Launch Angle", type: "number", min: 0, max: 90, step: 1, default: 45, unit: "°" },
    { id: "gravity", label: "Gravity", type: "number", min: 1, max: 30, step: 0.1, default: 9.81, unit: "m/s²" },
    { id: "airResistance", label: "Air Resistance", type: "number", min: 0, max: 2, step: 0.01, default: 0, unit: "kg/s" },
    { id: "mass", label: "Mass", type: "number", min: 0.1, max: 10, step: 0.1, default: 1, unit: "kg" },
    { id: "initialHeight", label: "Initial Height", type: "number", min: 0, max: 100, step: 1, default: 0, unit: "m" },
  ],
  initialState: { speed: 1 },
  renderHints: { width: 800, height: 400, bounds: { xMin: 0, xMax: 100, yMin: 0, yMax: 50 }, showGrid: true, showAxes: true },
  educational: {
    concepts: ["Kinematics", "Projectile Motion", "Gravity", "Air Resistance"],
    learningObjectives: ["Understand parabolic trajectory", "See effect of launch angle on range", "Observe air resistance effects"],
    suggestedExperiments: ["Find angle for maximum range", "Compare with/without air resistance", "Vary gravity for different planets"],
  },
  step: (state, dt) => {
    const p = state.parameters;
    const v0 = p.initialVelocity as number;
    const angle = (p.launchAngle as number) * Math.PI / 180;
    const g = p.gravity as number;
    const k = p.airResistance as number;
    const m = p.mass as number;
    const h0 = p.initialHeight as number;

    const newTime = state.timeStep + dt * (state.speed as number);

    // Analytical solution without air resistance, numerical with
    let x, y, vx, vy;
    if (k === 0) {
      x = v0 * Math.cos(angle) * newTime;
      y = h0 + v0 * Math.sin(angle) * newTime - 0.5 * g * newTime * newTime;
      vx = v0 * Math.cos(angle);
      vy = v0 * Math.sin(angle) - g * newTime;
    } else {
      // Numerical integration with air resistance
      const steps = Math.ceil(newTime / 0.01);
      const dtStep = newTime / steps;
      x = 0; y = h0;
      vx = v0 * Math.cos(angle);
      vy = v0 * Math.sin(angle);
      for (let i = 0; i < steps; i++) {
        const v = Math.sqrt(vx * vx + vy * vy);
        const ax = -k / m * v * vx;
        const ay = -g - k / m * v * vy;
        vx += ax * dtStep;
        vy += ay * dtStep;
        x += vx * dtStep;
        y += vy * dtStep;
        if (y <= 0) break;
      }
    }

    const maxHeight = h0 + (v0 * Math.sin(angle)) ** 2 / (2 * g);
    const range = k === 0 ? v0 * Math.cos(angle) * (2 * v0 * Math.sin(angle) / g) : x;

    const trajectory = [];
    const numPoints = 50;
    for (let i = 0; i <= numPoints; i++) {
      const t = newTime * i / numPoints;
      if (k === 0) {
        const tx = v0 * Math.cos(angle) * t;
        const ty = h0 + v0 * Math.sin(angle) * t - 0.5 * g * t * t;
        if (ty >= 0) trajectory.push({ x: tx, y: ty });
      }
    }

    return {
      ...state,
      timeStep: newTime,
      frameData: {
        points: y > 0 ? [{ x, y, label: "Projectile", color: "#ef4444" }] : [],
        lines: [{ points: trajectory, color: "#3b82f6", label: "Trajectory" }],
        metrics: {
          "Time": `${newTime.toFixed(2)} s`,
          "Position": `(${x.toFixed(1)}, ${y.toFixed(1)}) m`,
          "Velocity": `${Math.sqrt(vx * vx + vy * vy).toFixed(1)} m/s`,
          "Max Height": `${maxHeight.toFixed(1)} m`,
          "Range": `${range.toFixed(1)} m`,
        },
      },
    };
  },
  reset: (state) => ({
    ...state,
    running: false,
    timeStep: 0,
    frameData: {},
  }),
});

// Pendulum
registerSimulation({
  id: "pendulum",
  name: "Simple Pendulum",
  category: "physics",
  description: "Oscillating pendulum with adjustable length, mass, and damping",
  parameters: [
    { id: "length", label: "Length", type: "number", min: 0.1, max: 5, step: 0.1, default: 1, unit: "m" },
    { id: "mass", label: "Mass", type: "number", min: 0.1, max: 5, step: 0.1, default: 1, unit: "kg" },
    { id: "gravity", label: "Gravity", type: "number", min: 1, max: 30, step: 0.1, default: 9.81, unit: "m/s²" },
    { id: "damping", label: "Damping", type: "number", min: 0, max: 1, step: 0.01, default: 0.05 },
    { id: "initialAngle", label: "Initial Angle", type: "number", min: -170, max: 170, step: 5, default: 30, unit: "°" },
  ],
  initialState: { speed: 1 },
  renderHints: { width: 400, height: 400, bounds: { xMin: -1.5, xMax: 1.5, yMin: -1.5, yMax: 1.5 }, showGrid: false, showAxes: false },
  educational: {
    concepts: ["Simple Harmonic Motion", "Energy Conservation", "Damping"],
    learningObjectives: ["Observe period vs length relationship", "See energy transformation", "Understand small angle approximation"],
    suggestedExperiments: ["Measure period for different lengths", "Compare with theoretical T=2π√(L/g)", "Observe damping effects"],
  },
  step: (state, dt) => {
    const p = state.parameters;
    const L = p.length as number;
    const g = p.gravity as number;
    const damping = p.damping as number;
    const angle0 = (p.initialAngle as number) * Math.PI / 180;

    const omega0 = Math.sqrt(g / L);
    const newTime = state.timeStep + dt * (state.speed as number);

    // Damped harmonic motion
    const angle = angle0 * Math.exp(-damping * newTime) * Math.cos(omega0 * newTime);
    const angularVelocity = -angle0 * Math.exp(-damping * newTime) *
      (damping * Math.cos(omega0 * newTime) + omega0 * Math.sin(omega0 * newTime));

    const x = L * Math.sin(angle);
    const y = -L * Math.cos(angle);

    const period = 2 * Math.PI / omega0;
    const energy = 0.5 * (p.mass as number) * L * L * angularVelocity * angularVelocity +
      (p.mass as number) * g * L * (1 - Math.cos(angle));

    return {
      ...state,
      timeStep: newTime,
      frameData: {
        shapes: [
          { type: "line", points: [{ x: 0, y: 0 }, { x, y }], color: "#64748b", strokeWidth: 3 },
          { type: "circle", x, y, radius: 0.15 * (p.mass as number), color: "#ef4444", fill: "#ef4444" },
          { type: "circle", x: 0, y: 0, radius: 0.05, color: "#333" },
        ],
        annotations: [
          { x: 0, y: 1.2, text: `θ = ${(angle * 180 / Math.PI).toFixed(1)}°`, color: "#64748b" },
        ],
        metrics: {
          "Angle": `${(angle * 180 / Math.PI).toFixed(1)}°`,
          "Angular Velocity": `${(angularVelocity * 180 / Math.PI).toFixed(1)}°/s`,
          "Period": `${period.toFixed(2)} s`,
          "Energy": `${energy.toFixed(3)} J`,
        },
      },
    };
  },
  reset: (state) => ({ ...state, running: false, timeStep: 0, frameData: {} }),
});

// Wave Propagation
registerSimulation({
  id: "wave-propagation",
  name: "Wave Propagation",
  category: "physics",
  description: "Transverse wave on a string with adjustable frequency, amplitude, and damping",
  parameters: [
    { id: "frequency", label: "Frequency", type: "number", min: 0.1, max: 10, step: 0.1, default: 2, unit: "Hz" },
    { id: "amplitude", label: "Amplitude", type: "number", min: 0.1, max: 2, step: 0.1, default: 1, unit: "m" },
    { id: "wavelength", label: "Wavelength", type: "number", min: 0.5, max: 10, step: 0.1, default: 3, unit: "m" },
    { id: "damping", label: "Damping", type: "number", min: 0, max: 2, step: 0.05, default: 0.1 },
    { id: "waveSpeed", label: "Wave Speed", type: "number", min: 1, max: 20, step: 0.5, default: 5, unit: "m/s" },
  ],
  initialState: { speed: 1 },
  renderHints: { width: 800, height: 300, bounds: { xMin: 0, xMax: 20, yMin: -3, yMax: 3 }, showGrid: true, showAxes: true },
  educational: {
    concepts: ["Wave Equation", "Superposition", "Standing Waves", "Damping"],
    learningObjectives: ["Visualize traveling waves", "Understand wavelength/frequency/speed relationship", "See damping effects"],
    suggestedExperiments: ["Verify v = fλ", "Create standing waves with reflection", "Observe energy decay"],
  },
  step: (state, dt) => {
    const p = state.parameters;
    const f = p.frequency as number;
    const A = p.amplitude as number;
    const lambda = p.wavelength as number;
    const damping = p.damping as number;
    const v = p.waveSpeed as number;

    const newTime = state.timeStep + dt * (state.speed as number);
    const k = 2 * Math.PI / lambda;
    const omega = 2 * Math.PI * f;

    const points = [];
    const numPoints = 200;
    for (let i = 0; i <= numPoints; i++) {
      const x = 20 * i / numPoints;
      const envelope = Math.exp(-damping * x);
      const y = A * envelope * Math.sin(k * x - omega * newTime);
      points.push({ x, y });
    }

    return {
      ...state,
      timeStep: newTime,
      frameData: {
        lines: [{ points, color: "#3b82f6", label: "Wave" }],
        metrics: {
          "Frequency": `${f} Hz`,
          "Wavelength": `${lambda} m`,
          "Wave Speed": `${v} m/s`,
          "Period": `${(1/f).toFixed(2)} s`,
          "Wave Number": `${k.toFixed(2)} rad/m`,
        },
      },
    };
  },
  reset: (state) => ({ ...state, running: false, timeStep: 0, frameData: {} }),
});

/* ============================================================================
 * MATHEMATICS SIMULATIONS
 * ============================================================================ */

// Function Grapher
registerSimulation({
  id: "function-grapher",
  name: "Function Grapher",
  category: "mathematics",
  description: "Plot and explore mathematical functions with interactive parameters",
  parameters: [
    { id: "function", label: "Function", type: "select", default: "sin", options: [
      { value: "sin", label: "sin(x)" },
      { value: "cos", label: "cos(x)" },
      { value: "tan", label: "tan(x)" },
      { value: "exp", label: "eˣ" },
      { value: "log", label: "ln(x)" },
      { value: "poly", label: "ax²+bx+c" },
      { value: "rational", label: "1/x" },
      { value: "custom", label: "Custom..." },
    ]},
    { id: "paramA", label: "Parameter a", type: "number", min: -10, max: 10, step: 0.1, default: 1 },
    { id: "paramB", label: "Parameter b", type: "number", min: -10, max: 10, step: 0.1, default: 0 },
    { id: "paramC", label: "Parameter c", type: "number", min: -10, max: 10, step: 0.1, default: 0 },
    { id: "xMin", label: "X Min", type: "number", min: -20, max: 0, step: 1, default: -10 },
    { id: "xMax", label: "X Max", type: "number", min: 0, max: 20, step: 1, default: 10 },
  ],
  initialState: {},
  renderHints: { width: 800, height: 400, bounds: { xMin: -10, xMax: 10, yMin: -5, yMax: 5 }, showGrid: true, showAxes: true },
  educational: {
    concepts: ["Functions", "Transformations", "Derivatives", "Integrals"],
    learningObjectives: ["Visualize function behavior", "Understand parameter effects", "Explore function families"],
    suggestedExperiments: ["Find roots and extrema", "Compare function families", "Investigate asymptotes"],
  },
  step: (state) => {
    const p = state.parameters;
    const func = p.function as string;
    const a = p.paramA as number;
    const b = p.paramB as number;
    const c = p.paramC as number;
    const xMin = p.xMin as number;
    const xMax = p.xMax as number;

    const points = [];
    const numPoints = 400;
    for (let i = 0; i <= numPoints; i++) {
      const x = xMin + (xMax - xMin) * i / numPoints;
      let y: number;
      switch (func) {
        case "sin": y = a * Math.sin(b * x + c); break;
        case "cos": y = a * Math.cos(b * x + c); break;
        case "tan": y = a * Math.tan(b * x + c); break;
        case "exp": y = a * Math.exp(b * x) + c; break;
        case "log": y = a * Math.log(Math.abs(b * x + c) + 1e-10); break;
        case "poly": y = a * x * x + b * x + c; break;
        case "rational": y = a / (x - b + 1e-10) + c; break;
        default: y = a * Math.sin(b * x + c);
      }
      if (isFinite(y) && Math.abs(y) < 100) points.push({ x, y });
    }

    // Find roots (sign changes)
    const roots = [];
    for (let i = 1; i < points.length; i++) {
      if (points[i-1].y * points[i].y < 0) {
        const xRoot = points[i-1].x - points[i-1].y * (points[i].x - points[i-1].x) / (points[i].y - points[i-1].y);
        roots.push(xRoot);
      }
    }

    return {
      ...state,
      frameData: {
        lines: [{ points, color: "#3b82f6", label: `f(x) = ${func}` }],
        annotations: roots.slice(0, 5).map(r => ({ x: r, y: 0, text: `x≈${r.toFixed(2)}`, color: "#22c55e" })),
        metrics: {
          "Function": func,
          "Domain": `[${xMin}, ${xMax}]`,
          "Roots Found": roots.length,
          "Roots": roots.slice(0, 5).map(r => r.toFixed(2)).join(", "),
        },
      },
    };
  },
  reset: (state) => ({ ...state, frameData: {} }),
});

// Statistical Distribution Explorer
registerSimulation({
  id: "distribution-explorer",
  name: "Statistical Distributions",
  category: "mathematics",
  description: "Explore probability distributions with interactive parameters",
  parameters: [
    { id: "distribution", label: "Distribution", type: "select", default: "normal", options: [
      { value: "normal", label: "Normal (Gaussian)" },
      { value: "uniform", label: "Uniform" },
      { value: "exponential", label: "Exponential" },
      { value: "binomial", label: "Binomial" },
      { value: "poisson", label: "Poisson" },
      { value: "chi2", label: "Chi-Squared" },
      { value: "t", label: "Student's t" },
      { value: "f", label: "F-Distribution" },
    ]},
    { id: "param1", label: "Mean / n / df1", type: "number", min: -10, max: 50, step: 0.1, default: 0 },
    { id: "param2", label: "Std Dev / p / df2", type: "number", min: 0.1, max: 50, step: 0.1, default: 1 },
    { id: "param3", label: "Additional Parameter", type: "number", min: 0.1, max: 50, step: 0.1, default: 1 },
    { id: "showCDF", label: "Show CDF", type: "boolean", default: false },
  ],
  initialState: {},
  renderHints: { width: 800, height: 400, bounds: { xMin: -5, xMax: 5, yMin: 0, yMax: 1 }, showGrid: true, showAxes: true },
  educational: {
    concepts: ["Probability Distributions", "Central Limit Theorem", "Parameter Estimation"],
    learningObjectives: ["Visualize distribution shapes", "Understand parameter effects", "Compare PDF vs CDF"],
    suggestedExperiments: ["Vary parameters and observe changes", "Compare normal vs t-distribution", "Explore CLT with sample means"],
  },
  step: (state) => {
    const p = state.parameters;
    const dist = p.distribution as string;
    const p1 = p.param1 as number;
    const p2 = p.param2 as number;
    const p3 = p.param3 as number;

    const points = [];
    const cdfPoints = [];
    const numPoints = 400;

    let xMin = -5, xMax = 5, yMax = 1;

    // Adjust bounds based on distribution
    if (dist === "normal") { xMin = p1 - 4 * p2; xMax = p1 + 4 * p2; yMax = 0.4 / p2; }
    else if (dist === "uniform") { xMin = p1; xMax = p2; yMax = 1 / (p2 - p1) * 1.2; }
    else if (dist === "exponential") { xMin = 0; xMax = 5 / p1; yMax = p1 * 1.2; }
    else if (dist === "poisson" || dist === "binomial") { xMin = -0.5; xMax = dist === "poisson" ? p1 * 3 : p1; yMax = 0.5; }

    for (let i = 0; i <= numPoints; i++) {
      const x = xMin + (xMax - xMin) * i / numPoints;
      let pdf = 0, cdf = 0;

      if (dist === "normal") {
        pdf = Math.exp(-0.5 * Math.pow((x - p1) / p2, 2)) / (p2 * Math.sqrt(2 * Math.PI));
        cdf = 0.5 * (1 + erf((x - p1) / (p2 * Math.sqrt(2))));
      } else if (dist === "uniform") {
        pdf = x >= p1 && x <= p2 ? 1 / (p2 - p1) : 0;
        cdf = x < p1 ? 0 : x > p2 ? 1 : (x - p1) / (p2 - p1);
      } else if (dist === "exponential") {
        pdf = x >= 0 ? p1 * Math.exp(-p1 * x) : 0;
        cdf = x >= 0 ? 1 - Math.exp(-p1 * x) : 0;
      } else if (dist === "poisson") {
        // Continuous approximation for visualization
        const k = Math.round(x);
        if (k >= 0) {
          pdf = Math.exp(-p1) * Math.pow(p1, k) / factorial(k);
          cdf = poissonCDF(k, p1);
        }
      } else if (dist === "binomial") {
        const n = Math.round(p1);
        const k = Math.round(x);
        if (k >= 0 && k <= n) {
          pdf = combination(n, k) * Math.pow(p2, k) * Math.pow(1 - p2, n - k);
          cdf = binomialCDF(k, n, p2);
        }
      }

      points.push({ x, y: pdf });
      if (p.showCDF) cdfPoints.push({ x, y: cdf });
    }

    return {
      ...state,
      frameData: {
        lines: [
          { points, color: "#3b82f6", label: "PDF" },
          ...(p.showCDF ? [{ points: cdfPoints, color: "#22c55e", label: "CDF" }] : []),
        ],
        metrics: getDistributionMetrics(dist, p1, p2, p3),
      },
    };
  },
  reset: (state) => ({ ...state, frameData: {} }),
});

function erf(x: number): number {
  // Abramowitz and Stegun approximation
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return sign * y;
}

function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function poissonCDF(k: number, lambda: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(-lambda) * Math.pow(lambda, i) / factorial(i);
  }
  return sum;
}

function combination(n: number, k: number): number {
  if (k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = result * (n - i + 1) / i;
  }
  return result;
}

function binomialCDF(k: number, n: number, p: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += combination(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return sum;
}

function getDistributionMetrics(dist: string, p1: number, p2: number, p3: number): Record<string, string | number> {
  switch (dist) {
    case "normal": return { Mean: p1, StdDev: p2, Variance: p2 * p2, Skewness: 0, Kurtosis: 3 };
    case "uniform": return { Min: p1, Max: p2, Mean: (p1 + p2) / 2, Variance: Math.pow(p2 - p1, 2) / 12 };
    case "exponential": return { Rate: p1, Mean: 1 / p1, Variance: 1 / (p1 * p1) };
    case "poisson": return { Lambda: p1, Mean: p1, Variance: p1 };
    case "binomial": return { n: p1, p: p2, Mean: p1 * p2, Variance: p1 * p2 * (1 - p2) };
    default: return {};
  }
}

/* ============================================================================
 * COMPUTER SCIENCE SIMULATIONS
 * ============================================================================ */

// Sorting Algorithm Visualization
registerSimulation({
  id: "sorting-visualization",
  name: "Sorting Algorithm Visualizer",
  category: "computer_science",
  description: "Step-by-step visualization of sorting algorithms with comparisons",
  parameters: [
    { id: "algorithm", label: "Algorithm", type: "select", default: "bubble", options: [
      { value: "bubble", label: "Bubble Sort" },
      { value: "selection", label: "Selection Sort" },
      { value: "insertion", label: "Insertion Sort" },
      { value: "merge", label: "Merge Sort" },
      { value: "quick", label: "Quick Sort" },
      { value: "heap", label: "Heap Sort" },
    ]},
    { id: "arraySize", label: "Array Size", type: "number", min: 5, max: 50, step: 1, default: 20 },
    { id: "arrayType", label: "Initial Array", type: "select", default: "random", options: [
      { value: "random", label: "Random" },
      { value: "sorted", label: "Already Sorted" },
      { value: "reversed", label: "Reversed" },
      { value: "nearly", label: "Nearly Sorted" },
    ]},
  ],
  initialState: { running: false, speed: 1, timeStep: 0, frameData: { custom: { array: [], highlights: [], comparisons: 0, swaps: 0, sorted: false } } },
  renderHints: { width: 800, height: 300, bounds: { xMin: 0, xMax: 50, yMin: 0, yMax: 100 }, showGrid: false, showAxes: false },
  educational: {
    concepts: ["Algorithms", "Time Complexity", "Comparison Sorts", "Divide and Conquer"],
    learningObjectives: ["Visualize algorithm steps", "Compare time complexities", "Understand best/worst cases"],
    suggestedExperiments: ["Run on different input types", "Count comparisons/swaps", "Observe stability"],
  },
  step: (state, dt) => {
    const custom = state.frameData.custom as any;
    if (!custom || custom.sorted) return state;

    // Initialize if needed
    if (!custom.array || custom.array.length === 0) {
      const size = state.parameters.arraySize as number;
      const type = state.parameters.arrayType as string;
      let arr = Array.from({ length: size }, (_, i) => i + 1);
      if (type === "random") arr = shuffle([...arr]);
      else if (type === "reversed") arr = arr.reverse();
      else if (type === "nearly") { arr = [...arr]; for (let i = 0; i < size / 5; i++) swap(arr, Math.floor(Math.random() * size), Math.floor(Math.random() * size)); }

      custom.array = arr;
      custom.highlights = [];
      custom.comparisons = 0;
      custom.swaps = 0;
      custom.sorted = false;
      custom.stepIndex = 0;
      custom.steps = generateSortingSteps(arr, state.parameters.algorithm as string);
    }

    if (custom.stepIndex < custom.steps.length) {
      const step = custom.steps[custom.stepIndex];
      custom.array = step.array;
      custom.highlights = step.highlights || [];
      custom.comparisons = step.comparisons;
      custom.swaps = step.swaps;
      if (step.done) custom.sorted = true;
      custom.stepIndex++;
    }

    return {
      ...state,
      frameData: {
        ...state.frameData,
        custom: custom,
        shapes: custom.array.map((val: number, i: number) => ({
          type: "rectangle" as const,
          x: i * 1.05 + 0.5,
          y: 100 - val * (90 / (state.parameters.arraySize as number)),
          width: 0.8,
          height: val * (90 / (state.parameters.arraySize as number)),
          color: custom.highlights.includes(i) ? "#ef4444" : "#3b82f6",
          fill: custom.highlights.includes(i) ? "#ef4444" : "#3b82f6",
        })),
        metrics: {
          Algorithm: (state.parameters.algorithm as string).charAt(0).toUpperCase() + (state.parameters.algorithm as string).slice(1),
          Comparisons: custom.comparisons,
          Swaps: custom.swaps,
          Status: custom.sorted ? "Sorted!" : `Step ${custom.stepIndex}/${custom.steps.length}`,
        },
      },
    };
  },
  reset: (state) => ({ ...state, running: false, timeStep: 0, frameData: { custom: { array: [], sorted: false } } }),
});

function shuffle(arr: number[]): number[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function swap(arr: number[], i: number, j: number): void {
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function generateSortingSteps(arr: number[], algorithm: string): any[] {
  const steps: any[] = [];
  const a = [...arr];
  const n = a.length;

  const recordStep = (highlights: number[] = [], comparisons = 0, swaps = 0, done = false) => {
    steps.push({ array: [...a], highlights, comparisons, swaps, done });
  };

  let comp = 0, swp = 0;

  if (algorithm === "bubble") {
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < n - i - 1; j++) {
        comp++;
        if (a[j] > a[j + 1]) { swap(a, j, j + 1); swp++; }
        recordStep([j, j + 1], comp, swp);
      }
    }
  } else if (algorithm === "selection") {
    for (let i = 0; i < n - 1; i++) {
      let minIdx = i;
      for (let j = i + 1; j < n; j++) {
        comp++;
        if (a[j] < a[minIdx]) minIdx = j;
        recordStep([i, j, minIdx], comp, swp);
      }
      if (minIdx !== i) { swap(a, i, minIdx); swp++; recordStep([i, minIdx], comp, swp); }
    }
  } else if (algorithm === "insertion") {
    for (let i = 1; i < n; i++) {
      let key = a[i], j = i - 1;
      recordStep([i], comp, swp);
      while (j >= 0 && a[j] > key) { comp++; a[j + 1] = a[j]; j--; swp++; recordStep([j + 1, j + 2], comp, swp); }
      comp++; a[j + 1] = key; recordStep([j + 1], comp, swp);
    }
  } else if (algorithm === "merge") {
    const temp = new Array(n);
    function mergeSort(l: number, r: number) {
      if (l >= r) return;
      const m = Math.floor((l + r) / 2);
      mergeSort(l, m);
      mergeSort(m + 1, r);
      let i = l, j = m + 1, k = l;
      while (i <= m && j <= r) { comp++; if (a[i] <= a[j]) temp[k++] = a[i++]; else { temp[k++] = a[j++]; swp++; } recordStep([i - 1, j - 1], comp, swp); }
      while (i <= m) { temp[k++] = a[i++]; swp++; recordStep([i - 1], comp, swp); }
      while (j <= r) { temp[k++] = a[j++]; swp++; recordStep([j - 1], comp, swp); }
      for (let x = l; x <= r; x++) { a[x] = temp[x]; }
    }
    mergeSort(0, n - 1);
  } else if (algorithm === "quick") {
    function quickSort(l: number, r: number) {
      if (l >= r) return;
      const pivot = a[r];
      let i = l - 1;
      for (let j = l; j < r; j++) { comp++; if (a[j] <= pivot) { i++; swap(a, i, j); swp++; recordStep([i, j], comp, swp); } }
      swap(a, i + 1, r); swp++; recordStep([i + 1, r], comp, swp);
      quickSort(l, i);
      quickSort(i + 2, r);
    }
    quickSort(0, n - 1);
  }

  recordStep([], comp, swp, true);
  return steps;
}

/* ============================================================================
 * CHEMISTRY/BIOLOGY SIMULATIONS
 * ============================================================================ */

// Periodic Table Explorer
registerSimulation({
  id: "periodic-table",
  name: "Periodic Table Explorer",
  category: "chemistry_biology",
  description: "Interactive periodic table with element properties and trends",
  parameters: [
    { id: "viewMode", label: "View Mode", type: "select", default: "standard", options: [
      { value: "standard", label: "Standard" },
      { value: "electronegativity", label: "Electronegativity" },
      { value: "atomicRadius", label: "Atomic Radius" },
      { value: "ionizationEnergy", label: "Ionization Energy" },
      { value: "electronAffinity", label: "Electron Affinity" },
      { value: "meltingPoint", label: "Melting Point" },
      { value: "boilingPoint", label: "Boiling Point" },
      { value: "density", label: "Density" },
    ]},
    { id: "selectedElement", label: "Selected Element", type: "number", min: 1, max: 118, step: 1, default: 1 },
  ],
  initialState: {},
  renderHints: { width: 900, height: 500, bounds: { xMin: 0, xMax: 18, yMin: 0, yMax: 10 }, showGrid: false, showAxes: false },
  educational: {
    concepts: ["Periodic Trends", "Electron Configuration", "Chemical Properties", "Element Classification"],
    learningObjectives: ["Identify periodic trends", "Understand element classification", "Explore property relationships"],
    suggestedExperiments: ["Compare electronegativity across periods", "Observe atomic radius trends", "Find patterns in reactivity"],
  },
  step: (state) => {
    const elements = getPeriodicTableData();
    const selected = state.parameters.selectedElement as number;
    const viewMode = state.parameters.viewMode as string;
    const element = elements.find(e => e.atomicNumber === selected) || elements[0];

    const colorScale = getColorScale(viewMode, elements);

    return {
      ...state,
      frameData: {
        shapes: elements.map(el => {
          const value = getPropertyValue(el, viewMode);
          const color = colorScale(typeof value === "number" ? value : 0);
          const row = getRow(el.atomicNumber);
          const col = getCol(el.atomicNumber);
          return {
            type: "rectangle" as const,
            x: col, y: row, width: 0.9, height: 0.9,
            color, fill: color,
          };
        }),
        annotations: elements.map(el => {
          const row = getRow(el.atomicNumber);
          const col = getCol(el.atomicNumber);
          return { x: col + 0.45, y: row + 0.45, text: el.symbol, color: "#fff" };
        }),
        metrics: {
          "Element": `${element.name} (${element.symbol})`,
          "Atomic Number": element.atomicNumber,
          "Atomic Mass": element.atomicMass,
          "Category": element.category,
          "Electron Config": element.electronConfiguration,
          [viewMode]: getPropertyValue(element, viewMode),
        },
      },
    };
  },
  reset: (state) => ({ ...state, frameData: {} }),
});

function getPeriodicTableData() {
  // Simplified periodic table data
  const elements = [
    { atomicNumber: 1, symbol: "H", name: "Hydrogen", atomicMass: 1.008, category: "nonmetal", electronConfiguration: "1s¹", electronegativity: 2.20, atomicRadius: 53, ionizationEnergy: 13.6, meltingPoint: 14, boilingPoint: 20, density: 0.09 },
    { atomicNumber: 2, symbol: "He", name: "Helium", atomicMass: 4.003, category: "noble-gas", electronConfiguration: "1s²", electronegativity: 0, atomicRadius: 31, ionizationEnergy: 24.6, meltingPoint: 1, boilingPoint: 4, density: 0.18 },
    { atomicNumber: 3, symbol: "Li", name: "Lithium", atomicMass: 6.94, category: "alkali-metal", electronConfiguration: "[He] 2s¹", electronegativity: 0.98, atomicRadius: 167, ionizationEnergy: 5.39, meltingPoint: 454, boilingPoint: 1615, density: 0.53 },
    { atomicNumber: 4, symbol: "Be", name: "Beryllium", atomicMass: 9.012, category: "alkaline-earth", electronConfiguration: "[He] 2s²", electronegativity: 1.57, atomicRadius: 112, ionizationEnergy: 9.32, meltingPoint: 1560, boilingPoint: 2742, density: 1.85 },
    { atomicNumber: 5, symbol: "B", name: "Boron", atomicMass: 10.81, category: "metalloid", electronConfiguration: "[He] 2s² 2p¹", electronegativity: 2.04, atomicRadius: 87, ionizationEnergy: 8.30, meltingPoint: 2349, boilingPoint: 4200, density: 2.34 },
    { atomicNumber: 6, symbol: "C", name: "Carbon", atomicMass: 12.01, category: "nonmetal", electronConfiguration: "[He] 2s² 2p²", electronegativity: 2.55, atomicRadius: 67, ionizationEnergy: 11.26, meltingPoint: 3823, boilingPoint: 4098, density: 2.26 },
    { atomicNumber: 7, symbol: "N", name: "Nitrogen", atomicMass: 14.01, category: "nonmetal", electronConfiguration: "[He] 2s² 2p³", electronegativity: 3.04, atomicRadius: 56, ionizationEnergy: 14.53, meltingPoint: 63, boilingPoint: 77, density: 0.00125 },
    { atomicNumber: 8, symbol: "O", name: "Oxygen", atomicMass: 16.00, category: "nonmetal", electronConfiguration: "[He] 2s² 2p⁴", electronegativity: 3.44, atomicRadius: 48, ionizationEnergy: 13.62, meltingPoint: 55, boilingPoint: 90, density: 0.00143 },
    { atomicNumber: 9, symbol: "F", name: "Fluorine", atomicMass: 19.00, category: "halogen", electronConfiguration: "[He] 2s² 2p⁵", electronegativity: 3.98, atomicRadius: 42, ionizationEnergy: 17.42, meltingPoint: 53, boilingPoint: 85, density: 0.0017 },
    { atomicNumber: 10, symbol: "Ne", name: "Neon", atomicMass: 20.18, category: "noble-gas", electronConfiguration: "[He] 2s² 2p⁶", electronegativity: 0, atomicRadius: 38, ionizationEnergy: 21.56, meltingPoint: 25, boilingPoint: 27, density: 0.0009 },
    { atomicNumber: 11, symbol: "Na", name: "Sodium", atomicMass: 22.99, category: "alkali-metal", electronConfiguration: "[Ne] 3s¹", electronegativity: 0.93, atomicRadius: 190, ionizationEnergy: 5.14, meltingPoint: 371, boilingPoint: 1156, density: 0.97 },
    { atomicNumber: 12, symbol: "Mg", name: "Magnesium", atomicMass: 24.31, category: "alkaline-earth", electronConfiguration: "[Ne] 3s²", electronegativity: 1.31, atomicRadius: 145, ionizationEnergy: 7.65, meltingPoint: 923, boilingPoint: 1363, density: 1.74 },
    { atomicNumber: 13, symbol: "Al", name: "Aluminum", atomicMass: 26.98, category: "post-transition", electronConfiguration: "[Ne] 3s² 3p¹", electronegativity: 1.61, atomicRadius: 118, ionizationEnergy: 5.99, meltingPoint: 933, boilingPoint: 2792, density: 2.70 },
    { atomicNumber: 14, symbol: "Si", name: "Silicon", atomicMass: 28.09, category: "metalloid", electronConfiguration: "[Ne] 3s² 3p²", electronegativity: 1.90, atomicRadius: 111, ionizationEnergy: 8.15, meltingPoint: 1687, boilingPoint: 3538, density: 2.33 },
    { atomicNumber: 15, symbol: "P", name: "Phosphorus", atomicMass: 30.97, category: "nonmetal", electronConfiguration: "[Ne] 3s² 3p³", electronegativity: 2.19, atomicRadius: 106, ionizationEnergy: 10.49, meltingPoint: 317, boilingPoint: 554, density: 1.82 },
    { atomicNumber: 16, symbol: "S", name: "Sulfur", atomicMass: 32.07, category: "nonmetal", electronConfiguration: "[Ne] 3s² 3p⁴", electronegativity: 2.58, atomicRadius: 102, ionizationEnergy: 10.36, meltingPoint: 388, boilingPoint: 718, density: 2.07 },
    { atomicNumber: 17, symbol: "Cl", name: "Chlorine", atomicMass: 35.45, category: "halogen", electronConfiguration: "[Ne] 3s² 3p⁵", electronegativity: 3.16, atomicRadius: 99, ionizationEnergy: 12.97, meltingPoint: 172, boilingPoint: 239, density: 0.0032 },
    { atomicNumber: 18, symbol: "Ar", name: "Argon", atomicMass: 39.95, category: "noble-gas", electronConfiguration: "[Ne] 3s² 3p⁶", electronegativity: 0, atomicRadius: 71, ionizationEnergy: 15.76, meltingPoint: 84, boilingPoint: 87, density: 0.0018 },
  ];
  // Add more elements up to 118...
  for (let i = 19; i <= 118; i++) {
    elements.push({
      atomicNumber: i,
      symbol: `El${i}`,
      name: `Element ${i}`,
      atomicMass: i * 1.5,
      category: "unknown",
      electronConfiguration: "N/A",
      electronegativity: Math.random() * 4,
      atomicRadius: 50 + Math.random() * 150,
      ionizationEnergy: 5 + Math.random() * 15,
      meltingPoint: 100 + Math.random() * 3000,
      boilingPoint: 200 + Math.random() * 4000,
      density: Math.random() * 20,
    });
  }
  return elements;
}

function getRow(atomicNumber: number): number {
  if (atomicNumber <= 2) return 1;
  if (atomicNumber <= 10) return 2;
  if (atomicNumber <= 18) return 3;
  if (atomicNumber <= 36) return 4;
  if (atomicNumber <= 54) return 5;
  if (atomicNumber <= 86) return 6;
  if (atomicNumber <= 118) return 7;
  return 7;
}

function getCol(atomicNumber: number): number {
  if (atomicNumber === 1) return 1;
  if (atomicNumber === 2) return 18;
  if (atomicNumber <= 10) return atomicNumber - 2 + 1;
  if (atomicNumber <= 18) return atomicNumber - 10 + 1;
  if (atomicNumber <= 36) return atomicNumber - 18 + 1;
  if (atomicNumber <= 54) return atomicNumber - 36 + 1;
  if (atomicNumber <= 86) return atomicNumber - 54 + 1;
  return atomicNumber - 86 + 1;
}

function getPropertyValue(element: any, property: string): number | string {
  switch (property) {
    case "electronegativity": return element.electronegativity;
    case "atomicRadius": return element.atomicRadius;
    case "ionizationEnergy": return element.ionizationEnergy;
    case "meltingPoint": return element.meltingPoint;
    case "boilingPoint": return element.boilingPoint;
    case "density": return element.density;
    default: return 0;
  }
}

function getColorScale(property: string, elements: any[]) {
  const values = elements.map(e => getPropertyValue(e, property)).filter(v => typeof v === "number") as number[];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (value: number) => {
    if (typeof value !== "number" || value === 0) return "#64748b";
    const ratio = (value - min) / (max - min);
    const r = Math.round(59 + ratio * 180);
    const g = Math.round(130 - ratio * 100);
    const b = Math.round(246 - ratio * 200);
    return `rgb(${r}, ${g}, ${b})`;
  };
}

/* ============================================================================
 * BUSINESS/ECONOMICS SIMULATIONS
 * ============================================================================ */

// Compound Growth / Investment Simulator
registerSimulation({
  id: "compound-growth",
  name: "Compound Growth Simulator",
  category: "business_economics",
  description: "Visualize compound interest, investment growth, and retirement planning",
  parameters: [
    { id: "principal", label: "Initial Investment", type: "number", min: 0, max: 1000000, step: 100, default: 10000, unit: "$" },
    { id: "monthlyContribution", label: "Monthly Contribution", type: "number", min: 0, max: 50000, step: 50, default: 500, unit: "$" },
    { id: "annualRate", label: "Annual Return Rate", type: "number", min: -20, max: 30, step: 0.1, default: 7, unit: "%" },
    { id: "years", label: "Years", type: "number", min: 1, max: 50, step: 1, default: 30 },
    { id: "inflationRate", label: "Inflation Rate", type: "number", min: 0, max: 15, step: 0.1, default: 3, unit: "%" },
    { id: "showInflationAdjusted", label: "Show Inflation-Adjusted", type: "boolean", default: true },
  ],
  initialState: {},
  renderHints: { width: 800, height: 400, bounds: { xMin: 0, xMax: 30, yMin: 0, yMax: 500000 }, showGrid: true, showAxes: true },
  educational: {
    concepts: ["Compound Interest", "Time Value of Money", "Inflation", "Retirement Planning"],
    learningObjectives: ["Understand exponential growth", "See impact of regular contributions", "Compare nominal vs real returns"],
    suggestedExperiments: ["Vary contribution amounts", "Compare different return rates", "See inflation erosion"],
  },
  step: (state) => {
    const p = state.parameters;
    const P = p.principal as number;
    const PMT = p.monthlyContribution as number;
    const r = (p.annualRate as number) / 100;
    const n = p.years as number;
    const inf = (p.inflationRate as number) / 100;

    const nominalPoints = [];
    const realPoints = [];
    const contribPoints = [];
    let balance = P;
    let totalContrib = P;

    for (let year = 0; year <= n; year++) {
      nominalPoints.push({ x: year, y: balance });
      contribPoints.push({ x: year, y: totalContrib });
      if (p.showInflationAdjusted) {
        realPoints.push({ x: year, y: balance / Math.pow(1 + inf, year) });
      }
      if (year < n) {
        balance = balance * (1 + r) + PMT * 12;
        totalContrib += PMT * 12;
      }
    }

    const finalNominal = nominalPoints[nominalPoints.length - 1].y;
    const finalReal = p.showInflationAdjusted ? realPoints[realPoints.length - 1].y : finalNominal;
    const totalGains = finalNominal - totalContrib;

    return {
      ...state,
      frameData: {
        lines: [
          { points: nominalPoints, color: "#3b82f6", label: "Nominal Value" },
          { points: contribPoints, color: "#64748b", label: "Contributions" },
          ...(p.showInflationAdjusted ? [{ points: realPoints, color: "#22c55e", label: "Inflation-Adjusted" }] : []),
        ],
        metrics: {
          "Final Value (Nominal)": `$${finalNominal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
          "Final Value (Real)": `$${finalReal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
          "Total Contributions": `$${totalContrib.toLocaleString()}`,
          "Investment Gains": `$${totalGains.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
          "Effective Annual Rate": `${((Math.pow(finalNominal / P, 1 / n) - 1) * 100).toFixed(2)}%`,
        },
      },
    };
  },
  reset: (state) => ({ ...state, frameData: {} }),
});

// Supply and Demand
registerSimulation({
  id: "supply-demand",
  name: "Supply & Demand Model",
  category: "business_economics",
  description: "Interactive supply and demand curves with equilibrium analysis",
  parameters: [
    { id: "demandIntercept", label: "Demand Intercept (a)", type: "number", min: 10, max: 200, step: 1, default: 100, unit: "$" },
    { id: "demandSlope", label: "Demand Slope (b)", type: "number", min: 0.1, max: 10, step: 0.1, default: 1, unit: "$/unit" },
    { id: "supplyIntercept", label: "Supply Intercept (c)", type: "number", min: 0, max: 100, step: 1, default: 10, unit: "$" },
    { id: "supplySlope", label: "Supply Slope (d)", type: "number", min: 0.1, max: 10, step: 0.1, default: 1, unit: "$/unit" },
    { id: "tax", label: "Per-Unit Tax", type: "number", min: 0, max: 50, step: 1, default: 0, unit: "$" },
    { id: "subsidy", label: "Per-Unit Subsidy", type: "number", min: 0, max: 50, step: 1, default: 0, unit: "$" },
  ],
  initialState: {},
  renderHints: { width: 600, height: 400, bounds: { xMin: 0, xMax: 100, yMin: 0, yMax: 120 }, showGrid: true, showAxes: true },
  educational: {
    concepts: ["Market Equilibrium", "Consumer/Producer Surplus", "Tax Incidence", "Deadweight Loss"],
    learningObjectives: ["Find equilibrium price/quantity", "Calculate surpluses", "Analyze tax effects"],
    suggestedExperiments: ["Shift curves and find new equilibrium", "Add tax and see incidence", "Calculate deadweight loss"],
  },
  step: (state) => {
    const p = state.parameters;
    const a = p.demandIntercept as number;
    const b = p.demandSlope as number;
    const c = p.supplyIntercept as number;
    const d = p.supplySlope as number;
    const t = p.tax as number;
    const s = p.subsidy as number;

    // Qd = a - bP, Qs = c + dP
    // Equilibrium: a - bP = c + dP => P = (a - c) / (b + d)
    const P_eq = (a - c) / (b + d);
    const Q_eq = a - b * P_eq;

    // With tax on producers: Qs = c + d(P - t)
    // With subsidy: Qs = c + d(P + s)
    const P_eq_tax = (a - c + d * t - d * s) / (b + d);
    const Q_eq_tax = a - b * P_eq_tax;
    const P_producer = P_eq_tax - t + s;

    // Consumer surplus = 0.5 * (a - P) * Q
    const CS = 0.5 * (a - P_eq_tax) * Q_eq_tax;
    // Producer surplus = 0.5 * (P_producer - c) * Q
    const PS = 0.5 * (P_producer - c) * Q_eq_tax;
    // Deadweight loss = 0.5 * (Q_eq - Q_eq_tax) * (t - s)
    const DWL = 0.5 * Math.abs(Q_eq - Q_eq_tax) * (t - s);

    const demandPoints = [];
    const supplyPoints = [];
    const supplyTaxPoints = [];
    for (let Q = 0; Q <= Math.max(Q_eq * 1.5, 10); Q += 1) {
      const Pd = (a - Q) / b;
      const Ps = (Q - c) / d;
      const Ps_tax = (Q - c) / d + t - s;
      if (Pd >= 0) demandPoints.push({ x: Q, y: Pd });
      if (Ps >= 0) supplyPoints.push({ x: Q, y: Ps });
      if (Ps_tax >= 0) supplyTaxPoints.push({ x: Q, y: Ps_tax });
    }

    return {
      ...state,
      frameData: {
        lines: [
          { points: demandPoints, color: "#ef4444", label: "Demand" },
          { points: supplyPoints, color: "#22c55e", label: "Supply" },
          ...(t > 0 || s > 0 ? [{ points: supplyTaxPoints, color: "#f59e0b", label: t > 0 ? "Supply + Tax" : "Supply - Subsidy" }] : []),
        ],
        points: [
          { x: Q_eq_tax, y: P_eq_tax, label: "Equilibrium", color: "#8b5cf6" },
        ],
        metrics: {
          "Equilibrium Price": `$${P_eq_tax.toFixed(2)}`,
          "Equilibrium Quantity": Q_eq_tax.toFixed(1),
          "Consumer Surplus": `$${CS.toFixed(2)}`,
          "Producer Surplus": `$${PS.toFixed(2)}`,
          "Deadweight Loss": `$${DWL.toFixed(2)}`,
          "Tax Revenue": t > 0 ? `$${(t * Q_eq_tax).toFixed(2)}` : "$0",
          "Subsidy Cost": s > 0 ? `$${(s * Q_eq_tax).toFixed(2)}` : "$0",
        },
      },
    };
  },
  reset: (state) => ({ ...state, frameData: {} }),
});