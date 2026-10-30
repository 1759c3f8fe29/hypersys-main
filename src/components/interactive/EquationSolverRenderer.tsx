import React, { useState, useMemo } from "react";
import { InteractiveComponent, EquationSolverComponent, RendererProps } from "../../lib/interactive-types";
import {
  newtonRaphson,
  bisection,
  secant,
  findRoots,
  compileExpression,
  evaluateExpression,
} from "../../lib/math-environment";
import { motion } from "framer-motion";

interface SolverResult {
  root: number;
  fRoot: number;
  iterations: number;
  converged: boolean;
  error?: string;
}

interface EquationSolverRendererProps extends RendererProps {
  component: EquationSolverComponent;
  instanceId?: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
}

function formatNumber(num: number, precision = 10): string {
  if (!isFinite(num)) return num > 0 ? "∞" : num < 0 ? "-∞" : "NaN";
  if (Math.abs(num) < 1e-10 && num !== 0) return num.toExponential(4);
  return Number(num.toFixed(precision)).toString();
}

function getFunctionLatex(expr: string, variable = "x"): string {
  return expr
    .replace(/\^/g, "^")
    .replace(/\*/g, "\\cdot ")
    .replace(/\//g, "\\over ")
    .replace(/sqrt/g, "\\sqrt")
    .replace(/sin/g, "\\sin")
    .replace(/cos/g, "\\cos")
    .replace(/tan/g, "\\tan")
    .replace(/log/g, "\\log")
    .replace(/exp/g, "\\exp")
    .replace(/pi/g, "\\pi")
    .replace(/e/g, "e");
}

export default function EquationSolverRenderer({
  component,
  instanceId,
  onUpdate,
}: EquationSolverRendererProps) {
  const [results, setResults] = useState<SolverResult[]>([]);
  const [method, setMethod] = useState<"auto" | "newton" | "bisection" | "secant">(component.method ?? "auto");
  const [initialGuess, setInitialGuess] = useState(component.initialGuess ?? 0);
  const [interval, setInterval] = useState<[number, number]>(component.interval ?? [-10, 10]);
  const [tolerance, setTolerance] = useState(component.tolerance ?? 1e-10);
  const [maxIterations, setMaxIterations] = useState(component.maxIterations ?? 100);
  const [findAll, setFindAll] = useState(component.findAllRoots ?? false);
  const [isSolving, setIsSolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const variable = component.variable || "x";

  const solve = async () => {
    setIsSolving(true);
    setError(null);

    try {
      const fn = compileExpression(component.expression);
      const f = (x: number) => fn({ [variable]: x });

      let newResults: SolverResult[] = [];

      if (findAll && component.interval) {
        newResults = findRoots(f, component.interval, 200);
      } else {
        let result: SolverResult;
        const selectedMethod = method === "auto" ? (component.interval ? "bisection" : "newton") : method;

        switch (selectedMethod) {
          case "newton": {
            const derivExpr = component.expression.replace(new RegExp(variable, "g"), `(${variable})`);
            // Use numeric derivative
            const df = (x: number) => {
              const h = 1e-7;
              return (f(x + h) - f(x - h)) / (2 * h);
            };
            result = newtonRaphson(f, df, { initialGuess, tolerance, maxIterations });
            break;
          }
          case "bisection":
            if (!component.interval) {
              throw new Error("Bisection requires interval");
            }
            result = bisection(f, { interval: component.interval, tolerance, maxIterations });
            break;
          case "secant":
            result = secant(f, { initialGuess, tolerance, maxIterations });
            break;
          default:
            result = { root: NaN, fRoot: NaN, iterations: 0, converged: false, error: "Unknown method" };
        }
        newResults = result.converged ? [result] : [];
      }

      setResults(newResults);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Solver error");
    } finally {
      setIsSolving(false);
    }
  };

  // Auto-solve on mount
  React.useEffect(() => {
    solve();
  }, []);

  const fn = useMemo(() => {
    try {
      return compileExpression(component.expression);
    } catch {
      return null;
    }
  }, [component.expression]);

  const f = useMemo(() => {
    if (!fn) return null;
    return (x: number) => fn({ [variable]: x });
  }, [fn, variable]);

  // Generate plot points for visualization
  const plotPoints = useMemo(() => {
    if (!f) return [];
    const [min, max] = interval;
    const points: { x: number; y: number }[] = [];
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const x = min + (max - min) * (i / steps);
      try {
        const y = f(x);
        if (isFinite(y) && Math.abs(y) < 100) {
          points.push({ x, y });
        }
      } catch {
        // Skip
      }
    }
    return points;
  }, [f, interval]);

  const xScale = (x: number, width: number, [xMin, xMax]: [number, number]) =>
    ((x - xMin) / (xMax - xMin)) * width;

  const yScale = (y: number, height: number, [yMin, yMax]: [number, number]) =>
    height - ((y - yMin) / (yMax - yMin)) * height;

  const allY = plotPoints.map((p) => p.y);
  const yMin = allY.length > 0 ? Math.min(...allY, 0) : -1;
  const yMax = allY.length > 0 ? Math.max(...allY, 0) : 1;
  const yRange = yMax - yMin || 1;

  return (
    <div className="equation-solver" style={{ fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Controls Panel */}
        <div style={{ flex: "1", minWidth: "300px", maxWidth: "400px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 600 }}>{component.title}</h3>
          {component.description && <p style={{ margin: "0 0 16px", color: "#666", fontSize: "14px" }}>{component.description}</p>}

          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
              Equation: f({variable}) = 0
            </label>
            <div
              style={{
                background: "#f5f5f5",
                padding: "8px 12px",
                borderRadius: "6px",
                fontFamily: "monospace",
                fontSize: "14px",
                overflow: "auto",
              }}
            >
              {component.expression}
            </div>
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as "auto" | "newton" | "bisection" | "secant")}
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
              >
                <option value="auto">Auto</option>
                <option value="newton">Newton-Raphson</option>
                <option value="bisection">Bisection</option>
                <option value="secant">Secant</option>
              </select>
            </div>

            {(method === "newton" || method === "secant" || method === "auto") && (
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                  Initial Guess
                </label>
                <input
                  type="number"
                  value={initialGuess}
                  onChange={(e) => setInitialGuess(Number(e.target.value))}
                  step="0.1"
                  style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                />
              </div>
            )}

            {(method === "bisection" || method === "auto") && (
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                  Interval [min, max]
                </label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="number"
                    value={interval[0]}
                    onChange={(e) => setInterval([Number(e.target.value), interval[1]] as [number, number])}
                    step="0.1"
                    style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    placeholder="min"
                  />
                  <input
                    type="number"
                    value={interval[1]}
                    onChange={(e) => setInterval([interval[0], Number(e.target.value)] as [number, number])}
                    step="0.1"
                    style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    placeholder="max"
                  />
                </div>
              </div>
            )}

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Tolerance
              </label>
              <input
                type="number"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
                step="1e-10"
                min="1e-15"
                max="1"
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
              />
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Max Iterations
              </label>
              <input
                type="number"
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
                min="1"
                max="10000"
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
              />
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={findAll}
                onChange={(e) => setFindAll(e.target.checked)}
              />
              Find all roots in interval
            </label>

            <button
              onClick={solve}
              disabled={isSolving}
              style={{
                width: "100%",
                padding: "10px",
                marginTop: "8px",
                background: "#2563eb",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontSize: "14px",
                fontWeight: 500,
                cursor: isSolving ? "not-allowed" : "pointer",
                opacity: isSolving ? 0.7 : 1,
              }}
            >
              {isSolving ? "Solving..." : "Solve"}
            </button>

            {error && (
              <div style={{ marginTop: "12px", padding: "8px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", color: "#dc2626", fontSize: "13px" }}>
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Results & Visualization Panel */}
        <div style={{ flex: "2", minWidth: "350px" }}>
          <div style={{ marginBottom: "16px" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Results</h4>
            {results.length === 0 ? (
              <div style={{ padding: "16px", background: "#f9fafb", borderRadius: "6px", color: "#6b7280", textAlign: "center" }}>
                {isSolving ? "Solving..." : "No roots found. Try adjusting the interval or method."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {results.map((r, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    style={{
                      padding: "12px",
                      background: r.converged ? "#f0fdf4" : "#fef2f2",
                      border: `1px solid ${r.converged ? "#bbf7d0" : "#fecaca"}`,
                      borderRadius: "8px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <span style={{ fontWeight: 600, fontSize: "14px" }}>
                        Root {i + 1}: {variable} = <span style={{ fontFamily: "monospace" }}>{formatNumber(r.root)}</span>
                      </span>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: 600,
                          background: r.converged ? "#dcfce7" : "#fee2e2",
                          color: r.converged ? "#166534" : "#dc2626",
                        }}
                      >
                        {r.converged ? "Converged" : "Did not converge"}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", fontSize: "13px" }}>
                      <div>
                        <span style={{ color: "#6b7280" }}>f(root):</span>{" "}
                        <span style={{ fontFamily: "monospace" }}>{formatNumber(r.fRoot)}</span>
                      </div>
                      <div>
                        <span style={{ color: "#6b7280" }}>Iterations:</span>{" "}
                        <span style={{ fontFamily: "monospace" }}>{r.iterations}</span>
                      </div>
                      <div>
                        <span style={{ color: "#6b7280" }}>Tolerance:</span>{" "}
                        <span style={{ fontFamily: "monospace" }}>{tolerance}</span>
                      </div>
                    </div>
                    {r.error && (
                      <div style={{ marginTop: "8px", fontSize: "12px", color: "#dc2626" }}>{r.error}</div>
                    )}
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          {/* Function Visualization */}
          <div>
            <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Function Plot</h4>
            <div style={{ position: "relative", height: "280px", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
              <svg width="100%" height="100%" style={{ display: "block" }}>
                <defs>
                  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L0,6 L9,3 z" fill="#6b7280" />
                  </marker>
                </defs>

                {/* Axes */}
                <line
                  x1={60}
                  y1={20}
                  x2={60}
                  y2={260}
                  stroke="#9ca3af"
                  strokeWidth={1}
                  markerEnd="url(#arrow)"
                />
                <line
                  x1={60}
                  y1={140}
                  x2={580}
                  y2={140}
                  stroke="#9ca3af"
                  strokeWidth={1}
                  markerEnd="url(#arrow)"
                />

                {/* Zero line */}
                <line
                  x1={60}
                  y1={yScale(0, 240, [yMin, yMax]) + 20}
                  x2={580}
                  y2={yScale(0, 240, [yMin, yMax]) + 20}
                  stroke="#e5e7eb"
                  strokeWidth={1}
                  strokeDasharray="4,4"
                />

                {/* Axis labels */}
                <text x={30} y={145} textAnchor="end" fontSize={11} fill="#6b7280">0</text>
                <text x={60} y={275} textAnchor="middle" fontSize={11} fill="#6b7280">{formatNumber(interval[0])}</text>
                <text x={580} y={275} textAnchor="middle" fontSize={11} fill="#6b7280">{formatNumber(interval[1])}</text>
                <text x={30} y={25} textAnchor="end" fontSize={11} fill="#6b7280">{formatNumber(yMax)}</text>
                <text x={30} y={255} textAnchor="end" fontSize={11} fill="#6b7280">{formatNumber(yMin)}</text>

                {/* Function curve */}
                {plotPoints.length > 1 && (
                  <path
                    d={plotPoints
                      .map((p, i) =>
                        `${i === 0 ? "M" : "L"} ${xScale(p.x, 520, interval as [number, number]) + 60} ${yScale(p.y, 240, [yMin, yMax]) + 20}`
                      )
                      .join(" ")}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth={2}
                  />
                )}

                {/* Roots */}
                {results.map((r, i) =>
                  r.converged &&
                  r.root >= interval[0] &&
                  r.root <= interval[1] && (
                    <g key={i}>
                      <circle
                        cx={xScale(r.root, 520, interval as [number, number]) + 60}
                        cy={yScale(0, 240, [yMin, yMax]) + 20}
                        r={6}
                        fill="#22c55e"
                        stroke="white"
                        strokeWidth={2}
                      />
                      <text
                        x={xScale(r.root, 520, interval) + 60}
                        y={yScale(0, 240, [yMin, yMax]) + 35}
                        textAnchor="middle"
                        fontSize={11}
                        fill="#166534"
                        fontWeight={600}
                      >
                        {formatNumber(r.root)}
                      </text>
                    </g>
                  )
                )}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}