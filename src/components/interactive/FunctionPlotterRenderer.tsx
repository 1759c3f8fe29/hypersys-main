import React, { useMemo, useState, useEffect } from "react";
import { FunctionPlotterComponent, RendererProps } from "../../lib/interactive-types";
import { plot2D, compileExpression } from "../../lib/math-environment";
import { motion, useReducedMotion } from "framer-motion";

interface FunctionPlotterRendererProps extends RendererProps {
  component: FunctionPlotterComponent;
  instanceId?: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
}

function formatNumber(num: number, precision = 4): string {
  if (!isFinite(num)) return num > 0 ? "∞" : num < 0 ? "-∞" : "NaN";
  if (Math.abs(num) < 1e-4 && num !== 0) return num.toExponential(2);
  return Number(num.toFixed(precision)).toString();
}

const plotTypeOptions = [
  { value: "cartesian", label: "Cartesian (y = f(x))" },
  { value: "parametric", label: "Parametric (x = f(t), y = g(t))" },
  { value: "polar", label: "Polar (r = f(θ))" },
] as const;

export default function FunctionPlotterRenderer({
  component,
  instanceId,
  onUpdate,
}: FunctionPlotterRendererProps) {
  const [plotType, setPlotType] = useState(component.plotType || "cartesian");
  const [domain, setDomain] = useState(component.domain);
  const [yExpression, setYExpression] = useState(component.yExpression || "");
  const [variable, setVariable] = useState(component.variable || "x");
  const [samples, setSamples] = useState(component.samples || 500);
  const [showAsymptotes, setShowAsymptotes] = useState(component.showAsymptotes || false);
  const [yRange, setYRange] = useState<[number, number] | undefined>(component.yRange);
  const [replotTrigger, setReplotTrigger] = useState(0);
  const prefersReducedMotion = useReducedMotion();

  const result = useMemo(() => {
    try {
      return plot2D(component.expression, {
        type: plotType,
        domain,
        samples,
        yExpr: yExpression,
        variable,
      });
    } catch (err) {
      return null;
    }
  }, [component.expression, plotType, domain, samples, yExpression, variable, replotTrigger]);

  const points = result?.points || [];
  const asymptotes = result?.asymptotes || [];

  const xMin = domain[0];
  const xMax = domain[1];
  const allY = points.map((p) => p.y);
  const dataYMin = allY.length > 0 ? Math.min(...allY) : -1;
  const dataYMax = allY.length > 0 ? Math.max(...allY) : 1;
  const finalYMin = yRange ? yRange[0] : dataYMin - (dataYMax - dataYMin) * 0.1;
  const finalYMax = yRange ? yRange[1] : dataYMax + (dataYMax - dataYMin) * 0.1;
  const ySpan = finalYMax - finalYMin || 1;

  const width = 640;
  const height = 380;
  const margin = { left: 64, right: 24, top: 24, bottom: 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const xScale = (x: number) => margin.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (y: number) => margin.top + plotHeight - ((y - finalYMin) / ySpan) * plotHeight;

  const transition = prefersReducedMotion ? { duration: 0 } : { duration: 0.3, ease: [0.16, 1, 0.3, 1] };

  return (
    <div className="function-plotter" style={{
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
          style={{ flex: "1", minWidth: "300px", maxWidth: "380px" }}
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
              f({variable}) =
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

          {plotType === "parametric" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={transition}
              style={{ marginBottom: "16px" }}
            >
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>
                y({variable}) =
              </label>
              <input
                type="text"
                value={yExpression}
                onChange={(e) => { setYExpression(e.target.value); setReplotTrigger(t => t + 1); }}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-lg, 8px)",
                  border: "1px solid var(--border-1, #e5e7eb)",
                  fontSize: "var(--text-base, 1rem)",
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  background: "var(--surface-1, white)",
                  color: "var(--fg-primary, #111827)",
                  outline: "none",
                  transition: "border-color 0.15s, box-shadow 0.15s",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                placeholder="e.g., sin(t)"
              />
            </motion.div>
          )}

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>Plot Type</label>
              <select
                value={plotType}
                onChange={(e) => { setPlotType(e.target.value as "cartesian" | "parametric" | "polar"); setReplotTrigger(t => t + 1); }}
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
                {plotTypeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>
                Domain [{variable} min, max]
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="number"
                  value={domain[0]}
                  onChange={(e) => { setDomain([Number(e.target.value), domain[1]]); setReplotTrigger(t => t + 1); }}
                  step="0.1"
                  style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                  placeholder="min"
                />
                <input
                  type="number"
                  value={domain[1]}
                  onChange={(e) => { setDomain([domain[0], Number(e.target.value)]); setReplotTrigger(t => t + 1); }}
                  step="0.1"
                  style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                  placeholder="max"
                />
              </div>
            </div>

            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>
                Variable
              </label>
              <input
                type="text"
                value={variable}
                onChange={(e) => { setVariable(e.target.value); setReplotTrigger(t => t + 1); }}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-lg, 8px)",
                  border: "1px solid var(--border-1, #e5e7eb)",
                  fontSize: "var(--text-base, 1rem)",
                  background: "var(--surface-1, white)",
                  color: "var(--fg-primary, #111827)",
                  outline: "none",
                  maxWidth: "60px",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                maxLength={1}
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
                Samples
              </label>
              <input
                type="number"
                value={samples}
                onChange={(e) => { setSamples(Math.max(10, Math.min(10000, Number(e.target.value)))); setReplotTrigger(t => t + 1); }}
                min="10"
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
                checked={showAsymptotes}
                onChange={(e) => { setShowAsymptotes(e.target.checked); setReplotTrigger(t => t + 1); }}
                style={{
                  width: "18px",
                  height: "18px",
                  accentColor: "var(--primary-500, #2563eb)",
                  cursor: "pointer",
                }}
              />
              <span>Show asymptotes</span>
            </label>

            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>
                Y-Range (optional) [min, max]
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="number"
                  value={yRange?.[0] || ""}
                  onChange={(e) => setYRange([Number(e.target.value), yRange?.[1] ?? 0])}
                  step="0.1"
                  placeholder="auto"
                  style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                />
                <input
                  type="number"
                  value={yRange?.[1] || ""}
                  onChange={(e) => setYRange([yRange?.[0] ?? 0, Number(e.target.value)])}
                  step="0.1"
                  placeholder="auto"
                  style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                />
              </div>
            </div>
          </div>

          <div style={{ marginTop: "16px", padding: "12px", background: "var(--surface-2, #f9fafb)", borderRadius: "var(--radius-lg, 8px)", fontSize: "var(--text-sm, 0.875rem)", border: "1px solid var(--border-1, #e5e7eb)" }}>
            <strong>Points:</strong> {points.length} |{" "}
            <strong>Asymptotes:</strong> {asymptotes.length}
          </div>
        </motion.div>

        {/* Plot Panel */}
        <motion.div
          style={{ flex: "2", minWidth: "400px" }}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={transition}
        >
          <div style={{ position: "relative", width: "100%" }}>
            <svg width={width} height={height} style={{ background: "var(--surface-2, #fafafa)", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)" }}>
              <defs>
                <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L0,6 L9,3 z" fill="var(--fg-muted, #6b7280)" />
                </marker>
                <pattern id="gridPattern" width="50" height="50" patternUnits="userSpaceOnUse">
                  <path d="M 50 0 L 0 0 0 50" fill="none" stroke="var(--border-1, #e5e7eb)" strokeWidth="0.5" />
                </pattern>
              </defs>

              {/* Grid */}
              <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} fill="url(#gridPattern)" />

              {/* Axes */}
              <line
                x1={margin.left}
                y1={margin.top}
                x2={margin.left}
                y2={margin.top + plotHeight}
                stroke="var(--fg-muted, #6b7280)"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
              <line
                x1={margin.left}
                y1={yScale(0)}
                x2={margin.left + plotWidth}
                y2={yScale(0)}
                stroke="var(--fg-muted, #6b7280)"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />

              {/* X-axis ticks and labels */}
              {(() => {
                const ticks = 5;
                return Array.from({ length: ticks + 1 }, (_, i) => {
                  const x = xMin + (xMax - xMin) * (i / ticks);
                  const sx = xScale(x);
                  return (
                    <g key={i}>
                      <line x1={sx} y1={yScale(0) - 5} x2={sx} y2={yScale(0) + 5} stroke="var(--fg-muted, #6b7280)" strokeWidth={1} />
                      {i !== 0 && i !== ticks && <line x1={sx} y1={margin.top} x2={sx} y2={margin.top + plotHeight} stroke="var(--border-1, #e5e7eb)" strokeWidth={0.5} />}
                      <text x={sx} y={yScale(0) + 25} textAnchor="middle" fontSize={11} fill="var(--fg-muted, #6b7280)">{formatNumber(x)}</text>
                    </g>
                  );
                });
              })()}

              {/* Y-axis ticks and labels */}
              {(() => {
                const ticks = 5;
                return Array.from({ length: ticks + 1 }, (_, i) => {
                  const y = finalYMin + ySpan * (i / ticks);
                  const sy = yScale(y);
                  return (
                    <g key={i}>
                      <line x1={margin.left - 5} y1={sy} x2={margin.left + 5} y2={sy} stroke="var(--fg-muted, #6b7280)" strokeWidth={1} />
                      {i !== 0 && i !== ticks && <line x1={margin.left} y1={sy} x2={margin.left + plotWidth} y2={sy} stroke="var(--border-1, #e5e7eb)" strokeWidth={0.5} />}
                      <text x={margin.left - 10} y={sy + 4} textAnchor="end" fontSize={11} fill="var(--fg-muted, #6b7280)">{formatNumber(y)}</text>
                    </g>
                  );
                });
              })()}

              {/* Asymptotes */}
              {showAsymptotes &&
                asymptotes.map((a, i) => (
                  <line
                    key={i}
                    x1={xScale(a)}
                    y1={margin.top}
                    x2={xScale(a)}
                    y2={margin.top + plotHeight}
                    stroke="var(--error-500, #ef4444)"
                    strokeWidth={1}
                    strokeDasharray="4,4"
                    opacity={0.7}
                  />
                ))}

              {/* Function curve */}
              {points.length > 1 && (
                <motion.path
                  d={points
                    .map((p, i) =>
                      `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`
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

              {/* Points on curve (for hover) */}
              {points.map((p, i) =>
                i % Math.max(1, Math.floor(points.length / 30)) === 0 && (
                  <circle
                    key={i}
                    cx={xScale(p.x)}
                    cy={yScale(p.y)}
                    r={2}
                    fill="var(--primary-500, #2563eb)"
                    opacity={0.6}
                  />
                )
              )}
            </svg>
          </div>

          {/* Info panel */}
          <div style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              style={{ padding: "12px", background: "var(--success-bg, #f0fdf4)", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--success-border, #bbf7d0)" }}
            >
              <div style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--success-700, #166534)", textTransform: "uppercase", letterSpacing: "0.5px" }}>X Range</div>
              <div style={{ fontSize: "var(--text-base, 1rem)", fontWeight: 600, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                [{formatNumber(xMin)}, {formatNumber(xMax)}]
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              style={{ padding: "12px", background: "var(--primary-bg, #eff6ff)", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--primary-border, #bfdbfe)" }}
            >
              <div style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--primary-700, #1e40af)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Y Range</div>
              <div style={{ fontSize: "var(--text-base, 1rem)", fontWeight: 600, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                [{formatNumber(finalYMin)}, {formatNumber(finalYMax)}]
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              style={{ padding: "12px", background: "var(--purple-bg, #faf5ff)", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--purple-border, #e9d5ff)" }}
            >
              <div style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--purple-700, #7c3aed)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Plot Type</div>
              <div style={{ fontSize: "var(--text-base, 1rem)", fontWeight: 600, textTransform: "capitalize" }}>{plotType}</div>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}