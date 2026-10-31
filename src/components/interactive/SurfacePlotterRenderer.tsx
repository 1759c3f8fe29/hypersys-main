import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { SurfacePlotterComponent, RendererProps } from "../../lib/interactive-types";
import { plot3D, plot3DParametric, compileExpression } from "../../lib/math-environment";
import { motion, useReducedMotion } from "framer-motion";

interface SurfacePlotterRendererProps extends RendererProps {
  component: SurfacePlotterComponent;
  instanceId?: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
}

function formatNumber(num: number, precision = 3): string {
  if (!isFinite(num)) return num > 0 ? "∞" : num < 0 ? "-∞" : "NaN";
  if (Math.abs(num) < 1e-3 && num !== 0) return num.toExponential(2);
  return Number(num.toFixed(precision)).toString();
}

const colorSchemeOptions = [
  { value: "height", label: "Height (blue→red)" },
  { value: "slope", label: "Slope" },
  { value: "curvature", label: "Curvature" },
] as const;

export default function SurfacePlotterRenderer({
  component,
  instanceId,
  onUpdate,
}: SurfacePlotterRendererProps) {
  const [resolution, setResolution] = useState(component.resolution || 50);
  const [colorScheme, setColorScheme] = useState(component.colorScheme || "height");
  const [wireframe, setWireframe] = useState(component.wireframe || false);
  const [isParametric, setIsParametric] = useState(false);
  const [yExpression, setYExpression] = useState("");
  const [zExpression, setZExpression] = useState("");
  const [uDomain, setUDomain] = useState<[number, number]>([0, 2 * Math.PI]);
  const [vDomain, setVDomain] = useState<[number, number]>([0, 2 * Math.PI]);
  const [replotTrigger, setReplotTrigger] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const buffersRef = useRef<{ position: WebGLBuffer; color: WebGLBuffer; index: WebGLBuffer } | null>(null);
  const prefersReducedMotion = useReducedMotion();

  const result = useMemo(() => {
    try {
      if (isParametric) {
        return plot3DParametric(
          component.expression,
          yExpression,
          zExpression,
          uDomain,
          vDomain,
          resolution
        );
      }
      return plot3D(component.expression, {
        xDomain: component.xDomain,
        yDomain: component.yDomain,
        resolution,
        variables: component.variables,
      });
    } catch (err) {
      return null;
    }
  }, [component.expression, component.xDomain, component.yDomain, resolution, component.variables, isParametric, yExpression, zExpression, uDomain, vDomain, replotTrigger]);

  const vertices = result?.vertices;
  const indices = result?.indices;
  const colors = result?.colors;
  const bounds = result?.bounds;

  // Camera state
  const [rotationX, setRotationX] = useState(0.3);
  const [rotationY, setRotationY] = useState(-0.5);
  const [isDragging, setIsDragging] = useState(false);
  const [lastMousePos, setLastMousePos] = useState<{ x: number; y: number } | null>(null);

  // WebGL initialization and rendering
  const initWebGL = useCallback((canvas: HTMLCanvasElement) => {
    if (!vertices || !indices || !colors || !bounds) return;

    const gl = canvas.getContext("webgl2");
    if (!gl) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Shaders
    const vsSource = `#version 300 es
      in vec3 aPosition;
      in vec3 aColor;
      uniform mat4 uModelViewProjection;
      out vec3 vColor;
      void main() {
        gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
        vColor = aColor;
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      in vec3 vColor;
      out vec4 fragColor;
      void main() {
        fragColor = vec4(vColor, 1.0);
      }
    `;

    function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        throw new Error("Shader compile error");
      }
      return shader;
    }

    function createProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        throw new Error("Program link error");
      }
      return program;
    }

    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = createProgram(gl, vs, fs);

    // Buffers
    const positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const colorBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // Attributes
    const positionLoc = gl.getAttribLocation(program, "aPosition");
    const colorLoc = gl.getAttribLocation(program, "aColor");
    const mvpLoc = gl.getUniformLocation(program, "uModelViewProjection");

    gl.enableVertexAttribArray(positionLoc);
    gl.enableVertexAttribArray(colorLoc);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0.98, 0.98, 0.98, 1.0);

    glRef.current = gl;
    programRef.current = program;
    buffersRef.current = { position: positionBuffer, color: colorBuffer, index: indexBuffer };

    return { gl, program, mvpLoc, positionLoc, colorLoc };
  }, [vertices, indices, colors, bounds]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !vertices || !indices || !bounds) return;

    const webgl = initWebGL(canvas);
    if (!webgl) return;

    const { gl, program, mvpLoc } = webgl;

    let frame = 0;
    let autoRotateY = rotationY;
    let autoRotateX = rotationX;

    function getProjectionMatrix(fov: number, aspect: number, near: number, far: number): Float32Array {
      const f = 1.0 / Math.tan(fov / 2);
      const m = new Float32Array(16);
      m[0] = f / aspect; m[4] = 0; m[8] = 0; m[12] = 0;
      m[1] = 0; m[5] = f; m[9] = 0; m[13] = 0;
      m[2] = 0; m[6] = 0; m[10] = (far + near) / (near - far); m[14] = (2 * far * near) / (near - far);
      m[3] = 0; m[7] = 0; m[11] = -1; m[15] = 0;
      return m;
    }

    function getViewMatrix(eye: [number, number, number], center: [number, number, number], up: [number, number, number]): Float32Array {
      const f = [center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]];
      const flen = Math.sqrt(f[0]*f[0] + f[1]*f[1] + f[2]*f[2]);
      f[0] /= flen; f[1] /= flen; f[2] /= flen;
      const s = [f[1]*up[2] - f[2]*up[1], f[2]*up[0] - f[0]*up[2], f[0]*up[1] - f[1]*up[0]];
      const slen = Math.sqrt(s[0]*s[0] + s[1]*s[1] + s[2]*s[2]);
      s[0] /= slen; s[1] /= slen; s[2] /= slen;
      const u = [s[1]*f[2] - s[2]*f[1], s[2]*f[0] - s[0]*f[2], s[0]*f[1] - s[1]*f[0]];
      const m = new Float32Array(16);
      m[0] = s[0]; m[4] = s[1]; m[8] = s[2]; m[12] = -(s[0]*eye[0] + s[1]*eye[1] + s[2]*eye[2]);
      m[1] = u[0]; m[5] = u[1]; m[9] = u[2]; m[13] = -(u[0]*eye[0] + u[1]*eye[1] + u[2]*eye[2]);
      m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2]; m[14] = -(-f[0]*eye[0] - f[1]*eye[1] - f[2]*eye[2]);
      m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
      return m;
    }

    function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
      const m = new Float32Array(16);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += a[i * 4 + k] * b[k * 4 + j];
          m[i * 4 + j] = sum;
        }
      }
      return m;
    }

    function render() {
      frame++;
      if (prefersReducedMotion) {
        // No auto-rotation when reduced motion is preferred
      } else if (frame % 60 === 0 && !isDragging) {
        autoRotateY += 0.002;
      }

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);

      const centerX = (bounds.x[0] + bounds.x[1]) / 2;
      const centerY = (bounds.y[0] + bounds.y[1]) / 2;
      const centerZ = (bounds.z[0] + bounds.z[1]) / 2;
      const maxDim = Math.max(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0], bounds.z[1] - bounds.z[0]) || 1;

      const distance = maxDim * 2.5;
      const eye = [
        centerX + distance * Math.cos(autoRotateX) * Math.sin(autoRotateY),
        centerY + distance * Math.sin(autoRotateX),
        centerZ + distance * Math.cos(autoRotateX) * Math.cos(autoRotateY),
      ];

      const modelView = getViewMatrix(eye as [number, number, number], [centerX, centerY, centerZ], [0, 1, 0]);
      const projection = getProjectionMatrix(Math.PI / 4, canvas.width / canvas.height, 0.1, distance * 10);
      const mvp = multiplyMat4(projection, modelView);

      gl.uniformMatrix4fv(mvpLoc, false, mvp);

      if (wireframe) {
        gl.drawElements(gl.LINES, indices.length, gl.UNSIGNED_INT, 0);
      } else {
        gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
      }

      animationRef.current = requestAnimationFrame(render);
    }

    // Mouse interaction handlers
    const handleMouseDown = (e: MouseEvent) => {
      setIsDragging(true);
      setLastMousePos({ x: e.clientX, y: e.clientY });
      canvas.style.cursor = "grabbing";
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !lastMousePos) return;
      const dx = e.clientX - lastMousePos.x;
      const dy = e.clientY - lastMousePos.y;
      setRotationY(prev => prev + dx * 0.005);
      setRotationX(prev => Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, prev + dy * 0.005)));
      setLastMousePos({ x: e.clientX, y: e.clientY });
      autoRotateY = rotationY + dx * 0.005;
      autoRotateX = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, rotationX + dy * 0.005));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setLastMousePos(null);
      canvas.style.cursor = "grab";
    };

    canvas.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    canvas.style.cursor = "grab";

    // Touch support
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        setIsDragging(true);
        setLastMousePos({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      }
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging || !lastMousePos || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - lastMousePos.x;
      const dy = e.touches[0].clientY - lastMousePos.y;
      setRotationY(prev => prev + dx * 0.005);
      setRotationX(prev => Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, prev + dy * 0.005)));
      setLastMousePos({ x: e.touches[0].clientX, y: e.touches[0].clientY });
    };
    const handleTouchEnd = () => {
      setIsDragging(false);
      setLastMousePos(null);
    };

    canvas.addEventListener("touchstart", handleTouchStart, { passive: true });
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    canvas.addEventListener("touchend", handleTouchEnd);

    render();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("touchend", handleTouchEnd);
      if (gl) {
        gl.deleteProgram(program);
        gl.deleteBuffer(buffersRef.current?.position ?? null);
        gl.deleteBuffer(buffersRef.current?.color ?? null);
        gl.deleteBuffer(buffersRef.current?.index ?? null);
      }
    };
  }, [vertices, indices, colors, bounds, wireframe, initWebGL, prefersReducedMotion, isDragging, rotationX, rotationY]);

  const transition = prefersReducedMotion ? { duration: 0 } : { duration: 0.3, ease: [0.16, 1, 0.3, 1] };

  return (
    <div className="surface-plotter" style={{
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
              {isParametric ? "x(u,v) =" : "z(x,y) ="}
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

          {isParametric && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={transition}
            >
              <div style={{ marginBottom: "12px" }}>
                <label style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "var(--text-sm, 0.875rem)",
                  fontWeight: 500,
                  color: "var(--fg-secondary, #374151)"
                }}>
                  y(u,v) =
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
                  placeholder="e.g., v"
                />
              </div>
              <div style={{ marginBottom: "16px" }}>
                <label style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "var(--text-sm, 0.875rem)",
                  fontWeight: 500,
                  color: "var(--fg-secondary, #374151)"
                }}>
                  z(u,v) =
                </label>
                <input
                  type="text"
                  value={zExpression}
                  onChange={(e) => { setZExpression(e.target.value); setReplotTrigger(t => t + 1); }}
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
                  placeholder="e.g., u"
                />
              </div>
            </motion.div>
          )}

          <div style={{ display: "grid", gap: "12px" }}>
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
                checked={isParametric}
                onChange={(e) => { setIsParametric(e.target.checked); setReplotTrigger(t => t + 1); }}
                style={{
                  width: "18px",
                  height: "18px",
                  accentColor: "var(--primary-500, #2563eb)",
                  cursor: "pointer",
                }}
              />
              <span>Parametric surface (x,y,z from u,v)</span>
            </label>

            {isParametric ? (
              <>
                <div>
                  <label style={{
                    display: "block",
                    marginBottom: "6px",
                    fontSize: "var(--text-sm, 0.875rem)",
                    fontWeight: 500,
                    color: "var(--fg-secondary, #374151)"
                  }}>
                    u Domain [min, max]
                  </label>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="number"
                      value={uDomain[0]}
                      onChange={(e) => { setUDomain([Number(e.target.value), uDomain[1]]); setReplotTrigger(t => t + 1); }}
                      step="0.1"
                      style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                    />
                    <input
                      type="number"
                      value={uDomain[1]}
                      onChange={(e) => { setUDomain([uDomain[0], Number(e.target.value)]); setReplotTrigger(t => t + 1); }}
                      step="0.1"
                      style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
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
                    v Domain [min, max]
                  </label>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="number"
                      value={vDomain[0]}
                      onChange={(e) => { setVDomain([Number(e.target.value), vDomain[1]]); setReplotTrigger(t => t + 1); }}
                      step="0.1"
                      style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                    />
                    <input
                      type="number"
                      value={vDomain[1]}
                      onChange={(e) => { setVDomain([vDomain[0], Number(e.target.value)]); setReplotTrigger(t => t + 1); }}
                      step="0.1"
                      style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--radius-lg, 8px)", border: "1px solid var(--border-1, #e5e7eb)", fontSize: "var(--text-base, 1rem)", background: "var(--surface-1, white)", color: "var(--fg-primary, #111827)", outline: "none" }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "var(--primary-500, #2563eb)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--primary-500, #2563eb)/0.15"; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-1, #e5e7eb)"; e.currentTarget.style.boxShadow = "none"; }}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label style={{
                    display: "block",
                    marginBottom: "6px",
                    fontSize: "var(--text-sm, 0.875rem)",
                    fontWeight: 500,
                    color: "var(--fg-secondary, #374151)"
                  }}>
                    Resolution
                  </label>
                  <input
                    type="range"
                    value={resolution}
                    onChange={(e) => { setResolution(Number(e.target.value)); setReplotTrigger(t => t + 1); }}
                    min="10"
                    max="100"
                    style={{ width: "100%", accentColor: "var(--primary-500, #2563eb)" }}
                  />
                  <div style={{ fontSize: "var(--text-sm, 0.875rem)", color: "var(--fg-muted, #6b7280)", marginTop: "4px" }}>{resolution} × {resolution} grid</div>
                </div>
              </>
            )}

            <div>
              <label style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "var(--text-sm, 0.875rem)",
                fontWeight: 500,
                color: "var(--fg-secondary, #374151)"
              }}>
                Color Scheme
              </label>
              <select
                value={colorScheme}
                onChange={(e) => { setColorScheme(e.target.value as "height" | "slope" | "curvature"); setReplotTrigger(t => t + 1); }}
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
                {colorSchemeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
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
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
                style={{
                  width: "18px",
                  height: "18px",
                  accentColor: "var(--primary-500, #2563eb)",
                  cursor: "pointer",
                }}
              />
              <span>Wireframe mode</span>
            </label>
          </div>

          {bounds && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              style={{ marginTop: "16px", padding: "12px", background: "var(--surface-2, #f9fafb)", borderRadius: "var(--radius-lg, 8px)", fontSize: "var(--text-sm, 0.875rem)", border: "1px solid var(--border-1, #e5e7eb)" }}
            >
              <div><strong>X:</strong> [{formatNumber(bounds.x[0])}, {formatNumber(bounds.x[1])}]</div>
              <div><strong>Y:</strong> [{formatNumber(bounds.y[0])}, {formatNumber(bounds.y[1])}]</div>
              <div><strong>Z:</strong> [{formatNumber(bounds.z[0])}, {formatNumber(bounds.z[1])}]</div>
              <div style={{ marginTop: "8px" }}>Vertices: {(vertices?.length || 0) / 3}</div>
            </motion.div>
          )}

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            style={{ marginTop: "12px", padding: "12px", background: "var(--primary-bg, #eff6ff)", borderRadius: "var(--radius-lg, 8px)", fontSize: "var(--text-sm, 0.875rem)", color: "var(--primary-700, #1e40af)", border: "1px solid var(--primary-border, #bfdbfe)" }}
          >
            <strong>Tip:</strong> Drag to rotate. {" "}
            {prefersReducedMotion ? "Auto-rotation disabled (reduced motion)." : "Auto-rotates slowly."}
          </motion.div>
        </motion.div>

        {/* 3D Canvas Panel */}
        <motion.div
          style={{ flex: "2", minWidth: "400px" }}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={transition}
        >
          <div style={{ position: "relative", width: "100%", aspectRatio: "1/1" }}>
            <canvas
              ref={canvasRef}
              style={{
                width: "100%",
                height: "100%",
                background: "var(--surface-2, #fafafa)",
                borderRadius: "var(--radius-lg, 8px)",
                border: "1px solid var(--border-1, #e5e7eb)",
                touchAction: "none",
              }}
            />
            {!vertices && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-muted, #6b7280)" }}>
                <div style={{ textAlign: "center", padding: "24px" }}>
                  <div style={{ fontSize: "48px", marginBottom: "12px" }}>📐</div>
                  <div style={{ fontSize: "var(--text-base, 1rem)", fontWeight: 500 }}>Enter expressions to generate surface</div>
                  <div style={{ fontSize: "var(--text-sm, 0.875rem)", marginTop: "8px", opacity: 0.7 }}>Try: sin(x) * cos(y) or parametric: cos(u)*sin(v), sin(u)*sin(v), cos(v)</div>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}