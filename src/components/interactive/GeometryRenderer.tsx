import React, { useMemo, useState, useEffect, useRef } from "react";
import { GeometryComponent, RendererProps, Point2D, GeometryConstructionStep, GeometryMeasurementSpec } from "../../lib/interactive-types";
import { GeometryEngine, GeometryObject, GeometryConstruction, GeometryMeasurement } from "../../lib/math-environment";
import { motion, useReducedMotion } from "framer-motion";

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
  const prefersReducedMotion = useReducedMotion();

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
  const width = 560;
  const height = 440;
  const margin = 48;
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
      ctx.strokeStyle = "var(--border-1, #e5e7eb)";
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
      ctx.strokeStyle = "var(--fg-muted, #9ca3af)";
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
      const color = isHovered(obj.label) ? "var(--primary-500, #2563eb)" : "var(--fg-primary, #374151)";
      const lineWidth = isHovered(obj.label) ? 2.5 : 1.5;

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineWidth;

      switch (obj.type) {
        case "point": {
          const sx = toScreenX(obj.point.x);
          const sy = toScreenY(obj.point.y);
          ctx.beginPath();
          ctx.arc(sx, sy, isHovered(obj.label) ? 7 : 5, 0, 2 * Math.PI);
          ctx.fill();
          if (obj.label) {
            ctx.font = "13px var(--font-sans, system-ui)";
            ctx.fillText(obj.label, sx + 10, sy - 10);
          }
          break;
        }
        case "line": {
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
              ctx.font = "12px var(--font-sans, system-ui)";
              ctx.fillText(obj.label, mx + 6, my - 6);
            }
          }
          break;
        }
        case "ray": {
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
            const arrowLen = 12;
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
              ctx.font = "12px var(--font-sans, system-ui)";
              ctx.fillText(obj.label, mx + 6, my - 6);
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
            ctx.font = "12px var(--font-sans, system-ui)";
            ctx.fillText(obj.label, mx + 6, my - 6);
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
            ctx.font = "12px var(--font-sans, system-ui)";
            ctx.fillText(obj.label, sx + r + 6, sy - r - 6);
          }
          // Center point
          ctx.beginPath();
          ctx.arc(sx, sy, 4, 0, 2 * Math.PI);
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
            ctx.font = "12px var(--font-sans, system-ui)";
            ctx.fillText(obj.label, toScreenX(cx) + 6, toScreenY(cy) - 6);
          }
          break;
        }
        case "angle": {
          const { vertex, point1, point2 } = obj;
          const vx = toScreenX(vertex.x);
          const vy = toScreenY(vertex.y);
          const a1 = Math.atan2(point1.y - vertex.y, point1.x - vertex.x);
          const a2 = Math.atan2(point2.y - vertex.y, point2.x - vertex.x);
          const radius = 36;
          ctx.beginPath();
          ctx.arc(vx, vy, radius, -a1, -a2);
          ctx.stroke();
          if (obj.label) {
            const midAngle = (a1 + a2) / 2;
            ctx.font = "12px var(--font-sans, system-ui)";
            ctx.fillText(obj.label, vx + Math.cos(-midAngle) * (radius + 14), vy + Math.sin(-midAngle) * (radius + 14));
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
        if (dist < 14 && dist < minDist) {
          minDist = dist;
          found = obj.label;
        }
      }
    }
    setHoveredObject(found);
  };

  const handleMouseLeave = () => setHoveredObject(null);

  const transition = prefersReducedMotion ? { duration: 0 } : { duration: 0.3, ease: [0.16, 1, 0.3, 1] };

  return (
    <div className="geometry-renderer" style={{
      fontFamily: "var(--font-sans, system-ui, sans-serif)",
      background: "var(--surface-1, white)",
      border: "1px solid var(--border-1, #e5e7eb)",
      borderRadius: "var(--radius-xl, 12px)",
      padding: "16px",
      boxShadow: "var(--shadow-sm, 0 1px 2px 0 rgb(0 0 0 / 0.05))",
    }}>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Canvas Panel */}
        <motion.div
          style={{ flex: "2", minWidth: "420px" }}
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

          <div style={{ position: "relative" }}>
            <canvas
              ref={canvasRef}
              width={width}
              height={height}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              style={{
                background: "var(--surface-2, #fafafa)",
                borderRadius: "var(--radius-lg, 8px)",
                border: "1px solid var(--border-1, #e5e7eb)",
                cursor: "crosshair",
                touchAction: "none",
              }}
            />
            {error && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                style={{ position: "absolute", bottom: 12, left: 12, right: 12, padding: "10px 12px", background: "var(--error-bg, #fef2f2)", border: "1px solid var(--error-border, #fecaca)", borderRadius: "var(--radius-lg, 8px)", color: "var(--error-fg, #dc2626)", fontSize: "var(--text-sm, 0.875rem)" }}
                role="alert"
              >
                {error}
              </motion.div>
            )}
          </div>

          <div style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              style={{ padding: "14px", background: "var(--success-bg, #f0fdf4)", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--success-border, #bbf7d0)" }}
            >
              <div style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--success-700, #166534)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Objects</div>
              <div style={{ fontSize: "var(--text-2xl, 1.5rem)", fontWeight: 700, color: "var(--fg-primary, #111827)" }}>{objects.length}</div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              style={{ padding: "14px", background: "var(--primary-bg, #eff6ff)", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--primary-border, #bfdbfe)" }}
            >
              <div style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--primary-700, #1e40af)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Measurements</div>
              <div style={{ fontSize: "var(--text-2xl, 1.5rem)", fontWeight: 700, color: "var(--fg-primary, #111827)" }}>{measurements.length}</div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              style={{ padding: "14px", background: "var(--purple-bg, #faf5ff)", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--purple-border, #e9d5ff)" }}
            >
              <div style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--purple-700, #7c3aed)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Bounds</div>
              <div style={{ fontSize: "var(--text-sm, 0.875rem)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                X: [{formatNumber(xMin)}, {formatNumber(xMax)}]
              </div>
            </motion.div>
          </div>
        </motion.div>

        {/* Sidebar: Constructions & Measurements */}
        <motion.div
          style={{ flex: "1", minWidth: "300px", maxWidth: "380px", display: "flex", flexDirection: "column", gap: "16px" }}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={transition}
        >
          <div>
            <h4 style={{ margin: "0 0 12px", fontSize: "var(--text-base, 1rem)", fontWeight: 600, color: "var(--fg-primary, #111827)" }}>Constructions</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "340px", overflow: "auto", paddingRight: "4px" }}>
              {(component.constructions || []).map((step, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  style={{
                    padding: "12px",
                    background: "var(--surface-2, #f9fafb)",
                    border: "1px solid var(--border-1, #e5e7eb)",
                    borderRadius: "var(--radius-lg, 8px)",
                    fontSize: "var(--text-sm, 0.875rem)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    <span
                      style={{
                        padding: "3px 10px",
                        background: "var(--primary-500, #2563eb)",
                        color: "white",
                        borderRadius: "var(--radius-full, 9999px)",
                        fontSize: "var(--text-xs, 0.75rem)",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.3px",
                      }}
                    >
                      {OP_LABELS[step.op] || step.op}
                    </span>
                    {step.label && (
                      <span style={{ fontWeight: 600, fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "var(--text-sm, 0.875rem)" }}>{step.label}</span>
                    )}
                  </div>
                  <div style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--fg-muted, #6b7280)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                    {Object.entries(step.params)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", ")}
                  </div>
                </motion.div>
              ))}
              {(component.constructions || []).length === 0 && (
                <div style={{ padding: "20px", textAlign: "center", color: "var(--fg-muted, #9ca3af)", fontSize: "var(--text-sm, 0.875rem)" }}>No constructions defined</div>
              )}
            </div>
          </div>

          {measurements.length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 12px", fontSize: "var(--text-base, 1rem)", fontWeight: 600, color: "var(--fg-primary, #111827)" }}>Measurements</h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {measurements.map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                    style={{
                      padding: "12px",
                      background: "var(--success-bg, #f0fdf4)",
                      border: "1px solid var(--success-border, #bbf7d0)",
                      borderRadius: "var(--radius-lg, 8px)",
                      fontSize: "var(--text-sm, 0.875rem)",
                    }}
                  >
                    <div style={{ fontWeight: 600, color: "var(--fg-primary, #111827)" }}>{m.label}</div>
                    <div style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "var(--text-base, 1rem)", color: "var(--success-700, #166534)", marginTop: "2px" }}>{m.value}</div>
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}