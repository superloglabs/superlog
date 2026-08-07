import { useEffect, useRef } from "react";

const VERTEX_SHADER = `#version 300 es
precision highp float;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform vec2 u_viewport;
uniform float u_time;
uniform vec2 u_grid;
uniform float u_pixel_ratio;
uniform float u_amplitude;
uniform float u_frequency;
uniform float u_speed;
uniform float u_choppiness;
uniform float u_point_size;

out float v_height;
out float v_foam;
out float v_fresnel;
out float v_fade;

const float WORLD_SIZE = 280.0;

float oceanHeight(vec2 p) {
  p *= u_frequency;
  float t = u_time * u_speed;
  float h = 0.0;
  h += sin(dot(p, normalize(vec2( 0.12, -1.00))) * 0.074 + t * 1.10) * 4.1;
  h += sin(dot(p, normalize(vec2(-0.48, -0.88))) * 0.105 + t * 1.31 + 1.8) * 3.0;
  h += sin(dot(p, normalize(vec2( 0.64, -0.77))) * 0.142 + t * 1.55 + 3.4) * 2.2;
  h += sin(dot(p, normalize(vec2(-0.86, -0.51))) * 0.184 + t * 1.86 + 0.7) * 1.55;
  h += sin(dot(p, normalize(vec2( 0.91, -0.42))) * 0.229 + t * 2.21 + 4.2) * 1.0;
  h += sin(dot(p, normalize(vec2( 0.31, -0.95))) * 0.284 + t * 2.62 + 2.5) * 0.68;
  h += sin(dot(p, normalize(vec2(-0.22, -0.98))) * 0.347 + t * 3.02 + 5.1) * 0.4;
  h += sin(dot(p, normalize(vec2( 0.73, -0.68))) * 0.421 + t * 3.46 + 1.2) * 0.24;
  return h * u_amplitude;
}

vec2 horizontalDisplacement(vec2 p) {
  p *= u_frequency;
  float t = u_time * u_speed;
  vec2 displacement = vec2(0.0);
  vec2 d1 = normalize(vec2( 0.12, -1.00));
  vec2 d2 = normalize(vec2(-0.48, -0.88));
  vec2 d3 = normalize(vec2( 0.64, -0.77));
  vec2 d4 = normalize(vec2(-0.86, -0.51));
  displacement += d1 * cos(dot(p, d1) * 0.074 + t * 1.10) * 2.7;
  displacement += d2 * cos(dot(p, d2) * 0.105 + t * 1.31 + 1.8) * 1.9;
  displacement += d3 * cos(dot(p, d3) * 0.142 + t * 1.55 + 3.4) * 1.25;
  displacement += d4 * cos(dot(p, d4) * 0.184 + t * 1.86 + 0.7) * 0.72;
  return displacement * u_choppiness;
}

void main() {
  float column = mod(float(gl_VertexID), u_grid.x);
  float row = floor(float(gl_VertexID) / u_grid.x);
  vec2 uv = vec2(column, row) / max(u_grid - 1.0, vec2(1.0));
  vec2 base = vec2(
    (uv.x - 0.5) * WORLD_SIZE * 2.45,
    (uv.y - 0.5) * WORLD_SIZE
  );

  float height = oceanHeight(base);
  float epsilon = 0.7;
  float heightX = oceanHeight(base + vec2(epsilon, 0.0));
  float heightZ = oceanHeight(base + vec2(0.0, epsilon));
  vec3 normal = normalize(vec3(height - heightX, epsilon, height - heightZ));
  vec2 chop = horizontalDisplacement(base);
  vec3 worldPosition = vec3(base.x + chop.x, height, base.y + chop.y);

  vec4 viewPosition = u_view * vec4(worldPosition, 1.0);
  vec3 viewDirection = normalize(-viewPosition.xyz);
  float distanceToCamera = -viewPosition.z;
  float distanceFade = 1.0 - smoothstep(80.0, 280.0, distanceToCamera);
  v_fade = mix(0.34, 1.0, pow(clamp(distanceFade, 0.0, 1.0), 1.35));

  v_height = height;
  v_fresnel = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 5.0);
  float compression = 1.0 - normal.y;
  float highCrest = smoothstep(5.0, 10.0, height);
  v_foam = smoothstep(0.18, 0.5, compression + highCrest * 0.24);

  vec4 clipPosition = u_projection * viewPosition;
  vec2 ndc = clipPosition.xy / clipPosition.w;
  float aspect = u_viewport.x / max(u_viewport.y, 1.0);
  vec2 snapped = vec2(ndc.x * aspect, ndc.y);
  snapped = floor(snapped * 50.0) / 50.0;
  snapped.x /= aspect;

  gl_Position = vec4(snapped * clipPosition.w, clipPosition.z, clipPosition.w);
  gl_PointSize = max(1.0, u_point_size * u_pixel_ratio);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 u_viewport;
uniform float u_intensity;

in float v_height;
in float v_foam;
in float v_fresnel;
in float v_fade;

out vec4 out_color;

void main() {
  vec2 point = gl_PointCoord - vec2(0.5);
  if (dot(point, point) > 0.25) discard;

  float crest = smoothstep(-0.5, 1.5, v_height);
  float alpha = 0.075 + crest * 0.11 + v_fresnel * 0.065;
  alpha = mix(alpha, 0.92, v_foam);

  float shade = 0.2 + crest * 0.4 + v_fresnel * 0.16;
  shade = mix(shade, 1.0, v_foam);

  float screenY = gl_FragCoord.y / max(u_viewport.y, 1.0);
  float verticalFade =
    smoothstep(0.0, 0.08, screenY) *
    (1.0 - smoothstep(0.92, 1.0, screenY));
  float finalAlpha = clamp(alpha * v_fade * verticalFade * u_intensity, 0.0, 1.0);
  out_color = vec4(vec3(shade), finalAlpha);
}
`;

export type FluidSignalSettings = {
  amplitude: number;
  frequency: number;
  speed: number;
  choppiness: number;
  pointSize: number;
  intensity: number;
  paused: boolean;
};

export const DEFAULT_FLUID_SIGNAL_SETTINGS: FluidSignalSettings = {
  amplitude: 1.3,
  frequency: 0.7,
  speed: 0.6,
  choppiness: 2.5,
  pointSize: 0.75,
  intensity: 0.9,
  paused: false,
};

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create the hero shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader compilation error.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create the hero shader program.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown shader link error.";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function normalize([x, y, z]: [number, number, number]): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function cross(
  [ax, ay, az]: [number, number, number],
  [bx, by, bz]: [number, number, number],
): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function dot(
  [ax, ay, az]: [number, number, number],
  [bx, by, bz]: [number, number, number],
) {
  return ax * bx + ay * by + az * bz;
}

function lookAt(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
) {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}

function perspective(fieldOfView: number, aspect: number, near: number, far: number) {
  const scale = 1 / Math.tan(fieldOfView / 2);
  const range = 1 / (near - far);
  return new Float32Array([
    scale / aspect,
    0,
    0,
    0,
    0,
    scale,
    0,
    0,
    0,
    0,
    (far + near) * range,
    -1,
    0,
    0,
    2 * far * near * range,
    0,
  ]);
}

function uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string) {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Missing hero shader uniform: ${name}`);
  return location;
}

export function FluidSignalField({
  className = "",
  settings = DEFAULT_FLUID_SIGNAL_SETTINGS,
}: {
  className?: string;
  settings?: FluidSignalSettings;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const settingsRef = useRef(settings);
  const restartRef = useRef<() => void>(() => {});
  settingsRef.current = settings;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
    });
    if (!gl) return;
    const targetCanvas = canvas;
    const renderingContext = gl;

    let program: WebGLProgram;
    try {
      program = createProgram(gl);
    } catch (error) {
      console.warn("Unable to render the landing-page signal field.", error);
      return;
    }

    const vertexArray = gl.createVertexArray();
    gl.bindVertexArray(vertexArray);
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);

    const viewLocation = uniform(gl, program, "u_view");
    const projectionLocation = uniform(gl, program, "u_projection");
    const viewportLocation = uniform(gl, program, "u_viewport");
    const timeLocation = uniform(gl, program, "u_time");
    const gridLocation = uniform(gl, program, "u_grid");
    const pixelRatioLocation = uniform(gl, program, "u_pixel_ratio");
    const amplitudeLocation = uniform(gl, program, "u_amplitude");
    const frequencyLocation = uniform(gl, program, "u_frequency");
    const speedLocation = uniform(gl, program, "u_speed");
    const choppinessLocation = uniform(gl, program, "u_choppiness");
    const pointSizeLocation = uniform(gl, program, "u_point_size");
    const intensityLocation = uniform(gl, program, "u_intensity");

    const view = lookAt([0, 92, 82], [0, -6, -28], [0, 1, 0]);
    gl.uniformMatrix4fv(viewLocation, false, view);

    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let gridColumns = 416;
    let gridRows = 240;
    let animationFrame = 0;
    let visible = true;
    let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

    function resize() {
      const bounds = targetCanvas.getBoundingClientRect();
      width = Math.max(1, Math.round(bounds.width));
      height = Math.max(1, Math.round(bounds.height));
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      gridColumns = width < 720 ? 224 : 416;
      gridRows = width < 720 ? 144 : 240;
      targetCanvas.width = Math.round(width * pixelRatio);
      targetCanvas.height = Math.round(height * pixelRatio);
      renderingContext.viewport(0, 0, targetCanvas.width, targetCanvas.height);
      renderingContext.uniformMatrix4fv(
        projectionLocation,
        false,
        perspective((60 * Math.PI) / 180, width / height, 0.1, 2000),
      );
      renderingContext.uniform2f(viewportLocation, targetCanvas.width, targetCanvas.height);
      renderingContext.uniform2f(gridLocation, gridColumns, gridRows);
      renderingContext.uniform1f(pixelRatioLocation, pixelRatio);
    }

    function draw(timestamp: number) {
      const currentSettings = settingsRef.current;
      renderingContext.clearColor(0, 0, 0, 0);
      renderingContext.clear(renderingContext.COLOR_BUFFER_BIT);
      renderingContext.uniform1f(timeLocation, reducedMotion ? 3.6 : timestamp / 1000);
      renderingContext.uniform1f(amplitudeLocation, currentSettings.amplitude);
      renderingContext.uniform1f(frequencyLocation, currentSettings.frequency);
      renderingContext.uniform1f(speedLocation, currentSettings.speed);
      renderingContext.uniform1f(choppinessLocation, currentSettings.choppiness);
      renderingContext.uniform1f(pointSizeLocation, currentSettings.pointSize);
      renderingContext.uniform1f(intensityLocation, currentSettings.intensity);
      renderingContext.drawArrays(
        renderingContext.POINTS,
        0,
        gridColumns * gridRows,
      );
    }

    function animate(timestamp: number) {
      draw(timestamp);
      if (visible && !reducedMotion && !settingsRef.current.paused) {
        animationFrame = window.requestAnimationFrame(animate);
      }
    }

    function restart() {
      window.cancelAnimationFrame(animationFrame);
      if (visible && !reducedMotion && !settingsRef.current.paused) {
        animationFrame = window.requestAnimationFrame(animate);
      } else {
        draw(3600);
      }
    }
    restartRef.current = restart;

    const resizeObserver = new ResizeObserver(() => {
      resize();
      restart();
    });

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? true;
        restart();
      },
      { rootMargin: "120px" },
    );

    // Guard against environments where the constructors return broken stubs
    // (e.g. aggressive privacy extensions) — the animation still plays, it
    // just won't react to resize or visibility changes.
    try {
      resizeObserver.observe(targetCanvas);
      intersectionObserver.observe(targetCanvas);
    } catch {
      // Resize and intersection tracking unavailable; proceed without them.
    }

    function onMotionPreferenceChange(event: MediaQueryListEvent) {
      reducedMotion = event.matches;
      restart();
    }
    motionPreference.addEventListener("change", onMotionPreferenceChange);

    resize();
    restart();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      motionPreference.removeEventListener("change", onMotionPreferenceChange);
      restartRef.current = () => {};
      gl.deleteVertexArray(vertexArray);
      gl.deleteProgram(program);
    };
  }, []);

  useEffect(() => {
    restartRef.current();
  }, [settings]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none block h-full w-full select-none ${className}`}
    />
  );
}
