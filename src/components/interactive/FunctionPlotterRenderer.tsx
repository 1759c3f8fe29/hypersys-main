import React, { useMemo, useState } from "react";
import { FunctionPlotterComponent, RendererProps } from "../../lib/interactive-types";
import { plot2D, compileExpression } from "../../lib/math-environment";
import { motion } from "framer-motion";

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

export default function FunctionPlotterRenderer({
  component,
  instanceId,
}: FunctionPlotterRendererProps) {
  const [plotType, setPlotType] = useState(component.plotType || "cartesian");
  const [domain, setDomain] = useState(component.domain);
  const [yExpression, setYExpression] = useState(component.yExpression || "");
  const [variable, setVariable] = useState(component.variable || "x");
  const [samples, setSamples] = useState(component.samples || 500);
  const [showAsymptotes, setShowAsymptotes] = useState(component.showAsymptotes || false);
  const [yRange, setYRange] = useState<[number, number] | undefined>(component.yRange);

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
  }, [component.expression, plotType, domain, samples, yExpression, variable]);

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

  const width = 600;
  const height = 360;
  const margin = { left: 60, right: 20, top: 20, bottom: 50 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const xScale = (x: number) => margin.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (y: number) => margin.top + plotHeight - ((y - finalYMin) / ySpan) * plotHeight;

  return (
    <div className="function-plotter" style={{ fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Controls Panel */}
        <div style={{ flex: "1", minWidth: "280px", maxWidth: "350px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 600 }}>{component.title}</h3>
          {component.description && <p style={{ margin: "0 0 16px", color: "#666", fontSize: "14px" }}>{component.description}</p>}

          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
              f({variable}) =
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

          {plotType === "parametric" && (
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                y({variable}) =
              </label>
              <input
                type="text"
                value={yExpression}
                onChange={(e) => setYExpression(e.target.value)}
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px", fontFamily: "monospace" }}
                placeholder="e.g., sin(t)"
              />
            </div>
          )}

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>Plot Type</label>
              <select
                value={plotType}
                onChange={(e) => setPlotType(e.target.value as "cartesian" | "parametric" | "polar")}
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
              >
                <option value="cartesian">Cartesian (y = f(x))</option>
                <option value="parametric">Parametric (x = f(t), y = g(t))</option>
                <option value="polar">Polar (r = f(θ))</option>
              </select>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Domain [{variable} min, max]
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="number"
                  value={domain[0]}
                  onChange={(e) => setDomain([Number(e.target.value), domain[1]])}
                  step="0.1"
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                  placeholder="min"
                />
                <input
                  type="number"
                  value={domain[1]}
                  onChange={(e) => setDomain([domain[0], Number(e.target.value)])}
                  step="0.1"
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                  placeholder="max"
                />
              </div>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Variable
              </label>
              <input
                type="text"
                value={variable}
                onChange={(e) => setVariable(e.target.value)}
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                maxLength={1}
              />
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Samples
              </label>
              <input
                type="number"
                value={samples}
                onChange={(e) => setSamples(Math.max(10, Math.min(10000, Number(e.target.value))))}
                min="10"
                max="10000"
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
              />
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={showAsymptotes}
                onChange={(e) => setShowAsymptotes(e.target.checked)}
              />
              Show asymptotes
            </label>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Y-Range (optional) [min, max]
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="number"
                  value={yRange?.[0] || ""}
                  onChange={(e) => setYRange([Number(e.target.value), yRange?.[1] ?? 0])}
                  step="0.1"
                  placeholder="auto"
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                />
                <input
                  type="number"
                  value={yRange?.[1] || ""}
                  onChange={(e) => setYRange([yRange?.[0] ?? 0, Number(e.target.value)])}
                  step="0.1"
                  placeholder="auto"
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                />
              </div>
            </div>
          </div>

          <div style={{ marginTop: "16px", padding: "12px", background: "#f9fafb", borderRadius: "8px", fontSize: "13px" }}>
            <strong>Points:</strong> {points.length} |{" "}
            <strong>Asymptotes:</strong> {asymptotes.length}
          </div>
        </div>

        {/* Plot Panel */}
        <div style={{ flex: "2", minWidth: "400px" }}>
          <div style={{ position: "relative", width: "100%" }}>
            <svg width={width} height={height} style={{ background: "#fafafa", borderRadius: "8px", border: "1px solid #e5e7eb" }}>
              <defs>
                <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L0,6 L9,3 z" fill="#6b7280" />
                </marker>
                <pattern id="gridPattern" width="50" height="50" patternUnits="userSpaceOnUse">
                  <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#e5e7eb" strokeWidth="0.5" />
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
                stroke="#6b7280"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
              <line
                x1={margin.left}
                y1={yScale(0)}
                x2={margin.left + plotWidth}
                y2={yScale(0)}
                stroke="#6b7280"
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
                      <line x1={sx} y1={yScale(0) - 5} x2={sx} y2={yScale(0) + 5} stroke="#6b7280" strokeWidth={1} />
                      {i !== 0 && i !== ticks && <line x1={sx} y1={margin.top} x2={sx} y2={margin.top + plotHeight} stroke="#e5e7eb" strokeWidth={0.5} />}
                      <text x={sx} y={yScale(0) + 25} textAnchor="middle" fontSize={11} fill="#6b7280">{formatNumber(x)}</text>
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
                      <line x1={margin.left - 5} y1={sy} x2={margin.left + 5} y2={sy} stroke="#6b7280" strokeWidth={1} />
                      {i !== 0 && i !== ticks && <line x1={margin.left} y1={sy} x2={margin.left + plotWidth} y2={sy} stroke="#e5e7eb" strokeWidth={0.5} />}
                      <text x={margin.left - 10} y={sy + 4} textAnchor="end" fontSize={11} fill="#6b7280">{formatNumber(y)}</text>
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
                    stroke="#ef4444"
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
                  stroke="#2563eb"
                  strokeWidth={2.5}
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
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
                    fill="#2563eb"
                    opacity={0.6}
                  />
                )
              )}
            </svg>
          </div>

          {/* Info panel */}
          <div style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
            <div style={{ padding: "12px", background: "#f0fdf4", borderRadius: "8px", border: "1px solid #bbf7d0" }}>
              <div style={{ fontSize: "11px", color: "#166534", textTransform: "uppercase", letterSpacing: "0.5px" }}>X Range</div>
              <div style={{ fontSize: "14px", fontWeight: 600, fontFamily: "monospace" }}>
                [{formatNumber(xMin)}, {formatNumber(xMax)}]
              </div>
            </div>
            <div style={{ padding: "12px", background: "#eff6ff", borderRadius: "8px", border: "1px solid #bfdbfe" }}>
              <div style={{ fontSize: "11px", color: "#1e40af", textTransform: "uppercase", letterSpacing: "0.5px" }}>Y Range</div>
              <div style={{ fontSize: "14px", fontWeight: 600, fontFamily: "monospace" }}>
                [{formatNumber(finalYMin)}, {formatNumber(finalYMax)}]
              </div>
            </div>
            <div style={{ padding: "12px", background: "#faf5ff", borderRadius: "8px", border: "1px solid #e9d5ff" }}>
              <div style={{ fontSize: "11px", color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.5px" }}>Plot Type</div>
              <div style={{ fontSize: "14px", fontWeight: 600, textTransform: "capitalize" }}>{plotType}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}