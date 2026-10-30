import React, { useMemo, useState } from "react";
import { CalculusVisualizationComponent, RendererProps } from "../../lib/interactive-types";
import {
  tangentLine,
  areaUnderCurve,
  taylorSeries,
  evaluateLimit,
  compileExpression,
  plot2D,
} from "../../lib/math-environment";
import { motion } from "framer-motion";

interface CalculusVisualizationRendererProps extends RendererProps {
  component: CalculusVisualizationComponent;
  instanceId?: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
}

function formatNumber(num: number, precision = 4): string {
  if (!isFinite(num)) return num > 0 ? "∞" : num < 0 ? "-∞" : "NaN";
  if (Math.abs(num) < 1e-4 && num !== 0) return num.toExponential(2);
  return Number(num.toFixed(precision)).toString();
}

export default function CalculusVisualizationRenderer({
  component,
  instanceId,
}: CalculusVisualizationRendererProps) {
  const [point, setPoint] = useState(component.point ?? 0);
  const [interval, setInterval] = useState<[number, number]>(component.interval ?? [0, 1]);
  const [areaMethod, setAreaMethod] = useState(component.areaMethod ?? "midpoint");
  const [partitions, setPartitions] = useState(component.partitions ?? 20);
  const [center, setCenter] = useState(component.center ?? 0);
  const [order, setOrder] = useState(component.order ?? 5);
  const [target, setTarget] = useState(component.target ?? 0);
  const [limitDirection, setLimitDirection] = useState(component.limitDirection ?? "both");

  const variable = component.variable || "x";
  const fn = useMemo(() => {
    try {
      return compileExpression(component.expression);
    } catch {
      return null;
    }
  }, [component.expression]);

  // Compute visualization data
  const tangentData = useMemo(() => {
    if (!fn || component.vizType !== "tangent") return null;
    try {
      return tangentLine(component.expression, point, { expression: component.expression, variable, domain: component.domain, samples: 100 });
    } catch {
      return null;
    }
  }, [fn, component.expression, component.vizType, point, variable, component.domain]);

  const areaData = useMemo(() => {
    if (!fn || component.vizType !== "area") return null;
    try {
      return areaUnderCurve(component.expression, interval, { expression: component.expression, variable, domain: component.domain, method: areaMethod, partitions });
    } catch {
      return null;
    }
  }, [fn, component.expression, component.vizType, interval, variable, areaMethod, partitions, component.domain]);

  const taylorData = useMemo(() => {
    if (!fn || component.vizType !== "taylor") return null;
    try {
      return taylorSeries(component.expression, center, order, { expression: component.expression, variable, domain: component.domain, samples: 200 });
    } catch {
      return null;
    }
  }, [fn, component.expression, component.vizType, center, order, variable, component.domain]);

  const limitData = useMemo(() => {
    if (!fn || component.vizType !== "limit") return null;
    try {
      return evaluateLimit(component.expression, target, { expression: component.expression, variable, domain: component.domain, direction: limitDirection });
    } catch {
      return null;
    }
  }, [fn, component.expression, component.vizType, target, variable, limitDirection, component.domain]);

  // Base function plot
  const basePlot = useMemo(() => {
    if (!fn) return null;
    try {
      return plot2D(component.expression, {
        type: "cartesian",
        domain: component.domain,
        samples: 300,
        variable,
      });
    } catch {
      return null;
    }
  }, [fn, component.expression, component.domain, variable]);

  const plotPoints = basePlot?.points || [];
  const xMin = component.domain[0];
  const xMax = component.domain[1];
  const allY = plotPoints.map((p) => p.y);
  const yMin = allY.length > 0 ? Math.min(...allY, 0) : -1;
  const yMax = allY.length > 0 ? Math.max(...allY, 0) : 1;
  const ySpan = yMax - yMin || 1;

  const width = 600;
  const height = 360;
  const margin = { left: 60, right: 20, top: 20, bottom: 50 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const xScale = (x: number) => margin.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (y: number) => margin.top + plotHeight - ((y - yMin) / ySpan) * plotHeight;

  return (
    <div className="calculus-visualization" style={{ fontFamily: "system-ui, sans-serif" }}>
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

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>Visualization</label>
              <select
                value={component.vizType}
                disabled
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px", background: "#f9fafb" }}
              >
                <option value="tangent">Tangent Line</option>
                <option value="area">Area Under Curve</option>
                <option value="taylor">Taylor Series</option>
                <option value="limit">Limit</option>
              </select>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Domain [{variable} min, max]
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="number"
                  value={component.domain[0]}
                  onChange={() => {}}
                  disabled
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px", background: "#f9fafb" }}
                />
                <input
                  type="number"
                  value={component.domain[1]}
                  onChange={() => {}}
                  disabled
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px", background: "#f9fafb" }}
                />
              </div>
            </div>

            {component.vizType === "tangent" && (
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                  Point of Tangency
                </label>
                <input
                  type="number"
                  value={point}
                  onChange={(e) => setPoint(Number(e.target.value))}
                  step="0.1"
                  min={component.domain[0]}
                  max={component.domain[1]}
                  style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                />
              </div>
            )}

            {component.vizType === "area" && (
              <>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Interval [a, b]
                  </label>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="number"
                      value={interval[0]}
                      onChange={(e) => setInterval([Number(e.target.value), interval[1]])}
                      step="0.1"
                      style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    />
                    <input
                      type="number"
                      value={interval[1]}
                      onChange={(e) => setInterval([interval[0], Number(e.target.value)])}
                      step="0.1"
                      style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    />
                  </div>
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Method
                  </label>
                  <select
                    value={areaMethod}
                    onChange={(e) => setAreaMethod(e.target.value as "left" | "right" | "midpoint" | "trapezoid")}
                    style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                  >
                    <option value="left">Left Riemann</option>
                    <option value="right">Right Riemann</option>
                    <option value="midpoint">Midpoint</option>
                    <option value="trapezoid">Trapezoid</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Partitions
                  </label>
                  <input
                    type="range"
                    value={partitions}
                    onChange={(e) => setPartitions(Number(e.target.value))}
                    min="1"
                    max="100"
                    style={{ width: "100%" }}
                  />
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>{partitions} rectangles</div>
                </div>
              </>
            )}

            {component.vizType === "taylor" && (
              <>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Center Point
                  </label>
                  <input
                    type="number"
                    value={center}
                    onChange={(e) => setCenter(Number(e.target.value))}
                    step="0.1"
                    style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Order
                  </label>
                  <input
                    type="range"
                    value={order}
                    onChange={(e) => setOrder(Number(e.target.value))}
                    min="0"
                    max="15"
                    style={{ width: "100%" }}
                  />
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>Order {order}</div>
                </div>
              </>
            )}

            {component.vizType === "limit" && (
              <>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Target Point
                  </label>
                  <input
                    type="number"
                    value={target}
                    onChange={(e) => setTarget(Number(e.target.value))}
                    step="0.1"
                    style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Direction
                  </label>
                  <select
                    value={limitDirection}
                    onChange={(e) => setLimitDirection(e.target.value as "left" | "right" | "both")}
                    style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                  >
                    <option value="both">Both sides</option>
                    <option value="left">Left (x → a⁻)</option>
                    <option value="right">Right (x → a⁺)</option>
                  </select>
                </div>
              </>
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

              {/* Base function curve */}
              {plotPoints.length > 1 && (
                <path
                  d={plotPoints
                    .map((p, i) =>
                      `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`
                    )
                    .join(" ")}
                  fill="none"
                  stroke="#374151"
                  strokeWidth={2}
                  opacity={0.8}
                />
              )}

              {/* Visualization-specific overlays */}
              {component.vizType === "tangent" && tangentData && (
                <>
                  {/* Tangent line */}
                  <line
                    x1={xScale(tangentData.line[0].x)}
                    y1={yScale(tangentData.line[0].y)}
                    x2={xScale(tangentData.line[1].x)}
                    y2={yScale(tangentData.line[1].y)}
                    stroke="#2563eb"
                    strokeWidth={2.5}
                    strokeDasharray="8,4"
                  />
                  {/* Point of tangency */}
                  <circle
                    cx={xScale(tangentData.point.x)}
                    cy={yScale(tangentData.point.y)}
                    r={6}
                    fill="#2563eb"
                    stroke="white"
                    strokeWidth={2}
                  />
                </>
              )}

              {component.vizType === "area" && areaData && (
                <>
                  {/* Rectangles */}
                  {areaData.rectangles.map((rect, i) => (
                    <motion.rect
                      key={i}
                      x={xScale(rect.x)}
                      y={yScale(rect.height)}
                      width={Math.max(1, xScale(rect.x + rect.width) - xScale(rect.x))}
                      height={yScale(0) - yScale(rect.height)}
                      fill="#2563eb"
                      fillOpacity={0.3}
                      stroke="#2563eb"
                      strokeWidth={0.5}
                      initial={{ height: 0, y: yScale(0) }}
                      animate={{ height: yScale(0) - yScale(rect.height), y: yScale(rect.height) }}
                      transition={{ delay: i * 0.02, duration: 0.3 }}
                    />
                  ))}
                  {/* Interval markers */}
                  <line
                    x1={xScale(interval[0])}
                    y1={yScale(0) + 8}
                    x2={xScale(interval[0])}
                    y2={yScale(0) - 8}
                    stroke="#dc2626"
                    strokeWidth={2}
                  />
                  <line
                    x1={xScale(interval[1])}
                    y1={yScale(0) + 8}
                    x2={xScale(interval[1])}
                    y2={yScale(0) - 8}
                    stroke="#dc2626"
                    strokeWidth={2}
                  />
                  <text x={xScale(interval[0])} y={yScale(0) + 22} textAnchor="middle" fontSize={11} fill="#dc2626" fontWeight={600}>a</text>
                  <text x={xScale(interval[1])} y={yScale(0) + 22} textAnchor="middle" fontSize={11} fill="#dc2626" fontWeight={600}>b</text>
                </>
              )}

              {component.vizType === "taylor" && taylorData && (
                <>
                  {/* Taylor approximation */}
                  <path
                    d={taylorData.approximation
                      .map((p, i) =>
                        `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`
                      )
                      .join(" ")}
                    fill="none"
                    stroke="#7c3aed"
                    strokeWidth={2.5}
                    strokeDasharray="4,4"
                  />
                  {/* Center point */}
                  <circle
                    cx={xScale(taylorData.center)}
                    cy={yScale(
                      taylorData.original.find((p) => Math.abs(p.x - taylorData.center) < 1e-6)?.y || 0
                    )}
                    r={5}
                    fill="#7c3aed"
                    stroke="white"
                    strokeWidth={2}
                  />
                </>
              )}

              {component.vizType === "limit" && limitData && (
                <>
                  {/* Target line */}
                  <line
                    x1={xScale(target)}
                    y1={margin.top}
                    x2={xScale(target)}
                    y2={margin.top + plotHeight}
                    stroke="#dc2626"
                    strokeWidth={1.5}
                    strokeDasharray="6,4"
                  />
                  <text x={xScale(target)} y={margin.top - 8} textAnchor="middle" fontSize={11} fill="#dc2626" fontWeight={600}>x = {formatNumber(target)}</text>

                  {/* Approach points */}
                  {limitData.sequence.map((p, i) => (
                    <circle
                      key={i}
                      cx={xScale(p.x)}
                      cy={yScale(p.y)}
                      r={4}
                      fill="#dc2626"
                      opacity={0.6 + 0.4 * (i / limitData.sequence.length)}
                    />
                  ))}

                  {/* Estimated limit line */}
                  {typeof limitData.value === "number" && (
                    <line
                      x1={margin.left}
                      y1={yScale(limitData.value)}
                      x2={margin.left + plotWidth}
                      y2={yScale(limitData.value)}
                      stroke="#22c55e"
                      strokeWidth={2}
                      strokeDasharray="4,4"
                    />
                  )}
                </>
              )}
            </svg>
          </div>

          {/* Results Panel */}
          <div style={{ marginTop: "16px" }}>
            {component.vizType === "tangent" && tangentData && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  padding: "16px",
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: "8px",
                }}
              >
                <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Tangent Line</h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: "11px", color: "#1e40af", textTransform: "uppercase" }}>Point</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px" }}>
                      ({formatNumber(tangentData.point.x)}, {formatNumber(tangentData.point.y)})
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", color: "#1e40af", textTransform: "uppercase" }}>Slope</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px" }}>{formatNumber(tangentData.slope)}</div>
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ fontSize: "11px", color: "#1e40af", textTransform: "uppercase", marginBottom: "4px" }}>Equation</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px", background: "white", padding: "8px", borderRadius: "4px" }}>
                      {tangentData.equation}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {component.vizType === "area" && areaData && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  padding: "16px",
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: "8px",
                }}
              >
                <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Area Under Curve</h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: "11px", color: "#166534", textTransform: "uppercase" }}>Riemann Sum</div>
                    <div style={{ fontFamily: "monospace", fontSize: "18px", fontWeight: 600 }}>
                      {formatNumber(areaData.riemannSum)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", color: "#166534", textTransform: "uppercase" }}>Method</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px", textTransform: "capitalize" }}>
                      {areaData.method}
                    </div>
                  </div>
                  {areaData.exactIntegral !== undefined && (
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div style={{ fontSize: "11px", color: "#166534", textTransform: "uppercase" }}>Exact Integral</div>
                      <div style={{ fontFamily: "monospace", fontSize: "14px" }}>
                        {formatNumber(areaData.exactIntegral)}
                      </div>
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: "11px", color: "#166534", textTransform: "uppercase" }}>Partitions</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px" }}>{areaData.rectangles.length}</div>
                  </div>
                </div>
              </motion.div>
            )}

            {component.vizType === "taylor" && taylorData && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  padding: "16px",
                  background: "#faf5ff",
                  border: "1px solid #e9d5ff",
                  borderRadius: "8px",
                }}
              >
                <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Taylor Series</h4>
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ fontSize: "11px", color: "#7c3aed", textTransform: "uppercase", marginBottom: "4px" }}>
                    Polynomial (center={formatNumber(taylorData.center)}, order={taylorData.order})
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: "13px", background: "white", padding: "8px", borderRadius: "4px", overflow: "auto" }}>
                    {taylorData.polynomial}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: "11px", color: "#7c3aed", textTransform: "uppercase" }}>Center</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px" }}>{formatNumber(taylorData.center)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", color: "#7c3aed", textTransform: "uppercase" }}>Order</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px" }}>{taylorData.order}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", color: "#7c3aed", textTransform: "uppercase" }}>Coefficients</div>
                    <div style={{ fontFamily: "monospace", fontSize: "12px" }}>
                      {taylorData.coefficients.slice(0, 5).map((c) => formatNumber(c)).join(", ")}
                      {taylorData.coefficients.length > 5 ? "..." : ""}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {component.vizType === "limit" && limitData && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  padding: "16px",
                  background:
                    typeof limitData.value === "number"
                      ? "#f0fdf4"
                      : limitData.value === "Does not exist"
                      ? "#fef2f2"
                      : "#fffbeb",
                  border:
                    typeof limitData.value === "number"
                      ? "1px solid #bbf7d0"
                      : limitData.value === "Does not exist"
                      ? "1px solid #fecaca"
                      : "1px solid #fde68a",
                  borderRadius: "8px",
                }}
              >
                <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Limit Evaluation</h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "#6b7280" }}>Target</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px" }}>
                      x → {formatNumber(target)} {limitData.direction === "left" ? "⁻" : limitData.direction === "right" ? "⁺" : ""}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "#6b7280" }}>Limit</div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontSize: "18px",
                        fontWeight: 600,
                        color:
                          typeof limitData.value === "number"
                            ? "#166534"
                            : limitData.value === "Does not exist"
                            ? "#dc2626"
                            : "#b45309",
                      }}
                    >
                      {String(limitData.value)}
                    </div>
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "#6b7280", marginBottom: "8px" }}>
                      Approach Sequence
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      {limitData.sequence.slice(0, 10).map((p, i) => (
                        <span
                          key={i}
                          style={{
                            padding: "4px 8px",
                            background: "white",
                            borderRadius: "4px",
                            fontSize: "11px",
                            fontFamily: "monospace",
                            border: "1px solid #e5e7eb",
                          }}
                        >
                          {formatNumber(p.x)} → {formatNumber(p.y)}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}