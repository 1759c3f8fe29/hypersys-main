// ---------------------------------------------------------------------------
// Simulation Renderer
// ---------------------------------------------------------------------------
//
// Renders interactive educational simulations for physics, mathematics,
// computer science, chemistry/biology, and business/economics.
//
// ---------------------------------------------------------------------------

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  SkipBack,
  FastForward,
  Settings,
  X,
  Maximize2,
  Minimize2,
  HelpCircle,
  RefreshCw,
} from "lucide-react";
import type { RendererProps } from "@/lib/interactive-renderer";
import { getSimulation, type SimulationState, type SimulationFrameData, type SimulationParameter } from "@/lib/simulations";

interface SimulationRendererProps {
  component: {
    type: "simulation";
    simulationId: string;
    title: string;
    description?: string;
    parameters: Record<string, number | string | boolean>;
    running?: boolean;
    speed?: number;
    initialState?: Partial<SimulationState>;
    instanceId?: string;
    key?: string;
  };
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
  instanceId?: string;
}

function ParameterControls({
  template,
  parameters,
  onChange,
  disabled,
}: {
  template: ReturnType<typeof getSimulation>;
  parameters: Record<string, number | string | boolean>;
  onChange: (id: string, value: number | string | boolean) => void;
  disabled: boolean;
}) {
  if (!template) return null;

  return (
    <div className="simulation-controls">
      <div className="simulation-controls-header">
        <h4>Parameters</h4>
      </div>
      <div className="simulation-parameters">
        {template.parameters.map((param) => (
          <div key={param.id} className="parameter-row">
            <label htmlFor={`param-${param.id}`} className="parameter-label">
              {param.label}
              {param.unit && <span className="parameter-unit">{param.unit}</span>}
            </label>
            <div className="parameter-input-wrapper">
              {param.type === "number" && (
                <>
                  <input
                    id={`param-${param.id}`}
                    type="range"
                    min={param.min ?? 0}
                    max={param.max ?? 100}
                    step={param.step ?? 1}
                    value={Number(parameters[param.id] ?? param.default)}
                    onChange={(e) => onChange(param.id, Number(e.target.value))}
                    disabled={disabled}
                    className="parameter-slider"
                  />
                  <input
                    id={`param-${param.id}-num`}
                    type="number"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={Number(parameters[param.id] ?? param.default)}
                    onChange={(e) => onChange(param.id, Number(e.target.value))}
                    disabled={disabled}
                    className="parameter-number"
                  />
                </>
              )}
              {param.type === "select" && (
                <select
                  id={`param-${param.id}`}
                  value={String(parameters[param.id] ?? param.default)}
                  onChange={(e) => onChange(param.id, e.target.value)}
                  disabled={disabled}
                  className="parameter-select"
                >
                  {param.options?.map((opt) => (
                    <option key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
              {param.type === "boolean" && (
                <label className="parameter-checkbox">
                  <input
                    id={`param-${param.id}`}
                    type="checkbox"
                    checked={Boolean(parameters[param.id] ?? param.default)}
                    onChange={(e) => onChange(param.id, e.target.checked)}
                    disabled={disabled}
                  />
                  <span>Enabled</span>
                </label>
              )}
            </div>
            {param.description && (
              <div className="parameter-description">{param.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricsDisplay({ metrics }: { metrics: Record<string, string | number> }) {
  return (
    <div className="simulation-metrics">
      {Object.entries(metrics).map(([key, value]) => (
        <div key={key} className="metric-item">
          <span className="metric-label">{key}</span>
          <span className="metric-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

function CanvasRenderer({
  frameData,
  bounds,
  width,
  height,
  showGrid,
  showAxes,
}: {
  frameData: SimulationFrameData;
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  width: number;
  height: number;
  showGrid?: boolean;
  showAxes?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set up canvas
    canvas.width = width;
    canvas.height = height;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Coordinate transform
    const xScale = width / (bounds.xMax - bounds.xMin);
    const yScale = height / (bounds.yMax - bounds.yMin);
    const xOffset = -bounds.xMin * xScale;
    const yOffset = height + bounds.yMin * yScale; // Y is flipped

    const transformX = (x: number) => x * xScale + xOffset;
    const transformY = (y: number) => -y * yScale + yOffset;

    // Draw grid
    if (showGrid) {
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;

      // Vertical lines
      const xStep = (bounds.xMax - bounds.xMin) / 10;
      for (let x = bounds.xMin; x <= bounds.xMax; x += xStep) {
        const tx = transformX(x);
        ctx.beginPath();
        ctx.moveTo(tx, 0);
        ctx.lineTo(tx, height);
        ctx.stroke();
      }

      // Horizontal lines
      const yStep = (bounds.yMax - bounds.yMin) / 10;
      for (let y = bounds.yMin; y <= bounds.yMax; y += yStep) {
        const ty = transformY(y);
        ctx.beginPath();
        ctx.moveTo(0, ty);
        ctx.lineTo(width, ty);
        ctx.stroke();
      }
    }

    // Draw axes
    if (showAxes) {
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 2;

      // X axis
      const zeroY = transformY(0);
      if (zeroY >= 0 && zeroY <= height) {
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        ctx.lineTo(width, zeroY);
        ctx.stroke();
      }

      // Y axis
      const zeroX = transformX(0);
      if (zeroX >= 0 && zeroX <= width) {
        ctx.beginPath();
        ctx.moveTo(zeroX, 0);
        ctx.lineTo(zeroX, height);
        ctx.stroke();
      }
    }

    // Draw lines
    if (frameData.lines) {
      for (const line of frameData.lines) {
        if (!line.points || line.points.length < 2) continue;

        ctx.strokeStyle = line.color || "#3b82f6";
        ctx.lineWidth = 2;
        ctx.beginPath();

        const first = line.points[0];
        ctx.moveTo(transformX(first.x), transformY(first.y));

        for (let i = 1; i < line.points.length; i++) {
          const p = line.points[i];
          ctx.lineTo(transformX(p.x), transformY(p.y));
        }

        ctx.stroke();
      }
    }

    // Draw points
    if (frameData.points) {
      for (const point of frameData.points) {
        const tx = transformX(point.x);
        const ty = transformY(point.y);

        ctx.fillStyle = point.color || "#ef4444";
        ctx.beginPath();
        ctx.arc(tx, ty, 6, 0, Math.PI * 2);
        ctx.fill();

        if (point.label) {
          ctx.fillStyle = "#1e293b";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(point.label, tx, ty - 10);
        }
      }
    }

    // Draw shapes
    if (frameData.shapes) {
      for (const shape of frameData.shapes) {
        ctx.strokeStyle = shape.color || "#3b82f6";
        ctx.fillStyle = shape.fill || shape.color || "#3b82f6";
        ctx.lineWidth = shape.strokeWidth || 2;

        switch (shape.type) {
          case "circle":
            if (shape.x !== undefined && shape.y !== undefined && shape.radius !== undefined) {
              const tx = transformX(shape.x);
              const ty = transformY(shape.y);
              const r = shape.radius * xScale;
              ctx.beginPath();
              ctx.arc(tx, ty, r, 0, Math.PI * 2);
              if (shape.fill) ctx.fill();
              ctx.stroke();
            }
            break;

          case "rectangle":
            if (shape.x !== undefined && shape.y !== undefined && shape.width !== undefined && shape.height !== undefined) {
              const tx = transformX(shape.x - shape.width / 2);
              const ty = transformY(shape.y + shape.height / 2);
              const w = shape.width * xScale;
              const h = shape.height * yScale;
              ctx.beginPath();
              ctx.rect(tx, ty, w, -h);
              if (shape.fill) ctx.fill();
              ctx.stroke();
            }
            break;

          case "line":
            if (shape.points && shape.points.length >= 2) {
              ctx.beginPath();
              const first = shape.points[0];
              ctx.moveTo(transformX(first.x), transformY(first.y));
              for (let i = 1; i < shape.points.length; i++) {
                const p = shape.points[i];
                ctx.lineTo(transformX(p.x), transformY(p.y));
              }
              ctx.stroke();
            }
            break;

          case "polygon":
            if (shape.points && shape.points.length >= 3) {
              ctx.beginPath();
              const first = shape.points[0];
              ctx.moveTo(transformX(first.x), transformY(first.y));
              for (let i = 1; i < shape.points.length; i++) {
                const p = shape.points[i];
                ctx.lineTo(transformX(p.x), transformY(p.y));
              }
              ctx.closePath();
              if (shape.fill) ctx.fill();
              ctx.stroke();
            }
            break;
        }
      }
    }

    // Draw annotations
    if (frameData.annotations) {
      ctx.fillStyle = "#1e293b";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";

      for (const annotation of frameData.annotations) {
        const tx = transformX(annotation.x);
        const ty = transformY(annotation.y);
        ctx.fillStyle = annotation.color || "#1e293b";
        ctx.fillText(annotation.text, tx, ty);
      }
    }
  }, [frameData, bounds, width, height, showGrid, showAxes]);

  return <canvas ref={canvasRef} width={width} height={height} className="simulation-canvas" />;
}

export function SimulationRenderer({ component, instanceId, onUpdate, className }: SimulationRendererProps) {
  const template = getSimulation(component.simulationId);

  // Merge template defaults with component parameters
  const initialParams: Record<string, number | string | boolean> = {};
  if (template) {
    for (const param of template.parameters) {
      initialParams[param.id] = param.default;
    }
  }
  const mergedParams = { ...initialParams, ...component.parameters };

  const [state, setState] = useState<SimulationState>({
    parameters: mergedParams,
    running: component.running ?? false,
    timeStep: 0,
    speed: component.speed ?? 1,
    frameData: {},
  });

  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Reset simulation
  const resetSimulation = useCallback(() => {
    if (!template) return;
    setState((prev) => {
      const resetState = template.reset(prev);
      return {
        ...resetState,
        parameters: { ...prev.parameters }, // Keep current parameters
      };
    });
  }, [template]);

  // Step simulation
  const stepSimulation = useCallback((timestamp: number) => {
    if (!template || !state.running) return;

    const dt = (timestamp - lastTimeRef.current) / 1000; // Convert to seconds
    lastTimeRef.current = timestamp;

    // Cap dt to prevent huge jumps
    const cappedDt = Math.min(dt, 0.1);

    setState((prev) => template.step(prev, cappedDt));

    animationRef.current = requestAnimationFrame(stepSimulation);
  }, [template, state.running]);

  // Handle parameter changes
  const handleParameterChange = useCallback((id: string, value: number | string | boolean) => {
    setState((prev) => ({
      ...prev,
      parameters: { ...prev.parameters, [id]: value },
    }));

    // If not running, immediately update frame
    if (!state.running && template) {
      const newState = template.step({ ...state, parameters: { ...state.parameters, [id]: value } }, 0);
      setState((prev) => ({ ...prev, frameData: newState.frameData }));
    }
  }, [state.running, template]);

  // Toggle running state
  const toggleRunning = useCallback(() => {
    setState((prev) => {
      const newRunning = !prev.running;
      if (newRunning) {
        lastTimeRef.current = performance.now();
        animationRef.current = requestAnimationFrame(stepSimulation);
      } else if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return { ...prev, running: newRunning };
    });
  }, [stepSimulation]);

  // Speed change
  const setSpeed = useCallback((newSpeed: number) => {
    setState((prev) => ({ ...prev, speed: Math.max(0.1, Math.min(10, newSpeed)) }));
  }, []);

  // Effect for animation loop
  useEffect(() => {
    if (state.running && template) {
      lastTimeRef.current = performance.now();
      animationRef.current = requestAnimationFrame(stepSimulation);
    } else if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [state.running, template, stepSimulation]);

  // Notify parent of updates
  useEffect(() => {
    if (onUpdate) {
      onUpdate(instanceId || "", state.parameters);
    }
  }, [state.parameters, onUpdate, instanceId]);

  if (!template) {
    return (
      <div className={`simulation-renderer error ${className || ""}`} role="alert">
        <div className="error-message">
          <span className="error-icon" aria-hidden="true">⚠️</span>
          <span>Unknown simulation: {component.simulationId}</span>
        </div>
      </div>
    );
  }

  const renderHints = template.renderHints;
  const bounds = renderHints.bounds;

  return (
    <div className={`simulation-renderer ${className || ""}`} data-instance-id={instanceId}>
      <div className="simulation-header">
        <div className="simulation-title-section">
          <h3 className="simulation-title">{component.title}</h3>
          {component.description && <p className="simulation-description">{component.description}</p>}
        </div>
        <div className="simulation-header-actions">
          <button
            className="simulation-btn"
            onClick={resetSimulation}
            title="Reset"
            disabled={state.running}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="simulation-btn"
            onClick={() => setSpeed(state.speed === 1 ? 2 : state.speed === 2 ? 0.5 : 1)}
            title={`Speed: ${state.speed}x`}
          >
            <span className="speed-indicator">{state.speed}x</span>
          </button>
        </div>
      </div>

      <div className="simulation-main">
        <div className="simulation-canvas-container">
          <CanvasRenderer
            frameData={state.frameData}
            bounds={bounds}
            width={renderHints.width}
            height={renderHints.height}
            showGrid={renderHints.showGrid}
            showAxes={renderHints.showAxes}
          />

          <div className="simulation-playback-controls">
            <button
              className="playback-btn"
              onClick={resetSimulation}
              title="Reset to start"
              disabled={state.running}
            >
              <SkipBack size={20} />
            </button>
            <motion.button
              className={`playback-btn main ${state.running ? "playing" : ""}`}
              onClick={toggleRunning}
              title={state.running ? "Pause" : "Play"}
              whileTap={{ scale: 0.95 }}
            >
              {state.running ? <Pause size={24} /> : <Play size={24} />}
            </motion.button>
            <button
              className="playback-btn"
              onClick={() => setSpeed(state.speed * 2)}
              title="Double speed"
            >
              <FastForward size={20} />
            </button>
            <div className="time-display">
              Time: {state.timeStep.toFixed(2)}s
            </div>
          </div>
        </div>

        <div className="simulation-sidebar">
          <ParameterControls
            template={template}
            parameters={state.parameters}
            onChange={handleParameterChange}
            disabled={state.running}
          />

          {Object.keys(state.frameData.metrics || {}).length > 0 && (
            <MetricsDisplay metrics={state.frameData.metrics || {}} />
          )}

          {template.educational && (
            <details className="simulation-educational">
              <summary>Learning Resources</summary>
              <div className="educational-content">
                <h5>Key Concepts</h5>
                <ul>
                  {template.educational.concepts.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
                <h5>Learning Objectives</h5>
                <ul>
                  {template.educational.learningObjectives.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
                <h5>Suggested Experiments</h5>
                <ul>
                  {template.educational.suggestedExperiments.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            </details>
          )}
        </div>
      </div>

      <style>{`
        .simulation-renderer {
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          background: white;
          overflow: hidden;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .simulation-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 16px 20px;
          border-bottom: 1px solid #e2e8f0;
          background: #f8fafc;
        }
        .simulation-title {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: #1e293b;
        }
        .simulation-description {
          margin: 4px 0 0;
          font-size: 13px;
          color: #64748b;
        }
        .simulation-header-actions {
          display: flex;
          gap: 8px;
        }
        .simulation-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          background: white;
          color: #475569;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .simulation-btn:hover:not(:disabled) {
          background: #f1f5f9;
          border-color: #cbd5e1;
        }
        .simulation-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .speed-indicator {
          font-size: 11px;
          font-weight: 600;
          color: #3b82f6;
        }
        .simulation-main {
          display: flex;
          min-height: 300px;
        }
        .simulation-canvas-container {
          flex: 1;
          position: relative;
          display: flex;
          flex-direction: column;
        }
        .simulation-canvas {
          width: 100%;
          height: 100%;
          display: block;
        }
        .simulation-playback-controls {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 12px;
          background: #f8fafc;
          border-top: 1px solid #e2e8f0;
        }
        .playback-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          background: white;
          color: #475569;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .playback-btn:hover:not(:disabled) {
          background: #f1f5f9;
          border-color: #cbd5e1;
        }
        .playback-btn.main {
          width: 48px;
          height: 48px;
          background: #3b82f6;
          border-color: #3b82f6;
          color: white;
        }
        .playback-btn.main:hover {
          background: #2563eb;
        }
        .playback-btn.main.playing {
          background: #ef4444;
          border-color: #ef4444;
        }
        .playback-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .time-display {
          font-size: 13px;
          font-variant-numeric: tabular-nums;
          color: #64748b;
          font-weight: 500;
        }
        .simulation-sidebar {
          width: 280px;
          border-left: 1px solid #e2e8f0;
          background: #fafafa;
          padding: 16px;
          overflow-y: auto;
          max-height: 500px;
        }
        .simulation-controls-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid #e2e8f0;
        }
        .simulation-controls-header h4 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: #1e293b;
        }
        .parameter-row {
          margin-bottom: 16px;
        }
        .parameter-label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: #334155;
          margin-bottom: 6px;
        }
        .parameter-unit {
          font-weight: 400;
          color: #94a3b8;
          margin-left: 4px;
        }
        .parameter-input-wrapper {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .parameter-slider {
          width: 100%;
          accent-color: #3b82f6;
        }
        .parameter-number {
          width: 80px;
          padding: 6px 8px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 13px;
          align-self: flex-start;
        }
        .parameter-select {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 13px;
          background: white;
        }
        .parameter-checkbox {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: #334155;
          cursor: pointer;
        }
        .parameter-description {
          margin-top: 4px;
          font-size: 11px;
          color: #94a3b8;
        }
        .simulation-metrics {
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid #e2e8f0;
        }
        .metric-item {
          display: flex;
          justify-content: space-between;
          padding: 6px 0;
          font-size: 13px;
        }
        .metric-label {
          color: #64748b;
        }
        .metric-value {
          color: #1e293b;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
        }
        .simulation-educational {
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid #e2e8f0;
        }
        .simulation-educational summary {
          font-size: 13px;
          font-weight: 600;
          color: #334155;
          cursor: pointer;
        }
        .educational-content h5 {
          margin: 12px 0 6px;
          font-size: 12px;
          font-weight: 600;
          color: #475569;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .educational-content h5:first-child {
          margin-top: 0;
        }
        .educational-content ul {
          margin: 0;
          padding-left: 18px;
          font-size: 12px;
          color: #475569;
        }
        .educational-content li {
          margin-bottom: 4px;
        }
        .simulation-renderer.error {
          padding: 20px;
          text-align: center;
          background: #fef2f2;
          border-color: #fecaca;
        }
        .error-message {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          color: #dc2626;
        }
      `}</style>
    </div>
  );
}

export default SimulationRenderer;