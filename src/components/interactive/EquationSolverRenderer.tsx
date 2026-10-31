import React, { useState, useMemo, useEffect } from "react";
import { InteractiveComponent, EquationSolverComponent, RendererProps } from "../../lib/interactive-types";
import {
  newtonRaphson,
  bisection,
  secant,
  findRoots,
  compileExpression,
} from "../../lib/math-environment";
import { motion, useReducedMotion } from "framer-motion";

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

const methodOptions = [
  { value: "auto", label: "Auto (best fit)" },
  { value: "newton", label: "Newton-Raphson" },
  { value: "bisection", label: "Bisection" },
  { value: "secant", label: "Secant" },
] as const;

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
  const [solveTrigger, setSolveTrigger] = useState(0);

  const variable = component.variable || "x";
  const prefersReducedMotion = useReducedMotion();

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
            const df = (x: number) => {
              const h = 1e-7;
              return (f(x + h) - f(x - h)) / (2 * h);
            };
            result = newtonRaphson(f, df, { initialGuess, tolerance, maxIterations });
            break;
          }
          case "bisection":
            if (!component.interval) throw new Error("Bisection requires interval");
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

  useEffect(() => { solve(); }, [solveTrigger]);
  useEffect(() => { solve(); }, []);

  const fn = useMemo(() => {
    try { return compileExpression(component.expression); } catch { return null; }
  }, [component.expression]);

  const f = useMemo(() => fn ? (x: number) => fn({ [variable]: x }) : null, [fn, variable]);

  const plotPoints = useMemo(() => {
    if (!f) return [];
    const [min, max] = interval;
    const points: { x: number; y: number }[] = [];
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const x = min + (max - min) * (i / steps);
      try {
        const y = f(x);
        if (isFinite(y) && Math.abs(y) < 100) points.push({ x, y });
      } catch { /* skip */ }
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

  const transition = prefersReducedMotion ? { duration: 0 } : { duration: 0.3, ease: [0.16, 1, 0.3, 1] };

  return (
    <div className="equation-solver" style={{
      fontFamily: "var(--font-sans, system-ui, sans-serif)",
      background: "var(--surface-1, white)",
      border: "1px solid var(--border-1, #e5e7eb)",
      borderRadius: "var(--radius-xl, 12px)",
      padding: "16px",
      boxShadow: "var(--shadow-sm, 0 1px 2px 0 rgb(0 0 0 / 0.05))",
    }}>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Controls Panel */}
        <motion.div
          style={{ flex: "1", minWidth: "300px", maxWidth: "400px" }}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={transition}
        >
          <h3 style={{
            margin: "0 0 4px",
            fontSize: "var(--text-lg, 1.125rem)",
            fontWeight: 600,
            color: "var(--fg-primary, #111827)"
          }}>{component.title}</h3>
          {component.description && <p style={{
            margin: "0 0 16px",
            color: "var(--fg-muted, #6b7280)",
            fontSize: "var(--text-sm, 0.875rem)",
            lineHeight: 1.5
          }}>{component.description}</p>}

          <div style={{ marginBottom: "16px" }}>
            <label style={{
              display: "block",
              marginBottom: "6px",
              fontSize: "var(--text-sm, 0.875rem)",
              fontWeight: 500,
              color: "var(--fg-secondary, #374151)"
            }}>
              Equation: f({variable}) = 0
            </label>
            <div
              style={{
                background: "var(--surface-2, #f9fafb)",
                padding: "10px 12px",
                borderRadius: "var(--radius-lg, 8px)",
                fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                fontSize: "var(--text-base, 1rem)",
                overflow: "auto",
                border: "1px solid var(--border-1, #e5e7eb)",
              }}
            >
              {component.expression}
            </div>
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as "auto" | "newton" | "bisection" | "secant")}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-lg, 8px)",
                  border: "1px solid var(--border-1, #e5e7eb)",
                  fontSize: "var(--text-base, 1rem)",
                  background: "var(--surface-1, white)",
                  color: "var(--fg-primary, #111827)",
                  cursor: "pointer",
                  outline: "none",
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"}
                onBlur={(e) => e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"}
              >
                {methodOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {(method === "newton" || method === "secant" || method === "auto") && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={transition}
              >
                <label style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "var(--text-sm, 0.875rem)",
                  fontWeight: 500,
                  color: "var(--fg-secondary, #374151)"
                }}>
                  Initial Guess
                </label>
                <input
                  type="number"
                  value={initialGuess}
                  onChange={(e) => setInitialGuess(Number(e.target.value))}
                  step="0.1"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "var(--radius-lg, 8px)",
                    border: "1px solid var(--border-1, #e5e7eb)",
                    fontSize: "var(--text-base, 1rem)",
                    background: "var(--surface-1, white)",
                    color: "var(--fg-primary, #111827)",
                    outline: "none",
                    transition: "border-color 0.15s, box-shadow 0.15s",
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                />
              </motion.div>
            )}

            {(method === "bisection" || method === "auto") && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={transition}
              >
                <label style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "var(--text-sm, 0.875rem)",
                  fontWeight: 500,
                  color: "var(--fg-secondary, #374151)"
                }}>
                  Interval [min, max]
                </label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="number"
                    value={interval[0]}
                    onChange={(e) => setInterval([Number(e.target.value), interval[1]] as [number, number])}
                    step="0.1"
                    style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none", placeholder: "min" }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                    placeholder="min"
                  />
                  <input
                    type="number"
                    value={interval[1]}
                    onChange={(e) => setInterval([interval[0], Number(e.target.value)] as [number, number])}
                    step="0.1"
                    style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none", placeholder: "max" }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                    placeholder="max"
                  />
                </div>
              </motion.div>
            )}

            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>
                Tolerance
              </label>
              <input
                type="number"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
                step="1e-10"
                min="1e-15"
                max="1"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-lg, 8px)",
                  border: "1px solid var(--border-1, #e5e7eb)",
                  fontSize: "var(--text-base, 1rem)",
                  background: "var(--surface-1, white)",
                  color: "var(--fg-primary, #111827)",
                  outline: "none",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
              />
            </div>

            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>
                Max Iterations
              </label>
              <input
                type="number"
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
                min="1"
                max="10000"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-lg, 8px)",
                  border: "1px solid var(--border-1, #e5e7eb)",
                  fontSize: "var(--text-base, 1rem)",
                  background: "var(--surface-1, white)",
                  color: "var(--fg-primary, #111827)",
                  outline: "none",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
              />
            </div>

            <label style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              fontSize: "var(--text-sm, 0.875rem)",
              color: "var(--fg-secondary, #374151)",
              cursor: "pointer",
            }}>
              <input
                type="checkbox"
                checked={findAll}
                onChange={(e) => setFindAll(e.target.checked)}
                style={{
                  width: "18px",
                  height: "18px",
                  accentColor: "var(--primary-500, #2563eb)",
                  cursor: "pointer",
                }}
              />
              <span>Find all roots in interval</span>
            </label>

            <motion.button
              onClick={() => setSolveTrigger(t => t + 1)}
              disabled={isSolving}
              whileTap={{ scale: 0.98 }}
              style={{
                width: "100%",
                padding: "12px 16px",
                marginTop: "8px",
                background: "var(--primary-500, #2563eb)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius-lg, 8px)",
                fontSize: "var(--text-base, 1rem)",
                fontWeight: 600,
                cursor: isSolving ? "not-allowed" : "pointer",
                opacity: isSolving ? 0.7 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {isSolving ? "Solving..." : "Solve"}
            </motion.button>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  marginTop: "12px",
                  padding: "12px",
                  background: "var(--error-bg, #fef2f2)",
                  border: "1px solid var(--error-border, #fecaca)",
                  borderRadius: "var(--radius-lg, 8px)",
                  color: "var(--error-fg, #dc2626)",
                  fontSize: "var(--text-sm, 0.875rem)"
                }}
                role="alert"
              >
                {error}
              </motion.div>
            )}
          </div>
        </motion.div>

        {/* Results & Visualization Panel */}
        <motion.div
          style={{ flex: "2", minWidth: "350px" }}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={transition}
        >
          <div style={{ marginBottom: "16px" }}>
            <h4 style={{
              margin: "0 0 12px",
              fontSize: "var(--text-base, 1rem)",
              fontWeight: 600,
              color: "var(--fg-primary, #111827)"
            }}>Results</h4>
            {results.length === 0 ? (
              <div style={{
                padding: "20px",
                background: "var(--surface-2, #f9fafb)",
                borderRadius: "var(--radius-lg, 8px)",
                color: "var(--fg-muted, #6b7280)",
                textAlign: "center",
                border: "1px dashed var(--border-1, #e5e7eb)",
              }}>
                {isSolving ? "Solving..." : "No roots found. Try adjusting the interval or method."}
              </div>
            ) : (
              <motion.div
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, delay: 0.1 }}
              >
                {results.map((r, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    style={{
                      padding: "14px 16px",
                      background: r.converged ? "var(--success-bg, #f0fdf4)" : "var(--error-bg, #fef2f2)",
                      border: `1px solid ${r.converged ? "var(--success-border, #bbf7d0)" : "var(--error-border, #fecaca)"}`,
                      borderRadius: "var(--radius-lg, 8px)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
                      <span style={{ fontWeight: 600, fontSize: "var(--text-base, 1rem)", color: "var(--fg-primary, #111827)" }}>
                        Root {i + 1}: {variable} ={" "}
                        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--primary-600, #1d4ed8)" }}>{formatNumber(r.root)}</span>
                      </span>
                      <span
                        style={{
                          padding: "4px 10px",
                          borderRadius: "var(--radius-full, 9999px)",
                          fontSize: "var(--text-xs, 0.75rem)",
                          fontWeight: 600,
                          background: r.converged ? "var(--success-bg, #dcfce7)" : "var(--error-bg, #fee2e2)",
                          color: r.converged ? "var(--success-fg, #166534)" : "var(--error-fg, #dc2626)",
                        }}
                      >
                        {r.converged ? "Converged" : "Did not converge"}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", fontSize: "var(--text-sm, 0.875rem)" }}>
                      <div>
                        <span style={{ color: "var(--fg-muted, #6b7280)" }}>f(root):</span>{" "}
                        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{formatNumber(r.fRoot)}</span>
                      </div>
                      <div>
                        <span style={{ color: "var(--fg-muted, #6b7280)" }}>Iterations:</span>{" "}
                        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{r.iterations}</span>
                      </div>
                      <div>
                        <span style={{ color: "var(--fg-muted, #6b7280)" }}>Tolerance:</span>{" "}
                        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{tolerance}</span>
                      </div>
                    </div>
                    {r.error && (
                      <div style={{ marginTop: "8px", fontSize: "var(--text-xs, 0.75rem)", color: "var(--error-fg, #dc2626)" }}>{r.error}</div>
                    )}
                  </motion.div>
                ))}
              </motion.div>
            )}
          </div>

          {/* Function Visualization */}
          <div>
            <h4 style={{
              margin: "0 0 12px",
              fontSize: "var(--text-base, 1rem)",
              fontWeight: 600,
              color: "var(--fg-primary, #111827)"
            }}>Function Plot</h4>
            <div style={{ position: "relative", height: "300px", background: "var(--surface-2, #fafafa)", border: "1px solid var(--border-1, #e5e7eb)", borderRadius: "var(--radius-lg, 8px)" }}>
              <svg width="100%" height="100%" style={{ display: "block" }} viewBox="0 0 640 300" preserveAspectRatio="none">
                <defs>
                  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L0,6 L9,3 z" fill="var(--fg-muted, #6b7280)" />
                  </marker>
                </defs>

                {/* Axes */}
                <line
                  x1={60}
                  y1={20}
                  x2={60}
                  y2={280}
                  stroke="var(--fg-muted, #9ca3af)"
                  strokeWidth={1.5}
                  markerEnd="url(#arrow)"
                />
                <line
                  x1={60}
                  y1={150}
                  x2={620}
                  y2={150}
                  stroke="var(--fg-muted, #9ca3af)"
                  strokeWidth={1.5}
                  markerEnd="url(#arrow)"
                />

                {/* Zero line */}
                <line
                  x1={60}
                  y1={yScale(0, 260, [yMin, yMax]) + 20}
                  x2={620}
                  y2={yScale(0, 260, [yMin, yMax]) + 20}
                  stroke="var(--border-1, #e5e7eb)"
                  strokeWidth={1}
                  strokeDasharray="4,4"
                />

                {/* Grid lines */}
                {(() => {
                  const ticks = 5;
                  return Array.from({ length: ticks + 1 }, (_, i) => {
                    const x = interval[0] + (interval[1] - interval[0]) * (i / ticks);
                    const sx = xScale(x, 560, interval as [number, number]) + 60;
                    return (
                      <React.Fragment key={`grid-x-${i}`}>
                        <line x1={sx} y1={20} x2={sx} y2={280} stroke="var(--border-1, #e5e7eb)" strokeWidth={0.5} />
                        <text x={sx} y={290} textAnchor="middle" fontSize={11} fill="var(--fg-muted, #6b7280)">{formatNumber(x)}</text>
                      </React.Fragment>
                    );
                  });
                })()}
                {(() => {
                  const ticks = 5;
                  return Array.from({ length: ticks + 1 }, (_, i) => {
                    const y = yMin + (yMax - yMin) * (i / ticks);
                    const sy = yScale(y, 260, [yMin, yMax]) + 20;
                    return (
                      <React.Fragment key={`grid-y-${i}`}>
                        <line x1={60} y1={sy} x2={620} y2={sy} stroke="var(--border-1, #e5e7eb)" strokeWidth={0.5} />
                        <text x={45} y={sy + 4} textAnchor="end" fontSize={11} fill="var(--fg-muted, #6b7280)">{formatNumber(y)}</text>
                      </React.Fragment>
                    );
                  });
                })()}

                {/* Function curve */}
                {plotPoints.length > 1 && (
                  <motion.path
                    d={plotPoints
                      .map((p, i) =>
                        `${i === 0 ? "M" : "L"} ${xScale(p.x, 560, interval as [number, number]) + 60} ${yScale(p.y, 260, [yMin, yMax]) + 20}`
                      )
                      .join(" ")}
                    fill="none"
                    stroke="var(--primary-500, #2563eb)"
                    strokeWidth={2.5}
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: prefersReducedMotion ? 0 : 0.8, ease: "easeOut" }}
                  />
                )}

                {/* Roots */}
                {results.map((r, i) =>
                  r.converged &&
                  r.root >= interval[0] &&
                  r.root <= interval[1] && (
                    <g key={i}>
                      <circle
                        cx={xScale(r.root, 560, interval as [number, number]) + 60}
                        cy={yScale(0, 260, [yMin, yMax]) + 20}
                        r={8}
                        fill="var(--success-500, #22c55e)"
                        stroke="var(--surface-1, white)"
                        strokeWidth={3}
                      />
                      <text
                        x={xScale(r.root, 560, interval) + 60}
                        y={yScale(0, 260, [yMin, yMax]) + 40}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--success-700, #166534)"
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
        </motion.div>
      </div>
    </div>
  );
}