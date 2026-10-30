import React, { useMemo, useState } from "react";
import { SeriesVisualizationComponent, RendererProps } from "../../lib/interactive-types";
import { evaluateSeries, compileExpression, plot2D } from "../../lib/math-environment";
import { motion } from "framer-motion";

interface SeriesVisualizationRendererProps extends RendererProps {
  component: SeriesVisualizationComponent;
}

function formatNumber(num: number, precision = 6): string {
  if (!isFinite(num)) return num > 0 ? "∞" : num < 0 ? "-∞" : "NaN";
  if (Math.abs(num) < 1e-6 && num !== 0) return num.toExponential(3);
  return Number(num.toFixed(precision)).toString();
}

export default function SeriesVisualizationRenderer({
  component,
  instanceId,
}: SeriesVisualizationRendererProps) {
  const [maxTerms, setMaxTerms] = useState(component.maxTerms || 100);
  const [tolerance, setTolerance] = useState(component.tolerance || 1e-10);
  const [variable] = useState(component.variable || "n");

  const seriesData = useMemo(() => {
    try {
      return evaluateSeries(component.termExpression, maxTerms, tolerance);
    } catch {
      return null;
    }
  }, [component.termExpression, maxTerms, tolerance]);

  const terms = seriesData?.terms || [];
  const partialSums = seriesData?.partialSums || [];
  const converges = seriesData?.converges ?? false;
  const sum = seriesData?.sum;

  // Plot partial sums
  const plotPoints = useMemo(() => {
    return partialSums.map((ps) => ({ x: ps.n, y: ps.sum }));
  }, [partialSums]);

  const xMin = 0.5;
  const xMax = Math.max(1, partialSums.length + 0.5);
  const allY = partialSums.map((ps) => ps.sum);
  const yMin = allY.length > 0 ? Math.min(...allY) : -1;
  const yMax = allY.length > 0 ? Math.max(...allY) : 1;
  const ySpan = yMax - yMin || 1;

  const width = 600;
  const height = 360;
  const margin = { left: 60, right: 20, top: 20, bottom: 50 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const xScale = (x: number) => margin.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (y: number) => margin.top + plotHeight - ((y - yMin) / ySpan) * plotHeight;

  return (
    <div className="series-visualization" style={{ fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Controls Panel */}
        <div style={{ flex: "1", minWidth: "280px", maxWidth: "350px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 600 }}>{component.title}</h3>
          {component.description && <p style={{ margin: "0 0 16px", color: "#666", fontSize: "14px" }}>{component.description}</p>}

          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
              a<sub>{variable}</sub> =
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
              {component.termExpression}
            </div>
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Max Terms
              </label>
              <input
                type="range"
                value={maxTerms}
                onChange={(e) => setMaxTerms(Number(e.target.value))}
                min="10"
                max="500"
                style={{ width: "100%" }}
              />
              <div style={{ fontSize: "12px", color: "#6b7280" }}>{maxTerms} terms</div>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Tolerance
              </label>
              <input
                type="number"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
                step="1e-12"
                min="1e-15"
                max="1e-3"
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
              />
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Variable
              </label>
              <input
                type="text"
                value={variable}
                disabled
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px", background: "#f9fafb", maxWidth: "40px" }}
              />
            </div>
          </div>

          <div style={{ marginTop: "16px", padding: "12px", background: "#f9fafb", borderRadius: "8px", fontSize: "13px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span>Terms computed:</span>
              <strong>{terms.length}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span>Converges:</span>
              <strong style={{ color: converges ? "#166534" : "#dc2626" }}>
                {converges ? "Yes" : "No / Unknown"}
              </strong>
            </div>
            {sum !== undefined && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Estimated sum:</span>
                <strong style={{ fontFamily: "monospace" }}>{formatNumber(sum)}</strong>
              </div>
            )}
          </div>
        </div>

        {/* Visualization Panel */}
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

              {/* X-axis ticks */}
              {(() => {
                const ticks = Math.min(10, Math.max(5, partialSums.length));
                return Array.from({ length: ticks + 1 }, (_, i) => {
                  const x = xMin + (xMax - xMin) * (i / ticks);
                  const sx = xScale(x);
                  const labelX = Math.round(x);
                  return labelX <= partialSums.length ? (
                    <g key={i}>
                      <line x1={sx} y1={yScale(0) - 5} x2={sx} y2={yScale(0) + 5} stroke="#6b7280" strokeWidth={1} />
                      {i !== 0 && i !== ticks && <line x1={sx} y1={margin.top} x2={sx} y2={margin.top + plotHeight} stroke="#e5e7eb" strokeWidth={0.5} />}
                      <text x={sx} y={yScale(0) + 25} textAnchor="middle" fontSize={11} fill="#6b7280">{labelX}</text>
                    </g>
                  ) : null;
                });
              })()}

              {/* Y-axis ticks */}
              {(() => {
                const ticks = 5;
                return Array.from({ length: ticks + 1 }, (_, i) => {
                  const y = yMin + ySpan * (i / ticks);
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

              {/* Convergence line */}
              {sum !== undefined && converges && (
                <line
                  x1={margin.left}
                  y1={yScale(sum)}
                  x2={margin.left + plotWidth}
                  y2={yScale(sum)}
                  stroke="#22c55e"
                  strokeWidth={2}
                  strokeDasharray="6,4"
                />
              )}

              {/* Partial sums line */}
              {plotPoints.length > 1 && (
                <path
                  d={plotPoints
                    .map((p, i) =>
                      `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`
                    )
                    .join(" ")}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={2}
                />
              )}

              {/* Points */}
              {plotPoints.map((p, i) =>
                i % Math.max(1, Math.floor(plotPoints.length / 20)) === 0 && (
                  <motion.circle
                    key={i}
                    cx={xScale(p.x)}
                    cy={yScale(p.y)}
                    r={4}
                    fill="#2563eb"
                    initial={{ r: 0 }}
                    animate={{ r: 4 }}
                    transition={{ delay: i * 0.02 }}
                  />
                )
              )}

              {/* Term values as bars (secondary visualization) */}
              {terms.map((t, i) =>
                i < 30 && (
                  <motion.rect
                    key={i}
                    x={xScale(i + 1) - 8}
                    y={yScale(0)}
                    width={16}
                    height={yScale(0) - yScale(Math.abs(t.value))}
                    fill={t.value >= 0 ? "#22c55e" : "#ef4444"}
                    fillOpacity={0.3}
                    initial={{ height: 0, y: yScale(0) }}
                    animate={{ height: yScale(0) - yScale(Math.abs(t.value)), y: t.value >= 0 ? yScale(t.value) : yScale(0) }}
                    transition={{ delay: i * 0.03 }}
                  />
                )
              )}
            </svg>
          </div>

          {/* Convergence status */}
          <div style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
            <div
              style={{
                padding: "12px",
                background: converges ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${converges ? "#bbf7d0" : "#fecaca"}`,
                borderRadius: "8px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: "11px", color: converges ? "#166534" : "#dc2626", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Status
              </div>
              <div style={{ fontSize: "18px", fontWeight: 600, color: converges ? "#166534" : "#dc2626" }}>
                {converges ? "Converges" : "Diverges / Unknown"}
              </div>
            </div>
            <div style={{ padding: "12px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", textAlign: "center" }}>
              <div style={{ fontSize: "11px", color: "#1e40af", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Terms Shown
              </div>
              <div style={{ fontSize: "18px", fontWeight: 600 }}>{Math.min(terms.length, 30)} / {terms.length}</div>
            </div>
            <div style={{ padding: "12px", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: "8px", textAlign: "center" }}>
              <div style={{ fontSize: "11px", color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Last Term
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, fontFamily: "monospace" }}>
                {terms.length > 0 ? formatNumber(terms[terms.length - 1].value) : "—"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Terms Table */}
      <div style={{ marginTop: "16px" }}>
        <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Series Terms</h4>
        <div style={{ overflow: "auto", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, width: "60px" }}>n</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600 }}>Term Expression</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, width: "140px" }}>Value</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, width: "160px" }}>Partial Sum</th>
              </tr>
            </thead>
            <tbody>
              {terms.slice(0, 50).map((t, i) => (
                <tr
                  key={i}
                  style={{
                    borderBottom: i < terms.length - 1 ? "1px solid #f3f4f6" : "none",
                    background: i % 2 === 0 ? "white" : "#fafafa",
                  }}
                >
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", fontWeight: 500 }}>{t.n}</td>
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: "12px", color: "#374151" }}>
                    {t.term}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", color: t.value >= 0 ? "#166534" : "#dc2626" }}>
                    {formatNumber(t.value)}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontWeight: 500 }}>
                    {partialSums[i] ? formatNumber(partialSums[i].sum) : "—"}
                  </td>
                </tr>
              ))}
              {terms.length > 50 && (
                <tr>
                  <td colSpan={4} style={{ padding: "12px", textAlign: "center", color: "#9ca3af" }}>
                    ... and {terms.length - 50} more terms
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}