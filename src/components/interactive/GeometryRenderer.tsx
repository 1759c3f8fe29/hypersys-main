import React, { useMemo, useState, useEffect, useRef } from "react";
import { GeometryComponent, RendererProps, Point2D, GeometryConstructionStep, GeometryMeasurementSpec } from "../../lib/interactive-types";
import { GeometryEngine, GeometryObject, GeometryConstruction, GeometryMeasurement } from "../../lib/math-environment";
import { motion } from "framer-motion";

interface GeometryRendererProps extends RendererProps {
  component: GeometryComponent;
  instanceId?: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
}

function formatNumber(num: number, precision = 3): string {
  if (!isFinite(num)) return num > 0 ? "∞" : num < 0 ? "-∞" : "NaN";
  if (Math.abs(num) < 1e-3 && num !== 0) return num.toExponential(2);
  return Number(num.toFixed(precision)).toString();
}

const OP_LABELS: Record<string, string> = {
  point: "Point",
  line: "Line",
  segment: "Segment",
  circle: "Circle",
  circle_three_points: "Circle (3 pts)",
  polygon: "Polygon",
  intersect_lines: "Line Intersection",
  intersect_line_circle: "Line-Circle Intersection",
  midpoint: "Midpoint",
  perp_bisector: "Perp. Bisector",
};

export default function GeometryRenderer({
  component,
  instanceId,
}: GeometryRendererProps) {
  const [engine] = useState(() => new GeometryEngine());
  const [measurements, setMeasurements] = useState<{ label: string; value: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredObject, setHoveredObject] = useState<string | null>(null);

  // Execute constructions
  useEffect(() => {
    engine.clear();
    setError(null);
    const newMeasurements: { label: string; value: string }[] = [];

    try {
      for (const step of component.constructions || []) {
        switch (step.op) {
          case "point":
            engine.addPoint(
              Number(step.params.x),
              Number(step.params.y),
              step.label
            );
            break;
          case "line":
            engine.addLine(
              String(step.params.point1),
              String(step.params.point2),
              step.label
            );
            break;
          case "segment":
            engine.addSegment(
              String(step.params.point1),
              String(step.params.point2),
              step.label
            );
            break;
          case "circle":
            engine.addCircle(
              String(step.params.center),
              Number(step.params.radius),
              step.label
            );
            break;
          case "circle_three_points":
            engine.addCircleThroughPoints(
              String(step.params.point1),
              String(step.params.point2),
              String(step.params.point3),
              step.label
            );
            break;
          case "polygon":
            engine.addPolygon(
              step.params.points as unknown as string[],
              step.label
            );
            break;
          case "intersect_lines":
            engine.intersectLines(
              String(step.params.line1),
              String(step.params.line2),
              step.label
            );
            break;
          case "intersect_line_circle":
            engine.intersectLineCircle(
              String(step.params.line),
              String(step.params.circle),
              step.label as string | undefined
            );
            break;
          case "midpoint":
            engine.getMidpoint(
              String(step.params.point1),
              String(step.params.point2),
              step.label
            );
            break;
          case "perp_bisector":
            engine.getPerpendicularBisector(
              String(step.params.point1),
              String(step.params.point2),
              step.label
            );
            break;
        }
      }

      // Execute measurements
      if (component.measurements) {
        for (const m of component.measurements) {
          try {
            let value: number | Point2D | null = null;
            switch (m.type) {
              case "distance":
                value = engine.measureDistance(m.objects[0], m.objects[1]);
                break;
              case "angle":
                value = engine.measureAngle(m.objects[0], m.objects[1], m.objects[2]);
                break;
              case "midpoint":
                const midLabel = engine.getMidpoint(m.objects[0], m.objects[1], m.label);
                const midObj = engine.get(midLabel);
                if (midObj && midObj.type === "point") {
                  value = midObj.point;
                }
                break;
            }
            if (typeof value === "number") {
              newMeasurements.push({ label: m.label || m.type, value: formatNumber(value) + (m.type === "angle" ? "°" : "") });
            } else if (value && "x" in value) {
              newMeasurements.push({ label: m.label || m.type, value: `(${formatNumber(value.x)}, ${formatNumber(value.y)})` });
            }
          } catch (err) {
            newMeasurements.push({ label: m.label || m.type, value: "Error" });
          }
        }
      }
      setMeasurements(newMeasurements);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Construction error");
    }
  }, [component.constructions, component.measurements, engine]);

  const objects = useMemo(() => engine.getAll(), [engine, component.constructions]);

  // Compute bounds
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const hasExplicitBounds = component.bounds && component.bounds.length === 4;

    if (hasExplicitBounds) {
      return component.bounds as [number, number, number, number];
    }

    for (const obj of objects) {
      const points: Point2D[] = [];
      if (obj.type === "point") points.push(obj.point);
      else if (obj.type === "line" || obj.type === "segment") {
        points.push(obj.point1, obj.point2);
      } else if (obj.type === "ray") {
        // Extend ray for bounds calculation
        const extend = Math.max(xSpan || 1, ySpan || 1) * 2;
        points.push(
          obj.origin,
          { x: obj.origin.x + obj.direction.x * extend, y: obj.origin.y + obj.direction.y * extend }
        );
      } else if (obj.type === "circle") {
        points.push(
          { x: obj.center.x - obj.radius, y: obj.center.y - obj.radius },
          { x: obj.center.x + obj.radius, y: obj.center.y + obj.radius }
        );
      } else if (obj.type === "polygon") {
        points.push(...obj.vertices);
      } else if (obj.type === "angle") {
        points.push(obj.vertex, obj.point1, obj.point2);
      }
      for (const p of points) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }

    if (!isFinite(minX)) return [-5, -5, 5, 5] as [number, number, number, number];

    const padding = Math.max((maxX - minX) * 0.1, (maxY - minY) * 0.1, 1);
    return [minX - padding, minY - padding, maxX + padding, maxY + padding] as [number, number, number, number];
  }, [objects, component.bounds]);

  const [xMin, yMin, xMax, yMax] = bounds;
  const width = 500;
  const height = 400;
  const margin = 40;
  const plotWidth = width - 2 * margin;
  const plotHeight = height - 2 * margin;
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;

  const toScreenX = (x: number) => margin + ((x - xMin) / xSpan) * plotWidth;
  const toScreenY = (y: number) => margin + plotHeight - ((y - yMin) / ySpan) * plotHeight;

  // Draw on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Grid
    if (component.showGrid !== false) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 0.5;
      const gridStep = Math.max(1, Math.pow(10, Math.floor(Math.log10(Math.max(xSpan, ySpan) / 10))));
      for (let x = Math.ceil(xMin / gridStep) * gridStep; x <= xMax; x += gridStep) {
        const sx = toScreenX(x);
        ctx.beginPath();
        ctx.moveTo(sx, margin);
        ctx.lineTo(sx, margin + plotHeight);
        ctx.stroke();
      }
      for (let y = Math.ceil(yMin / gridStep) * gridStep; y <= yMax; y += gridStep) {
        const sy = toScreenY(y);
        ctx.beginPath();
        ctx.moveTo(margin, sy);
        ctx.lineTo(margin + plotWidth, sy);
        ctx.stroke();
      }
    }

    // Axes
    if (component.showAxes !== false) {
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = 1.5;
      // X-axis
      if (yMin <= 0 && yMax >= 0) {
        const sy = toScreenY(0);
        ctx.beginPath();
        ctx.moveTo(margin, sy);
        ctx.lineTo(margin + plotWidth, sy);
        ctx.stroke();
        // Arrow
        ctx.beginPath();
        ctx.moveTo(margin + plotWidth, sy);
        ctx.lineTo(margin + plotWidth - 8, sy - 4);
        ctx.lineTo(margin + plotWidth - 8, sy + 4);
        ctx.closePath();
        ctx.fill();
      }
      // Y-axis
      if (xMin <= 0 && xMax >= 0) {
        const sx = toScreenX(0);
        ctx.beginPath();
        ctx.moveTo(sx, margin);
        ctx.lineTo(sx, margin + plotHeight);
        ctx.stroke();
        // Arrow
        ctx.beginPath();
        ctx.moveTo(sx, margin);
        ctx.lineTo(sx - 4, margin + 8);
        ctx.lineTo(sx + 4, margin + 8);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Draw objects
    const isHovered = (label: string | undefined) => label === hoveredObject;

    for (const obj of objects) {
      const color = isHovered(obj.label) ? "#2563eb" : "#374151";
      const lineWidth = isHovered(obj.label) ? 2.5 : 1.5;

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineWidth;

      switch (obj.type) {
        case "point": {
          const sx = toScreenX(obj.point.x);
          const sy = toScreenY(obj.point.y);
          ctx.beginPath();
          ctx.arc(sx, sy, isHovered(obj.label) ? 6 : 4, 0, 2 * Math.PI);
          ctx.fill();
          if (obj.label) {
            ctx.font = "12px system-ui";
            ctx.fillText(obj.label, sx + 8, sy - 8);
          }
          break;
        }
        case "line": {
          // Extend line beyond bounds
          const { point1, point2 } = obj;
          const dx = point2.x - point1.x;
          const dy = point2.y - point1.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len > 0) {
            const ux = dx / len;
            const uy = dy / len;
            const extend = Math.max(xSpan, ySpan);
            const x1 = point1.x - ux * extend;
            const y1 = point1.y - uy * extend;
            const x2 = point2.x + ux * extend;
            const y2 = point2.y + uy * extend;
            ctx.beginPath();
            ctx.moveTo(toScreenX(x1), toScreenY(y1));
            ctx.lineTo(toScreenX(x2), toScreenY(y2));
            ctx.stroke();
            if (obj.label) {
              const mx = toScreenX((x1 + x2) / 2);
              const my = toScreenY((y1 + y2) / 2);
              ctx.font = "11px system-ui";
              ctx.fillText(obj.label, mx + 5, my - 5);
            }
          }
          break;
        }
        case "ray": {
          // Draw ray from origin in direction
          const { origin, direction } = obj;
          const len = Math.sqrt(direction.x * direction.x + direction.y * direction.y);
          if (len > 0) {
            const ux = direction.x / len;
            const uy = direction.y / len;
            const extend = Math.max(xSpan, ySpan);
            const x1 = origin.x;
            const y1 = origin.y;
            const x2 = origin.x + ux * extend;
            const y2 = origin.y + uy * extend;
            ctx.beginPath();
            ctx.moveTo(toScreenX(x1), toScreenY(y1));
            ctx.lineTo(toScreenX(x2), toScreenY(y2));
            ctx.stroke();
            // Arrow head at end
            const arrowLen = 10;
            const arrowAngle = Math.PI / 6;
            const headX = toScreenX(x2);
            const headY = toScreenY(y2);
            const angle = Math.atan2(y2 - y1, x2 - x1);
            ctx.beginPath();
            ctx.moveTo(headX, headY);
            ctx.lineTo(headX - arrowLen * Math.cos(angle - arrowAngle), headY - arrowLen * Math.sin(angle - arrowAngle));
            ctx.lineTo(headX - arrowLen * Math.cos(angle + arrowAngle), headY - arrowLen * Math.sin(angle + arrowAngle));
            ctx.closePath();
            ctx.fill();
            if (obj.label) {
              const mx = toScreenX((x1 + x2) / 2);
              const my = toScreenY((y1 + y2) / 2);
              ctx.font = "11px system-ui";
              ctx.fillText(obj.label, mx + 5, my - 5);
            }
          }
          break;
        }
        case "segment": {
          ctx.beginPath();
          ctx.moveTo(toScreenX(obj.point1.x), toScreenY(obj.point1.y));
          ctx.lineTo(toScreenX(obj.point2.x), toScreenY(obj.point2.y));
          ctx.stroke();
          if (obj.label) {
            const mx = toScreenX((obj.point1.x + obj.point2.x) / 2);
            const my = toScreenY((obj.point1.y + obj.point2.y) / 2);
            ctx.font = "11px system-ui";
            ctx.fillText(obj.label, mx + 5, my - 5);
          }
          break;
        }
        case "circle": {
          const sx = toScreenX(obj.center.x);
          const sy = toScreenY(obj.center.y);
          const r = (obj.radius / xSpan) * plotWidth;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, 2 * Math.PI);
          ctx.stroke();
          if (obj.label) {
            ctx.font = "11px system-ui";
            ctx.fillText(obj.label, sx + r + 5, sy - r - 5);
          }
          // Center point
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
          ctx.fill();
          break;
        }
        case "polygon": {
          if (obj.vertices.length < 2) break;
          ctx.beginPath();
          ctx.moveTo(toScreenX(obj.vertices[0].x), toScreenY(obj.vertices[0].y));
          for (let i = 1; i < obj.vertices.length; i++) {
            ctx.lineTo(toScreenX(obj.vertices[i].x), toScreenY(obj.vertices[i].y));
          }
          ctx.closePath();
          ctx.stroke();
          if (obj.label) {
            const cx = obj.vertices.reduce((sum, v) => sum + v.x, 0) / obj.vertices.length;
            const cy = obj.vertices.reduce((sum, v) => sum + v.y, 0) / obj.vertices.length;
            ctx.font = "11px system-ui";
            ctx.fillText(obj.label, toScreenX(cx) + 5, toScreenY(cy) - 5);
          }
          break;
        }
        case "angle": {
          // Draw angle arc
          const { vertex, point1, point2 } = obj;
          const vx = toScreenX(vertex.x);
          const vy = toScreenY(vertex.y);
          const a1 = Math.atan2(point1.y - vertex.y, point1.x - vertex.x);
          const a2 = Math.atan2(point2.y - vertex.y, point2.x - vertex.x);
          const radius = 30;
          ctx.beginPath();
          ctx.arc(vx, vy, radius, -a1, -a2);
          ctx.stroke();
          if (obj.label) {
            const midAngle = (a1 + a2) / 2;
            ctx.font = "11px system-ui";
            ctx.fillText(obj.label, vx + Math.cos(-midAngle) * (radius + 10), vy + Math.sin(-midAngle) * (radius + 10));
          }
          break;
        }
      }
    }
  }, [objects, bounds, hoveredObject, component.showGrid, component.showAxes]);

  // Handle canvas hover
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const worldX = xMin + ((x - margin) / plotWidth) * xSpan;
    const worldY = yMax - ((y - margin) / plotHeight) * ySpan;

    let found: string | null = null;
    let minDist = Infinity;

    for (const obj of objects) {
      if (obj.type === "point") {
        const sx = toScreenX(obj.point.x);
        const sy = toScreenY(obj.point.y);
        const dist = Math.hypot(x - sx, y - sy);
        if (dist < 10 && dist < minDist) {
          minDist = dist;
          found = obj.label;
        }
      }
    }
    setHoveredObject(found);
  };

  const handleMouseLeave = () => setHoveredObject(null);

  return (
    <div className="geometry-renderer" style={{ fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Canvas Panel */}
        <div style={{ flex: "2", minWidth: "400px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 600 }}>{component.title}</h3>
          {component.description && <p style={{ margin: "0 0 16px", color: "#666", fontSize: "14px" }}>{component.description}</p>}

          <div style={{ position: "relative" }}>
            <canvas
              ref={canvasRef}
              width={width}
              height={height}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              style={{
                background: "#fafafa",
                borderRadius: "8px",
                border: "1px solid #e5e7eb",
                cursor: "crosshair",
                touchAction: "none",
              }}
            />
            {error && (
              <div style={{ position: "absolute", bottom: 12, left: 12, right: 12, padding: "8px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", color: "#dc2626", fontSize: "13px" }}>
                {error}
              </div>
            )}
          </div>

          <div style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
            <div style={{ padding: "12px", background: "#f0fdf4", borderRadius: "8px", border: "1px solid #bbf7d0" }}>
              <div style={{ fontSize: "11px", color: "#166534", textTransform: "uppercase", letterSpacing: "0.5px" }}>Objects</div>
              <div style={{ fontSize: "18px", fontWeight: 600 }}>{objects.length}</div>
            </div>
            <div style={{ padding: "12px", background: "#eff6ff", borderRadius: "8px", border: "1px solid #bfdbfe" }}>
              <div style={{ fontSize: "11px", color: "#1e40af", textTransform: "uppercase", letterSpacing: "0.5px" }}>Measurements</div>
              <div style={{ fontSize: "18px", fontWeight: 600 }}>{measurements.length}</div>
            </div>
            <div style={{ padding: "12px", background: "#faf5ff", borderRadius: "8px", border: "1px solid #e9d5ff" }}>
              <div style={{ fontSize: "11px", color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.5px" }}>Bounds</div>
              <div style={{ fontSize: "12px", fontFamily: "monospace" }}>
                X: [{formatNumber(xMin)}, {formatNumber(xMax)}]
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar: Constructions & Measurements */}
        <div style={{ flex: "1", minWidth: "280px", maxWidth: "350px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Constructions</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "300px", overflow: "auto" }}>
              {(component.constructions || []).map((step, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  style={{
                    padding: "10px 12px",
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    fontSize: "13px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    <span
                      style={{
                        padding: "2px 8px",
                        background: "#2563eb",
                        color: "white",
                        borderRadius: "4px",
                        fontSize: "10px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                      }}
                    >
                      {OP_LABELS[step.op] || step.op}
                    </span>
                    {step.label && (
                      <span style={{ fontWeight: 600, fontFamily: "monospace", fontSize: "13px" }}>{step.label}</span>
                    )}
                  </div>
                  <div style={{ fontSize: "11px", color: "#6b7280", fontFamily: "monospace" }}>
                    {Object.entries(step.params)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", ")}
                  </div>
                </motion.div>
              ))}
              {(component.constructions || []).length === 0 && (
                <div style={{ padding: "16px", textAlign: "center", color: "#9ca3af" }}>No constructions defined</div>
              )}
            </div>
          </div>

          {measurements.length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>Measurements</h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {measurements.map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    style={{
                      padding: "10px 12px",
                      background: "#f0fdf4",
                      border: "1px solid #bbf7d0",
                      borderRadius: "8px",
                      fontSize: "13px",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontFamily: "monospace", fontSize: "14px", color: "#166534" }}>{m.value}</div>
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}