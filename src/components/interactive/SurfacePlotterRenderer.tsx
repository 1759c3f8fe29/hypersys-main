import React, { useMemo, useState, useRef, useEffect } from "react";
import { SurfacePlotterComponent, RendererProps } from "../../lib/interactive-types";
import { plot3D, plot3DParametric, compileExpression } from "../../lib/math-environment";

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

export default function SurfacePlotterRenderer({
  component,
  instanceId,
}: SurfacePlotterRendererProps) {
  const [resolution, setResolution] = useState(component.resolution || 50);
  const [colorScheme, setColorScheme] = useState(component.colorScheme || "height");
  const [wireframe, setWireframe] = useState(component.wireframe || false);
  const [cameraPosition, setCameraPosition] = useState(
    component.cameraPosition || { x: 2, y: 2, z: 2 }
  );
  const [isParametric, setIsParametric] = useState(false);
  const [yExpression, setYExpression] = useState("");
  const [zExpression, setZExpression] = useState("");
  const [uDomain, setUDomain] = useState<[number, number]>([0, 2 * Math.PI]);
  const [vDomain, setVDomain] = useState<[number, number]>([0, 2 * Math.PI]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

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
  }, [component.expression, component.xDomain, component.yDomain, resolution, component.variables, isParametric, yExpression, zExpression, uDomain, vDomain]);

  const vertices = result?.vertices;
  const indices = result?.indices;
  const colors = result?.colors;
  const bounds = result?.bounds;

  // Initialize WebGL
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !vertices || !indices) return;

    const gl = canvas.getContext("webgl2");
    if (!gl) return;

    // Resize canvas
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
    gl.bufferData(gl.ARRAY_BUFFER, colors!, gl.STATIC_DRAW);

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

    // Camera
    let rotationX = 0.3;
    let rotationY = -0.5;
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;

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

    function getRotationMatrixX(angle: number): Float32Array {
      const c = Math.cos(angle), s = Math.sin(angle);
      return new Float32Array([1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1]);
    }

    function getRotationMatrixY(angle: number): Float32Array {
      const c = Math.cos(angle), s = Math.sin(angle);
      return new Float32Array([c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]);
    }

    let frame = 0;
    function render() {
      frame++;
      if (frame % 60 === 0) {
        rotationY += 0.002;
      }

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);

      const centerX = (bounds!.x[0] + bounds!.x[1]) / 2;
      const centerY = (bounds!.y[0] + bounds!.y[1]) / 2;
      const centerZ = (bounds!.z[0] + bounds!.z[1]) / 2;
      const maxDim = Math.max(bounds!.x[1] - bounds!.x[0], bounds!.y[1] - bounds!.y[0], bounds!.z[1] - bounds!.z[0]) || 1;

      const distance = maxDim * 2.5;
      const eye = [
        centerX + distance * Math.cos(rotationX) * Math.sin(rotationY),
        centerY + distance * Math.sin(rotationX),
        centerZ + distance * Math.cos(rotationX) * Math.cos(rotationY),
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

    // Mouse interaction
    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = "grabbing";
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      rotationY += dx * 0.005;
      rotationX = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, rotationX + dy * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
    };

    const handleMouseUp = () => {
      isDragging = false;
      canvas.style.cursor = "grab";
    };

    canvas.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    canvas.style.cursor = "grab";

    render();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      gl.deleteProgram(program);
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(colorBuffer);
      gl.deleteBuffer(indexBuffer);
    };
  }, [vertices, indices, colors, bounds, wireframe]);

  return (
    <div className="surface-plotter" style={{ fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Controls Panel */}
        <div style={{ flex: "1", minWidth: "280px", maxWidth: "350px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 600 }}>{component.title}</h3>
          {component.description && <p style={{ margin: "0 0 16px", color: "#666", fontSize: "14px" }}>{component.description}</p>}

          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
              {isParametric ? "x(u,v) =" : "z(x,y) ="}
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

          {isParametric && (
            <>
              <div style={{ marginBottom: "12px" }}>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                  y(u,v) =
                </label>
                <input
                  type="text"
                  value={yExpression}
                  onChange={(e) => setYExpression(e.target.value)}
                  style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px", fontFamily: "monospace" }}
                  placeholder="e.g., v"
                />
              </div>
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                  z(u,v) =
                </label>
                <input
                  type="text"
                  value={zExpression}
                  onChange={(e) => setZExpression(e.target.value)}
                  style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px", fontFamily: "monospace" }}
                  placeholder="e.g., u"
                />
              </div>
            </>
          )}

          <div style={{ display: "grid", gap: "12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={isParametric}
                onChange={(e) => setIsParametric(e.target.checked)}
              />
              Parametric surface (x,y,z from u,v)
            </label>

            {isParametric ? (
              <>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    u Domain [min, max]
                  </label>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="number"
                      value={uDomain[0]}
                      onChange={(e) => setUDomain([Number(e.target.value), uDomain[1]])}
                      step="0.1"
                      style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    />
                    <input
                      type="number"
                      value={uDomain[1]}
                      onChange={(e) => setUDomain([uDomain[0], Number(e.target.value)])}
                      step="0.1"
                      style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    />
                  </div>
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    v Domain [min, max]
                  </label>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="number"
                      value={vDomain[0]}
                      onChange={(e) => setVDomain([Number(e.target.value), vDomain[1]])}
                      step="0.1"
                      style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    />
                    <input
                      type="number"
                      value={vDomain[1]}
                      onChange={(e) => setVDomain([vDomain[0], Number(e.target.value)])}
                      step="0.1"
                      style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                    Resolution
                  </label>
                  <input
                    type="range"
                    value={resolution}
                    onChange={(e) => setResolution(Number(e.target.value))}
                    min="10"
                    max="100"
                    style={{ width: "100%" }}
                  />
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>{resolution} × {resolution} grid</div>
                </div>
              </>
            )}

            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500 }}>
                Color Scheme
              </label>
              <select
                value={colorScheme}
                onChange={(e) => setColorScheme(e.target.value as "height" | "slope" | "curvature")}
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ddd", fontSize: "14px" }}
              >
                <option value="height">Height (blue→red)</option>
                <option value="slope">Slope</option>
                <option value="curvature">Curvature</option>
              </select>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
              />
              Wireframe mode
            </label>
          </div>

          {bounds && (
            <div style={{ marginTop: "16px", padding: "12px", background: "#f9fafb", borderRadius: "8px", fontSize: "12px" }}>
              <div><strong>X:</strong> [{formatNumber(bounds.x[0])}, {formatNumber(bounds.x[1])}]</div>
              <div><strong>Y:</strong> [{formatNumber(bounds.y[0])}, {formatNumber(bounds.y[1])}]</div>
              <div><strong>Z:</strong> [{formatNumber(bounds.z[0])}, {formatNumber(bounds.z[1])}]</div>
              <div style={{ marginTop: "8px" }}>Vertices: {(vertices?.length || 0) / 3}</div>
            </div>
          )}

          <div style={{ marginTop: "12px", padding: "12px", background: "#eff6ff", borderRadius: "8px", fontSize: "12px", color: "#1e40af" }}>
            <strong>Tip:</strong> Drag to rotate. Auto-rotates slowly.
          </div>
        </div>

        {/* 3D Canvas Panel */}
        <div style={{ flex: "2", minWidth: "400px" }}>
          <div style={{ position: "relative", width: "100%", aspectRatio: "1/1" }}>
            <canvas
              ref={canvasRef}
              style={{
                width: "100%",
                height: "100%",
                background: "#fafafa",
                borderRadius: "8px",
                border: "1px solid #e5e7eb",
                touchAction: "none",
              }}
            />
            {!vertices && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "18px", marginBottom: "8px" }}>📐</div>
                  <div>Enter expressions to generate surface</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}