// ---------------------------------------------------------------------------
// Mathematical Environment Core Engine
// ---------------------------------------------------------------------------
//
// Safe expression parsing, equation solving, 2D/3D plotting, geometry,
// and calculus visualizations — NO eval, NO arbitrary code execution.
//
// ---------------------------------------------------------------------------

import {
  parse,
  compile,
  derivative,
  simplify,
  evaluate,
  MathNode,
  Node,
  MathJsStatic,
  sin, cos, tan, asin, acos, atan, atan2,
  sinh, cosh, tanh, asinh, acosh, atanh,
  exp, log, log10, log2, log1p, expm1,
  sqrt, cbrt, pow, hypot,
  abs, ceil, floor, round, fix, sign,
  min, max,
  mean, median, mode, std, variance, sum,
  random, randomInt,
  re, im, arg, conj,
  det, inv, transpose, cross, dot,
  gcd, lcm, gamma,
} from "mathjs";

// Create a mathjs instance with only safe functions
const math: MathJsStatic = {
  parse,
  compile,
  derivative,
  simplify,
  evaluate,
  // Constants
  pi: Math.PI,
  e: Math.E,
  tau: 2 * Math.PI,
  // Functions
  sin, cos, tan, asin, acos, atan, atan2,
  sinh, cosh, tanh, asinh, acosh, atanh,
  exp, log, log10, log2, log1p, expm1,
  sqrt, cbrt, pow, hypot,
  abs, ceil, floor, round, fix, sign,
  min, max,
  mean, median, mode, std, variance, sum,
  random, randomInt,
  re, im, arg, conj,
  det, inv, transpose, cross, dot,
  gcd, lcm, factorial, gamma,
} as any;

/* ============================================================================
 * SAFE EXPRESSION PARSER / EVALUATOR
 * ============================================================================ */

// Allowed functions and constants for safe evaluation
const ALLOWED_FUNCTIONS = new Set([
  // Trigonometric
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  // Exponential/Logarithmic
  "exp", "log", "log10", "log2", "log1p", "expm1",
  // Power/Root
  "sqrt", "cbrt", "pow", "hypot",
  // Rounding
  "abs", "ceil", "floor", "round", "trunc", "sign",
  "min", "max", "clamp",
  // Statistics
  "mean", "median", "mode", "std", "variance", "sum",
  // Random
  "random", "randomInt",
  // Complex
  "re", "im", "arg", "conj",
  // Matrix
  "det", "inv", "transpose", "cross", "dot",
  // Number theory
  "gcd", "lcm", "factorial", "gamma",
  // Constants
  "pi", "e", "tau", "phi", "Infinity", "NaN",
]);

const ALLOWED_OPERATORS = new Set([
  "+", "-", "*", "/", "^", "%",
  "==", "!=", "<", ">", "<=", ">=",
  "and", "or", "not", "xor",
  "?", ":",
]);

// Create a restricted math.js scope
function createSafeScope(variables: Record<string, number> = {}): Record<string, unknown> {
  const scope: Record<string, unknown> = { ...variables };

  // Add allowed constants
  scope.pi = Math.PI;
  scope.e = Math.E;
  scope.tau = 2 * Math.PI;
  scope.phi = (1 + Math.sqrt(5)) / 2;
  scope.Infinity = Infinity;
  scope.NaN = NaN;

  // Add allowed functions
  for (const fn of ALLOWED_FUNCTIONS) {
    if (typeof (math as any)[fn] === "function") {
      scope[fn] = (math as any)[fn];
    }
  }

  // Add math.js constants
  if ((math as any).pi) scope.pi = (math as any).pi;
  if ((math as any).e) scope.e = (math as any).e;

  return scope;
}

/**
 * Safely parse and evaluate a mathematical expression.
 * Throws on invalid expressions or disallowed operations.
 */
export function evaluateExpression(expr: string, variables: Record<string, number> = {}): number {
  try {
    const scope = createSafeScope(variables);
    const node = parse(expr);
    validateNode(node);
    return evaluate(node as any, scope) as number;
  } catch (error) {
    throw new Error(`Expression error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate that an AST node only uses allowed operations.
 */
function validateNode(node: MathNode): void {
  const type = node.type;

  // Check function calls
  if (type === "FunctionNode") {
    const fnNode = node as any;
    const fnName = fnNode.name;
    if (!ALLOWED_FUNCTIONS.has(fnName)) {
      throw new Error(`Disallowed function: ${fnName}`);
    }
    // Recursively validate arguments
    for (const arg of fnNode.args) {
      validateNode(arg);
    }
    return;
  }

  // Check operators
  if (type === "OperatorNode") {
    const opNode = node as any;
    const op = opNode.op;
    if (!ALLOWED_OPERATORS.has(op)) {
      throw new Error(`Disallowed operator: ${op}`);
    }
    // Recursively validate operands
    for (const arg of opNode.args) {
      validateNode(arg);
    }
    return;
  }

  // Check symbol nodes (variables)
  if (type === "SymbolNode") {
    const symNode = node as any;
    const name = symNode.name;
    // Allow constants
    if (ALLOWED_FUNCTIONS.has(name)) return;
    // Variables will be checked at evaluation time via scope
    return;
  }

  // Literals (ConstantNode) are always safe
  if (type === "ConstantNode" || type === "ParenthesisNode") {
    return;
  }

  // Assignment nodes not allowed
  if (type === "AssignmentNode") {
    throw new Error("Assignment not allowed in expressions");
  }

  // Block/conditional nodes
  if (type === "BlockNode" || type === "ConditionalNode") {
    const blockNode = node as any;
    for (const arg of blockNode.args || []) {
      validateNode(arg);
    }
    return;
  }

  // Index/Range/Accessor nodes
  if (type === "IndexNode" || type === "RangeNode" || type === "AccessorNode") {
    const indexNode = node as any;
    for (const arg of indexNode.args || []) {
      validateNode(arg);
    }
    return;
  }

  // Unknown node type - reject for safety
  throw new Error(`Unknown node type: ${type}`);
}

/**
 * Compile an expression for repeated fast evaluation.
 */
export function compileExpression(expr: string): (variables: Record<string, number>) => number {
  const node = parse(expr);
  validateNode(node);
  const compiled = compile(node as any);
  return (variables: Record<string, number>) => {
    const scope = createSafeScope(variables);
    return compiled.evaluate(scope) as number;
  };
}

/* ============================================================================
 * EQUATION SOLVER
 * ============================================================================ */

export interface SolverOptions {
  /** Maximum iterations */
  maxIterations?: number;
  /** Convergence tolerance */
  tolerance?: number;
  /** Initial guess (for Newton-Raphson) */
  initialGuess?: number;
  /** Interval [a, b] for bisection (must bracket root) */
  interval?: [number, number];
}

export interface SolverResult {
  /** Found root */
  root: number;
  /** Function value at root */
  fRoot: number;
  /** Number of iterations */
  iterations: number;
  /** Whether converged */
  converged: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Newton-Raphson method for finding roots.
 */
export function newtonRaphson(
  f: (x: number) => number,
  df: (x: number) => number,
  options: SolverOptions = {}
): SolverResult {
  const { maxIterations = 100, tolerance = 1e-10, initialGuess = 0 } = options;

  let x = initialGuess;
  let fx = f(x);
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    const dfx = df(x);

    if (Math.abs(dfx) < 1e-14) {
      return {
        root: x,
        fRoot: fx,
        iterations,
        converged: false,
        error: "Derivative near zero - cannot continue",
      };
    }

    const xNew = x - fx / dfx;
    const fNew = f(xNew);
    iterations++;

    if (Math.abs(xNew - x) < tolerance && Math.abs(fNew) < tolerance) {
      return { root: xNew, fRoot: fNew, iterations, converged: true };
    }

    x = xNew;
    fx = fNew;
  }

  return { root: x, fRoot: fx, iterations, converged: false, error: "Max iterations reached" };
}

/**
 * Bisection method for finding roots (guaranteed convergence if interval brackets root).
 */
export function bisection(
  f: (x: number) => number,
  options: SolverOptions = {}
): SolverResult {
  const { maxIterations = 100, tolerance = 1e-10, interval } = options;

  if (!interval) {
    return { root: NaN, fRoot: NaN, iterations: 0, converged: false, error: "Interval required for bisection" };
  }

  let [a, b] = interval;
  const fa = f(a);
  const fb = f(b);

  if (fa * fb > 0) {
    return { root: NaN, fRoot: NaN, iterations: 0, converged: false, error: "Interval does not bracket a root" };
  }

  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    const c = (a + b) / 2;
    const fc = f(c);
    iterations++;

    if (Math.abs(fc) < tolerance || (b - a) / 2 < tolerance) {
      return { root: c, fRoot: fc, iterations, converged: true };
    }

    if (fa * fc <= 0) {
      b = c;
      // fb = fc; // not needed
    } else {
      a = c;
      // fa = fc; // not needed
    }
  }

  const c = (a + b) / 2;
  return { root: c, fRoot: f(c), iterations, converged: false, error: "Max iterations reached" };
}

/**
 * Secant method (derivative-free alternative to Newton-Raphson).
 */
export function secant(
  f: (x: number) => number,
  options: SolverOptions = {}
): SolverResult {
  const { maxIterations = 100, tolerance = 1e-10, initialGuess = 0 } = options;

  let x0 = initialGuess - 0.1;
  let x1 = initialGuess;
  let f0 = f(x0);
  let f1 = f(x1);
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (Math.abs(f1 - f0) < 1e-14) {
      return { root: x1, fRoot: f1, iterations, converged: false, error: "Division by zero in secant" };
    }

    const x2 = x1 - f1 * (x1 - x0) / (f1 - f0);
    const f2 = f(x2);
    iterations++;

    if (Math.abs(x2 - x1) < tolerance && Math.abs(f2) < tolerance) {
      return { root: x2, fRoot: f2, iterations, converged: true };
    }

    x0 = x1;
    x1 = x2;
    f0 = f1;
    f1 = f2;
  }

  return { root: x1, fRoot: f1, iterations, converged: false, error: "Max iterations reached" };
}

/**
 * Find all roots in an interval using bisection with scanning.
 */
export function findRoots(
  f: (x: number) => number,
  interval: [number, number],
  numScans = 100
): SolverResult[] {
  const [a, b] = interval;
  const results: SolverResult[] = [];
  const step = (b - a) / numScans;

  let x0 = a;
  let f0 = f(x0);

  for (let i = 1; i <= numScans; i++) {
    const x1 = a + i * step;
    const f1 = f(x1);

    if (f0 === 0) {
      results.push({ root: x0, fRoot: 0, iterations: 0, converged: true });
    } else if (f0 * f1 < 0) {
      const result = bisection(f, { interval: [x0, x1], tolerance: 1e-12 });
      if (result.converged) {
        // Check if this root is already found (within tolerance)
        const isDuplicate = results.some(r => Math.abs(r.root - result.root) < 1e-6);
        if (!isDuplicate) {
          results.push(result);
        }
      }
    }

    x0 = x1;
    f0 = f1;
  }

  // Check endpoint
  if (f0 === 0) {
    const isDuplicate = results.some(r => Math.abs(r.root - b) < 1e-6);
    if (!isDuplicate) {
      results.push({ root: b, fRoot: 0, iterations: 0, converged: true });
    }
  }

  return results.sort((a, b) => a.root - b.root);
}

/* ============================================================================
 * 2D FUNCTION PLOTTER
 * ============================================================================ */

export type FunctionType = "cartesian" | "parametric" | "polar";

export interface Plot2DOptions {
  /** Function type */
  type: FunctionType;
  /** Domain for x or t */
  domain: [number, number];
  /** Number of sample points */
  samples?: number;
  /** For parametric: y(t) expression */
  yExpr?: string;
  /** For polar: r(θ) expression */
  /** Variable name (default: 'x' for cartesian, 't' for parametric/polar) */
  variable?: string;
}

export interface Plot2DResult {
  points: { x: number; y: number }[];
  xRange: [number, number];
  yRange: [number, number];
  asymptotes?: number[]; // x-values where function blows up
}

/**
 * Generate 2D plot points for various function types.
 */
export function plot2D(
  expr: string,
  options: Plot2DOptions
): Plot2DResult {
  const {
    type,
    domain: [min, max],
    samples = 500,
    yExpr,
    variable = type === "cartesian" ? "x" : "t",
  } = options;

  const fn = compileExpression(expr);
  const yFn = yExpr ? compileExpression(yExpr) : null;

  const points: { x: number; y: number }[] = [];
  let yMin = Infinity;
  let yMax = -Infinity;
  const asymptotes: number[] = [];
  let prevY: number | null = null;
  let prevX: number | null = null;

  for (let i = 0; i <= samples; i++) {
    const t = min + (max - min) * i / samples;
    const vars = { [variable]: t };

    try {
      let x: number, y: number;

      if (type === "cartesian") {
        x = t;
        y = fn(vars);
      } else if (type === "parametric") {
        if (!yFn) throw new Error("Parametric requires yExpr");
        x = fn(vars);
        y = yFn(vars);
      } else { // polar
        const r = fn(vars);
        x = r * Math.cos(t);
        y = r * Math.sin(t);
      }

      if (isFinite(x) && isFinite(y) && Math.abs(y) < 1e6) {
        // Detect asymptotes (large jumps in y)
        if (prevY !== null && Math.abs(y - prevY) > 100 && Math.abs(prevX! - x) < (max - min) / samples * 2) {
          asymptotes.push((prevX! + x) / 2);
        }
        points.push({ x, y });
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
        prevY = y;
        prevX = x;
      } else {
        // Gap in function - reset previous
        prevY = null;
        prevX = null;
      }
    } catch {
      // Evaluation failed - gap in function
      prevY = null;
      prevX = null;
    }
  }

  return {
    points,
    xRange: [min, max],
    yRange: [yMin === Infinity ? -10 : yMin, yMax === -Infinity ? 10 : yMax],
    asymptotes: asymptotes.length > 0 ? asymptotes : undefined,
  };
}

/* ============================================================================
 * 3D SURFACE PLOTTER (data generation for three.js)
 * ============================================================================ */

export interface Plot3DOptions {
  /** Domain for x */
  xDomain: [number, number];
  /** Domain for y */
  yDomain: [number, number];
  /** Grid resolution */
  resolution?: number;
  /** Variable names */
  variables?: { x: string; y: string };
}

export interface Plot3DResult {
  /** Grid vertices [x, y, z] flattened */
  vertices: Float32Array;
  /** Grid indices for triangle strips */
  indices: Uint32Array;
  /** Color data per vertex */
  colors?: Float32Array;
  /** Bounding box */
  bounds: {
    x: [number, number];
    y: [number, number];
    z: [number, number];
  };
}

/**
 * Generate 3D surface data for z = f(x, y).
 */
export function plot3D(
  expr: string,
  options: Plot3DOptions
): Plot3DResult {
  const {
    xDomain: [xMin, xMax],
    yDomain: [yMin, yMax],
    resolution = 50,
    variables = { x: "x", y: "y" },
  } = options;

  const fn = compileExpression(expr);
  const res = resolution;

  const vertices = new Float32Array((res + 1) * (res + 1) * 3);
  const indices = new Uint32Array(res * res * 6);
  const colors = new Float32Array((res + 1) * (res + 1) * 3);

  let zMin = Infinity;
  let zMax = -Infinity;
  const zValues: number[][] = [];

  // Generate vertices and compute z-values
  for (let iy = 0; iy <= res; iy++) {
    const y = yMin + (yMax - yMin) * iy / res;
    zValues[iy] = [];
    for (let ix = 0; ix <= res; ix++) {
      const x = xMin + (xMax - xMin) * ix / res;
      const idx = (iy * (res + 1) + ix) * 3;

      try {
        const z = fn({ [variables.x]: x, [variables.y]: y });
        const zFinite = isFinite(z) ? z : 0;
        zValues[iy][ix] = zFinite;
        zMin = Math.min(zMin, zFinite);
        zMax = Math.max(zMax, zFinite);

        vertices[idx] = x;
        vertices[idx + 1] = y;
        vertices[idx + 2] = zFinite;
      } catch {
        vertices[idx] = x;
        vertices[idx + 1] = y;
        vertices[idx + 2] = 0;
        zValues[iy][ix] = 0;
      }
    }
  }

  // Generate indices for triangle strips
  let idx = 0;
  for (let iy = 0; iy < res; iy++) {
    for (let ix = 0; ix < res; ix++) {
      const a = iy * (res + 1) + ix;
      const b = iy * (res + 1) + ix + 1;
      const c = (iy + 1) * (res + 1) + ix;
      const d = (iy + 1) * (res + 1) + ix + 1;

      // Two triangles per quad
      indices[idx++] = a;
      indices[idx++] = c;
      indices[idx++] = b;
      indices[idx++] = b;
      indices[idx++] = c;
      indices[idx++] = d;
    }
  }

  // Generate colors based on z-value (height map)
  const zRange = zMax - zMin || 1;
  for (let iy = 0; iy <= res; iy++) {
    for (let ix = 0; ix <= res; ix++) {
      const z = zValues[iy][ix];
      const normalized = (z - zMin) / zRange;
      const cIdx = (iy * (res + 1) + ix) * 3;

      // Blue to red colormap
      colors[cIdx] = normalized;       // R
      colors[cIdx + 1] = 1 - normalized; // G
      colors[cIdx + 2] = 1 - normalized * 0.5; // B
    }
  }

  return {
    vertices,
    indices,
    colors,
    bounds: {
      x: [xMin, xMax],
      y: [yMin, yMax],
      z: [zMin, zMax],
    },
  };
}

/**
 * Generate parametric surface data: x = f(u,v), y = g(u,v), z = h(u,v)
 */
export function plot3DParametric(
  xExpr: string,
  yExpr: string,
  zExpr: string,
  uDomain: [number, number],
  vDomain: [number, number],
  resolution = 50
): Plot3DResult {
  const xFn = compileExpression(xExpr);
  const yFn = compileExpression(yExpr);
  const zFn = compileExpression(zExpr);
  const res = resolution;

  const vertices = new Float32Array((res + 1) * (res + 1) * 3);
  const indices = new Uint32Array(res * res * 6);
  const colors = new Float32Array((res + 1) * (res + 1) * 3);

  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;

  for (let iu = 0; iu <= res; iu++) {
    const u = uDomain[0] + (uDomain[1] - uDomain[0]) * iu / res;
    for (let iv = 0; iv <= res; iv++) {
      const v = vDomain[0] + (vDomain[1] - vDomain[0]) * iv / res;
      const idx = (iu * (res + 1) + iv) * 3;

      try {
        const x = xFn({ u, v });
        const y = yFn({ u, v });
        const z = zFn({ u, v });

        const xF = isFinite(x) ? x : 0;
        const yF = isFinite(y) ? y : 0;
        const zF = isFinite(z) ? z : 0;

        vertices[idx] = xF;
        vertices[idx + 1] = yF;
        vertices[idx + 2] = zF;

        xMin = Math.min(xMin, xF); xMax = Math.max(xMax, xF);
        yMin = Math.min(yMin, yF); yMax = Math.max(yMax, yF);
        zMin = Math.min(zMin, zF); zMax = Math.max(zMax, zF);
      } catch {
        vertices[idx] = 0;
        vertices[idx + 1] = 0;
        vertices[idx + 2] = 0;
      }
    }
  }

  // Generate indices
  let idx = 0;
  for (let iu = 0; iu < res; iu++) {
    for (let iv = 0; iv < res; iv++) {
      const a = iu * (res + 1) + iv;
      const b = iu * (res + 1) + iv + 1;
      const c = (iu + 1) * (res + 1) + iv;
      const d = (iu + 1) * (res + 1) + iv + 1;

      indices[idx++] = a; indices[idx++] = c; indices[idx++] = b;
      indices[idx++] = b; indices[idx++] = c; indices[idx++] = d;
    }
  }

  // Simple color by (u,v)
  for (let iu = 0; iu <= res; iu++) {
    for (let iv = 0; iv <= res; iv++) {
      const cIdx = (iu * (res + 1) + iv) * 3;
      colors[cIdx] = iu / res;
      colors[cIdx + 1] = iv / res;
      colors[cIdx + 2] = 0.5;
    }
  }

  return {
    vertices,
    indices,
    colors,
    bounds: { x: [xMin, xMax], y: [yMin, yMax], z: [zMin, zMax] },
  };
}

/* ============================================================================
 * GEOMETRY ENGINE
 * ============================================================================ */

export interface Point2D { x: number; y: number; }
export interface Point3D { x: number; y: number; z: number; }

export type GeometryObject =
  | { type: "point"; point: Point2D; label?: string }
  | { type: "line"; point1: Point2D; point2: Point2D; label?: string }
  | { type: "ray"; origin: Point2D; direction: Point2D; label?: string }
  | { type: "segment"; point1: Point2D; point2: Point2D; label?: string }
  | { type: "circle"; center: Point2D; radius: number; label?: string }
  | { type: "arc"; center: Point2D; radius: number; startAngle: number; endAngle: number; label?: string }
  | { type: "polygon"; vertices: Point2D[]; label?: string }
  | { type: "angle"; vertex: Point2D; point1: Point2D; point2: Point2D; label?: string };

export interface GeometryConstruction {
  objects: GeometryObject[];
  measurements: GeometryMeasurement[];
}

export interface GeometryMeasurement {
  type: "distance" | "angle" | "area" | "perimeter" | "midpoint" | "intersection";
  objects: string[];
  value?: number;
  point?: Point2D;
  label?: string;
}

export interface GeometryConstruction {
  objects: GeometryObject[];
  measurements: GeometryMeasurement[];
}

export interface GeometryMeasurement {
  type: "distance" | "angle" | "area" | "perimeter" | "midpoint" | "intersection";
  objects: string[]; // labels of involved objects
  value?: number;
  point?: Point2D;
  label?: string;
}

/**
 * Geometry engine for constructions and measurements.
 */
export class GeometryEngine {
  private objects = new Map<string, GeometryObject>();
  private counter = 0;

  private nextLabel(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  /** Add a point */
  addPoint(x: number, y: number, label?: string): string {
    const l = label || this.nextLabel("P");
    this.objects.set(l, { type: "point", point: { x, y }, label: l });
    return l;
  }

  /** Add a line through two points */
  addLine(label1: string, label2: string, label?: string): string {
    const p1 = this.objects.get(label1);
    const p2 = this.objects.get(label2);
    if (!p1 || !p2 || p1.type !== "point" || p2.type !== "point") {
      throw new Error("Both objects must be points");
    }
    const l = label || this.nextLabel("L");
    this.objects.set(l, { type: "line", point1: p1.point, point2: p2.point, label: l });
    return l;
  }

  /** Add a line segment */
  addSegment(label1: string, label2: string, label?: string): string {
    const p1 = this.objects.get(label1);
    const p2 = this.objects.get(label2);
    if (!p1 || !p2 || p1.type !== "point" || p2.type !== "point") {
      throw new Error("Both objects must be points");
    }
    const l = label || this.nextLabel("S");
    this.objects.set(l, { type: "segment", point1: p1.point, point2: p2.point, label: l });
    return l;
  }

  /** Add a circle */
  addCircle(centerLabel: string, radius: number, label?: string): string {
    const center = this.objects.get(centerLabel);
    if (!center || center.type !== "point") {
      throw new Error("Center must be a point");
    }
    const l = label || this.nextLabel("C");
    this.objects.set(l, { type: "circle", center: center.point, radius, label: l });
    return l;
  }

  /** Add a circle through three points */
  addCircleThroughPoints(label1: string, label2: string, label3: string, label?: string): string {
    const p1 = this.objects.get(label1);
    const p2 = this.objects.get(label2);
    const p3 = this.objects.get(label3);
    if (!p1 || !p2 || !p3 || p1.type !== "point" || p2.type !== "point" || p3.type !== "point") {
      throw new Error("All objects must be points");
    }

    // Calculate circumcenter
    const { x: x1, y: y1 } = p1.point;
    const { x: x2, y: y2 } = p2.point;
    const { x: x3, y: y3 } = p3.point;

    const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if (Math.abs(d) < 1e-10) throw new Error("Points are collinear");

    const ux = ((x1*x1 + y1*y1) * (y2 - y3) + (x2*x2 + y2*y2) * (y3 - y1) + (x3*x3 + y3*y3) * (y1 - y2)) / d;
    const uy = ((x1*x1 + y1*y1) * (x3 - x2) + (x2*x2 + y2*y2) * (x1 - x3) + (x3*x3 + y3*y3) * (x2 - x1)) / d;
    const r = Math.sqrt((x1 - ux)**2 + (y1 - uy)**2);

    const l = label || this.nextLabel("C");
    this.objects.set(l, { type: "circle", center: { x: ux, y: uy }, radius: r, label: l });
    return l;
  }

  /** Add a polygon */
  addPolygon(labels: string[], label?: string): string {
    const vertices: Point2D[] = [];
    for (const l of labels) {
      const obj = this.objects.get(l);
      if (!obj || obj.type !== "point") throw new Error(`${l} is not a point`);
      vertices.push(obj.point);
    }
    const l = label || this.nextLabel("Poly");
    this.objects.set(l, { type: "polygon", vertices, label: l });
    return l;
  }

  /** Get intersection of two lines */
  intersectLines(label1: string, label2: string, label?: string): string | null {
    const l1 = this.objects.get(label1);
    const l2 = this.objects.get(label2);
    if (!l1 || !l2 || l1.type !== "line" || l2.type !== "line") {
      throw new Error("Both objects must be lines");
    }

    const { point1: p1, point2: p2 } = l1;
    const { point1: p3, point2: p4 } = l2;

    const x1 = p1.x, y1 = p1.y;
    const x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y;
    const x4 = p4.x, y4 = p4.y;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-10) return null; // Parallel

    const px = ((x1*y2 - y1*x2) * (x3 - x4) - (x1 - x2) * (x3*y4 - y3*x4)) / denom;
    const py = ((x1*y2 - y1*x2) * (y3 - y4) - (y1 - y2) * (x3*y4 - y3*x4)) / denom;

    const l = label || this.nextLabel("I");
    this.objects.set(l, { type: "point", point: { x: px, y: py }, label: l });
    return l;
  }

  /** Get intersection of line and circle */
  intersectLineCircle(lineLabel: string, circleLabel: string, labelPrefix?: string): string[] {
    const line = this.objects.get(lineLabel);
    const circle = this.objects.get(circleLabel);
    if (!line || line.type !== "line" || !circle || circle.type !== "circle") {
      throw new Error("Invalid object types");
    }

    const { point1: p1, point2: p2 } = line;
    const { center, radius } = circle;

    // Line param: p1 + t*(p2-p1)
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const fx = p1.x - center.x;
    const fy = p1.y - center.y;

    const a = dx*dx + dy*dy;
    const b = 2 * (fx*dx + fy*dy);
    const c = fx*fx + fy*fy - radius*radius;

    const disc = b*b - 4*a*c;
    if (disc < 0) return [];

    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b + sqrtDisc) / (2*a);
    const t2 = (-b - sqrtDisc) / (2*a);

    const results: string[] = [];
    const baseLabel = labelPrefix || this.nextLabel("I");

    const addIntersection = (t: number, suffix: string) => {
      const x = p1.x + t * dx;
      const y = p1.y + t * dy;
      const l = `${baseLabel}${suffix}`;
      this.objects.set(l, { type: "point", point: { x, y }, label: l });
      results.push(l);
    };

    addIntersection(t1, "a");
    if (disc > 1e-10) addIntersection(t2, "b");

    return results;
  }

  /** Measure distance between two points */
  measureDistance(label1: string, label2: string): number {
    const p1 = this.objects.get(label1);
    const p2 = this.objects.get(label2);
    if (!p1 || !p2 || p1.type !== "point" || p2.type !== "point") {
      throw new Error("Both objects must be points");
    }
    const dx = p1.point.x - p2.point.x;
    const dy = p1.point.y - p2.point.y;
    return Math.sqrt(dx*dx + dy*dy);
  }

  /** Measure angle between three points (vertex at middle) */
  measureAngle(label1: string, vertexLabel: string, label2: string): number {
    const p1 = this.objects.get(label1);
    const pv = this.objects.get(vertexLabel);
    const p2 = this.objects.get(label2);
    if (!p1 || !pv || !p2 || p1.type !== "point" || pv.type !== "point" || p2.type !== "point") {
      throw new Error("All objects must be points");
    }

    const v1 = { x: p1.point.x - pv.point.x, y: p1.point.y - pv.point.y };
    const v2 = { x: p2.point.x - pv.point.x, y: p2.point.y - pv.point.y };

    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
    const mag2 = Math.sqrt(v2.x*v2.x + v2.y*v2.y);

    if (mag1 === 0 || mag2 === 0) return 0;
    const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    return Math.acos(cos) * 180 / Math.PI;
  }

  /** Get midpoint of two points */
  getMidpoint(label1: string, label2: string, label?: string): string {
    const p1 = this.objects.get(label1);
    const p2 = this.objects.get(label2);
    if (!p1 || !p2 || p1.type !== "point" || p2.type !== "point") {
      throw new Error("Both objects must be points");
    }

    const mid = {
      x: (p1.point.x + p2.point.x) / 2,
      y: (p1.point.y + p2.point.y) / 2,
    };

    const l = label || this.nextLabel("M");
    this.objects.set(l, { type: "point", point: mid, label: l });
    return l;
  }

  /** Get perpendicular bisector of segment */
  getPerpendicularBisector(label1: string, label2: string, label?: string): string {
    const midLabel = this.getMidpoint(label1, label2);
    const mid = this.objects.get(midLabel)!;
    const p1 = this.objects.get(label1)!;
    const p2 = this.objects.get(label2)!;

    // Type guard for point type
    if (mid.type !== "point" || p1.type !== "point" || p2.type !== "point") {
      throw new Error("Expected point objects");
    }

    // Perpendicular direction
    const dx = p2.point.x - p1.point.x;
    const dy = p2.point.y - p1.point.y;
    const perp = { x: -dy, y: dx };

    const l = label || this.nextLabel("PB");
    this.objects.set(l, {
      type: "line",
      point1: mid.point,
      point2: { x: mid.point.x + perp.x, y: mid.point.y + perp.y },
      label: l,
    });
    return l;
  }

  /** Get all objects */
  getAll(): GeometryObject[] {
    return Array.from(this.objects.values());
  }

  /** Get object by label */
  get(label: string): GeometryObject | undefined {
    return this.objects.get(label);
  }

  /** Clear all objects */
  clear(): void {
    this.objects.clear();
    this.counter = 0;
  }

  /** Export as construction */
  export(): GeometryConstruction {
    const measurements: GeometryMeasurement[] = [];
    // Could add measurements here based on objects
    return {
      objects: this.getAll(),
      measurements,
    };
  }
}

/* ============================================================================
 * CALCULUS VISUALIZATIONS
 * ============================================================================ */

export interface CalculusVisualizationOptions {
  /** Function expression */
  expression: string;
  /** Variable name */
  variable?: string;
  /** Domain */
  domain: [number, number];
  /** Number of samples */
  samples?: number;
}

export interface TangentLineResult {
  point: { x: number; y: number };
  slope: number;
  line: { x: number; y: number }[]; // Two points defining the line
  equation: string; // y = mx + b form
}

export interface AreaUnderCurveResult {
  /** Riemann sum approximation */
  riemannSum: number;
  /** Exact integral (if computable) */
  exactIntegral?: number;
  /** Rectangles for visualization */
  rectangles: { x: number; y: number; width: number; height: number }[];
  /** Method used */
  method: "left" | "right" | "midpoint" | "trapezoid";
}

export interface TaylorSeriesResult {
  /** Center point */
  center: number;
  /** Order */
  order: number;
  /** Polynomial coefficients [c0, c1, c2, ...] */
  coefficients: number[];
  /** Polynomial as string */
  polynomial: string;
  /** Approximation points */
  approximation: { x: number; y: number }[];
  /** Original function points */
  original: { x: number; y: number }[];
}

/**
 * Compute tangent line at a point.
 */
export function tangentLine(
  expr: string,
  x0: number,
  options: CalculusVisualizationOptions
): TangentLineResult {
  const { variable = "x", domain, samples = 100 } = options;

  // Compute derivative using mathjs
  const node = parse(expr);
  const derivNode = derivative(node, variable);
  const derivExpr = derivNode.toString();

  const f = compileExpression(expr);
  const df = compileExpression(derivExpr);

  const y0 = f({ [variable]: x0 });
  const slope = df({ [variable]: x0 });

  // Line equation: y = slope * (x - x0) + y0
  // For visualization, generate two points on the line
  const lineLength = (domain[1] - domain[0]) * 0.3;
  const x1 = x0 - lineLength / 2;
  const x2 = x0 + lineLength / 2;
  const y1 = slope * (x1 - x0) + y0;
  const y2 = slope * (x2 - x0) + y0;

  const intercept = y0 - slope * x0;
  const equation = `y = ${slope.toFixed(4)}x ${intercept >= 0 ? "+" : ""} ${intercept.toFixed(4)}`;

  return {
    point: { x: x0, y: y0 },
    slope,
    line: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
    equation,
  };
}

/**
 * Compute area under curve using Riemann sums.
 */
export function areaUnderCurve(
  expr: string,
  interval: [number, number],
  options: CalculusVisualizationOptions & { method?: "left" | "right" | "midpoint" | "trapezoid"; partitions?: number }
): AreaUnderCurveResult {
  const { variable = "x", method = "midpoint", partitions = 20 } = options;
  const [a, b] = interval;
  const f = compileExpression(expr);
  const width = (b - a) / partitions;

  const rectangles: { x: number; y: number; width: number; height: number }[] = [];
  let sum = 0;

  for (let i = 0; i < partitions; i++) {
    let x: number;
    switch (method) {
      case "left": x = a + i * width; break;
      case "right": x = a + (i + 1) * width; break;
      case "midpoint": x = a + (i + 0.5) * width; break;
      case "trapezoid": x = a + i * width; break;
    }

    const y = f({ [variable]: x });
    const height = Math.max(0, y); // Only positive area for visualization
    rectangles.push({ x: a + i * width, y: 0, width, height });
    sum += height * width;
  }

  // Try to compute exact integral using mathjs (if simple enough)
  let exactIntegral: number | undefined;
  try {
    const node = parse(expr);
    // Use numeric integration via mathjs evaluate with integral
    // math.integrate may not be available, skip exact integral for now
    // const integral = math.integrate(node, variable, a, b);
    // if (typeof integral === "number" && isFinite(integral)) {
    //   exactIntegral = integral;
    // }
  } catch {
    // Symbolic integration failed
  }

  return { riemannSum: sum, exactIntegral, rectangles, method };
}

/**
 * Compute Taylor series approximation.
 */
export function taylorSeries(
  expr: string,
  center: number,
  order: number,
  options: CalculusVisualizationOptions
): TaylorSeriesResult {
  const { variable = "x", domain, samples = 200 } = options;

  const node = parse(expr);
  const coefficients: number[] = [];
  const f = compileExpression(expr);

  // Compute derivatives at center
  let currentNode: MathNode = node;
  for (let n = 0; n <= order; n++) {
    try {
      const derivAtCenter = evaluate(currentNode as any, createSafeScope({ [variable]: center })) as number;
      const coeff = derivAtCenter / factorial(n);
      coefficients.push(coeff);

      // Compute next derivative
      if (n < order) {
        currentNode = derivative(currentNode, variable);
        currentNode = simplify(currentNode);
      }
    } catch {
      coefficients.push(0);
    }
  }

  // Build polynomial string
  const terms: string[] = [];
  for (let n = 0; n <= order; n++) {
    const c = coefficients[n];
    if (Math.abs(c) < 1e-10) continue;
    if (n === 0) {
      terms.push(c.toFixed(4));
    } else if (n === 1) {
      terms.push(`${c >= 0 ? "+ " : "- "}${Math.abs(c).toFixed(4)}(x - ${center})`);
    } else {
      terms.push(`${c >= 0 ? "+ " : "- "}${Math.abs(c).toFixed(4)}(x - ${center})^${n}`);
    }
  }
  const polynomial = terms.join(" ") || "0";

  // Generate approximation points
  const polyFn = (x: number) => {
    let result = 0;
    for (let n = 0; n <= order; n++) {
      result += coefficients[n] * Math.pow(x - center, n);
    }
    return result;
  };

  const approximation: { x: number; y: number }[] = [];
  const original: { x: number; y: number }[] = [];

  for (let i = 0; i <= samples; i++) {
    const x = domain[0] + (domain[1] - domain[0]) * i / samples;
    approximation.push({ x, y: polyFn(x) });
    try {
      original.push({ x, y: f({ [variable]: x }) });
    } catch {
      original.push({ x, y: NaN });
    }
  }

  return { center, order, coefficients, polynomial, approximation, original };
}

function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

/* ============================================================================
 * LIMIT EVALUATION
 * ============================================================================ */

export interface LimitResult {
  /** The limit value */
  value: number | "Infinity" | "-Infinity" | "Does not exist";
  /** Approach direction */
  direction: "left" | "right" | "both";
  /** Sequence of values showing convergence */
  sequence: { x: number; y: number }[];
}

/**
 * Numerically evaluate a limit.
 */
export function evaluateLimit(
  expr: string,
  target: number,
  options: CalculusVisualizationOptions & { direction?: "left" | "right" | "both" }
): LimitResult {
  const { variable = "x", direction = "both" } = options;
  const f = compileExpression(expr);

  const sequence: { x: number; y: number }[] = [];
  const approaches = direction === "both" ? ["left", "right"] : [direction];
  const results: number[] = [];

  for (const dir of approaches) {
    const sign = dir === "left" ? -1 : 1;
    for (let i = 1; i <= 10; i++) {
      const h = sign * Math.pow(10, -i);
      const x = target + h;
      try {
        const y = f({ [variable]: x });
        if (isFinite(y)) {
          sequence.push({ x, y });
          if (i >= 8) results.push(y); // Use last few for limit estimate
        }
      } catch {
        // Skip undefined points
      }
    }
  }

  // Estimate limit from sequence
  let value: LimitResult["value"] = "Does not exist";
  if (results.length > 0) {
    const avg = results.reduce((a, b) => a + b, 0) / results.length;
    const variance = results.reduce((a, b) => a + (b - avg)**2, 0) / results.length;
    if (variance < 1e-6) {
      value = avg;
    } else if (Math.abs(avg) > 1e6) {
      value = avg > 0 ? "Infinity" : "-Infinity";
    }
  }

  return { value, direction, sequence };
}

/* ============================================================================
 * SERIES EXPANSIONS
 * ============================================================================ */

export interface SeriesResult {
  /** Series terms */
  terms: { n: number; term: string; value: number }[];
  /** Partial sums */
  partialSums: { n: number; sum: number }[];
  /** Convergence status */
  converges: boolean;
  /** Estimated sum */
  sum?: number;
}

/**
 * Evaluate a series sum numerically.
 */
export function evaluateSeries(
  termExpr: string, // term as function of n
  maxTerms: number = 100,
  tolerance: number = 1e-10
): SeriesResult {
  const nVar = "n";
  const termFn = compileExpression(termExpr);

  const terms: { n: number; term: string; value: number }[] = [];
  const partialSums: { n: number; sum: number }[] = [];
  let sum = 0;
  let converges = true;

  for (let n = 1; n <= maxTerms; n++) {
    try {
      const value = termFn({ [nVar]: n });
      if (!isFinite(value)) {
        converges = false;
        break;
      }

      terms.push({ n, term: termExpr.replace(/n/g, String(n)), value });
      sum += value;
      partialSums.push({ n, sum });

      if (Math.abs(value) < tolerance && n > 10) {
        // Terms becoming very small
        converges = true;
        break;
      }
    } catch {
      converges = false;
      break;
    }
  }

  return { terms, partialSums, converges, sum: converges ? sum : undefined };
}

/* ============================================================================
 * EXPORTS
 * ============================================================================ */

export const MathEnvironment = {
  // Expression evaluation
  evaluateExpression,
  compileExpression,

  // Equation solving
  newtonRaphson,
  bisection,
  secant,
  findRoots,

  // 2D plotting
  plot2D,

  // 3D plotting
  plot3D,
  plot3DParametric,

  // Geometry
  GeometryEngine,

  // Calculus
  tangentLine,
  areaUnderCurve,
  taylorSeries,
  evaluateLimit,

  // Series
  evaluateSeries,
};

export default MathEnvironment;