// @ts-nocheck -- upstream Dither Kit source is not noUncheckedIndexedAccess-safe.
"use client";

import { type RefObject, useEffect, useMemo, useRef } from "react";
import { type ChartContextValue, useChart } from "./chart-context";
import {
  backingSize,
  bloomLayerStyle,
  easeInOutCubic,
  paintColumn,
  prefersReducedMotion,
  resample,
} from "./dither-paint";
import { rgb } from "./palette";

type Star = { key: string; xi: number; depth: number; phase: number };
type Surface = { top: number[]; floor: number[] };

type LoopArgs = {
  canvas: HTMLCanvasElement;
  bloomCanvas: HTMLCanvasElement | null;
  cols: number;
  rows: number;
  state: RefObject<ChartContextValue>;
  targets: RefObject<Record<string, Surface>>;
  stars: RefObject<Star[]>;
};

/**
 * The requestAnimationFrame paint loop — eases each series toward its target
 * surface, paints the dither fill (with the entrance reveal), then layers the
 * crosshair marker and winking stars on top. Lives outside the component so the
 * component stays small and this hot closure isn't re-created on every render.
 * Returns a cleanup that cancels the loop.
 */
function startCartesianLoop({
  canvas,
  bloomCanvas,
  cols,
  rows,
  state,
  targets,
  stars,
}: LoopArgs): (() => void) | undefined {
  const c = canvas.getContext("2d");
  if (!c || cols <= 0 || rows <= 0) return undefined;
  canvas.width = cols;
  canvas.height = rows;

  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const octx = off.getContext("2d");
  if (!octx) return undefined;

  // Bloom layer: a blurred, additive copy of the crisp canvas.
  const bloomCtx = bloomCanvas?.getContext("2d") ?? null;
  if (bloomCanvas) {
    bloomCanvas.width = cols;
    bloomCanvas.height = rows;
  }

  const reduce = prefersReducedMotion();
  const EASE = reduce ? 1 : 0.18;
  const animate = state.current.animate && !reduce;
  const duration = state.current.animationDuration;
  const current: Record<string, Surface> = {};

  // `reveal` (0–1) sweeps the fill in left-to-right on first paint.
  const paintFill = (intensity: number, reveal: number) => {
    octx.clearRect(0, 0, cols, rows);
    const s = state.current;
    const stacked = s.stackType === "stacked" || s.stackType === "percent";
    const revealCols = Math.ceil(reveal * cols);
    s.configKeys.forEach((key, si) => {
      const cur = current[key];
      if (!cur) return;
      const seed = s.seedOf(key);
      const variant = s.seriesSpecs[key]?.variant ?? "gradient";
      const isLine =
        (s.seriesSpecs[key]?.kind ?? (s.chartType === "line" ? "line" : "area")) === "line";
      const emphasis = s.selectedDataKey ?? s.focusDataKey;
      const dim = emphasis !== null && emphasis !== key ? 0.3 : 1;
      // Overlapping (non-stacked) layers thin out front-to-back so they
      // read as distinct layers instead of a muddy blend.
      const sparse = stacked ? 0 : si * 0.14;
      for (let x = 0; x < cols; x++) {
        if (x > revealCols) break;
        // For a value that dips below the zero baseline the value line ends up
        // *below* the floor in pixels; paintColumn needs the higher edge first,
        // so order the pair (a no-op for the common positive case).
        const a = cur.top[x] ?? 0;
        const b = cur.floor[x] ?? 0;
        paintColumn(octx, x, Math.min(a, b), Math.max(a, b), seed, {
          variant,
          intensity,
          dim,
          stacked: stacked && !isLine,
          sparse,
        });
      }
    });
  };

  let raf = 0;
  let tick = 0;
  let last = 0;
  let animStart = 0;
  let lastProg = -1;
  let lastRevision = state.current.revision;
  let entranceReported = !animate;
  let intensity = 0;
  let needsFill = true;
  let lastPaintSig = "";
  let lastSelected: string | null | undefined = Symbol() as never;

  const draw = (now: number) => {
    raf = requestAnimationFrame(draw);
    const s = state.current;
    if (!s.ready) return;
    // Keep the bloom layer in sync with the crisp canvas while it's active.
    if (bloomCtx) {
      const on = s.bloom !== "off" && (!s.bloomOnHover || s.isMouseInChart || s.hovered);
      if (on) {
        bloomCtx.clearRect(0, 0, cols, rows);
        bloomCtx.drawImage(canvas, 0, 0);
      }
    }
    const tgt = targets.current;
    if (s.revision !== lastRevision) {
      lastRevision = s.revision;
      animStart = 0; // re-play the entrance on data change / replay
      lastProg = -1;
      entranceReported = false;
    }
    if (!animStart) animStart = now;
    const prog = animate ? Math.min(1, (now - animStart) / duration) : 1;
    const progChanged = prog !== lastProg;
    // Tell the context the reveal is done so DOM markers fade in in sync.
    if (prog >= 1 && !entranceReported) {
      entranceReported = true;
      s.markEntranceDone();
    }

    let moving = false;
    for (const key of s.configKeys) {
      const t = tgt[key];
      if (!t) continue;
      const cur = current[key];
      if (!cur || cur.top.length !== cols) {
        current[key] = { top: t.top.slice(), floor: t.floor.slice() };
        needsFill = true;
        continue;
      }
      for (let x = 0; x < cols; x++) {
        const dt = t.top[x] - cur.top[x];
        const df = t.floor[x] - cur.floor[x];
        if (Math.abs(dt) > 0.01 || Math.abs(df) > 0.01) {
          cur.top[x] += dt * EASE;
          cur.floor[x] += df * EASE;
          moving = true;
        } else {
          cur.top[x] = t.top[x];
          cur.floor[x] = t.floor[x];
        }
      }
    }
    for (const key of Object.keys(current)) {
      if (!tgt[key]) {
        delete current[key];
        needsFill = true;
      }
    }
    if (moving) needsFill = true;
    const emphasisNow = s.selectedDataKey ?? s.focusDataKey;
    if (emphasisNow !== lastSelected) {
      lastSelected = emphasisNow;
      needsFill = true;
    }

    const itTarget = s.isMouseInChart || s.hovered ? 1 : 0;
    let settling = false;
    if (Math.abs(intensity - itTarget) > 0.001) {
      intensity += (itTarget - intensity) * 0.16;
      settling = true;
      needsFill = true;
    } else intensity = itTarget;

    // Live hover wins; the controlled markerIndex (e.g. a committed point)
    // is the fallback shown when nothing is hovered.
    const marker = s.hoverIndex != null ? s.hoverIndex : s.markerIndex;
    const winkDue = !reduce && now - last >= 100;
    // Repaint when a tweak-driven paint input changes (variant, stacking) so
    // the panel updates the fill live — without resetting the entrance reveal.
    const paintSig = `${s.stackType}|${s.configKeys
      .map((k) => s.seriesSpecs[k]?.variant ?? "")
      .join(",")}`;
    const sigChanged = paintSig !== lastPaintSig;
    if (sigChanged) {
      lastPaintSig = paintSig;
      needsFill = true;
    }
    if (!(moving || settling || winkDue || marker != null || progChanged || sigChanged)) return;
    if (progChanged) {
      lastProg = prog;
      needsFill = true;
    }
    if (winkDue) {
      last = now;
      tick += 1;
    }

    // Reveal front (left-to-right) — stars + crosshair stay behind it so
    // they don't float over the not-yet-drawn area during the entrance.
    const reveal = animate ? easeInOutCubic(prog) : 1;
    const revealCols = reveal * cols;

    if (needsFill) {
      paintFill(intensity, reveal);
      needsFill = false;
    }
    c.clearRect(0, 0, cols, rows);
    c.drawImage(off, 0, 0);

    const mx =
      marker != null && s.dataLength > 1
        ? Math.round((marker / (s.dataLength - 1)) * (cols - 1))
        : -1;
    if (mx >= 0 && mx <= revealCols) {
      for (const key of s.configKeys) {
        const cur = current[key];
        if (!cur) continue;
        const seed = s.seedOf(key);
        const my = Math.round(cur.top[mx] ?? 0);
        // Full-height column + a chunky marker block at the point — the
        // series colour at higher opacity, so it reads on either theme.
        c.fillStyle = rgb(seed.fill, 1, 0.55);
        for (let y = my; y < rows; y++) c.fillRect(mx, y, 1, 1);
        c.fillStyle = rgb(seed.fill);
        c.fillRect(mx - 1, my - 1, 3, 3);
      }
    }

    for (const star of stars.current) {
      const cur = current[star.key];
      if (!cur) continue;
      const sx = Math.round((star.xi / Math.max(s.dataLength - 1, 1)) * (cols - 1));
      if (sx > revealCols) continue; // behind the reveal front
      const top = cur.top[sx] ?? 0;
      const floor = cur.floor[sx] ?? rows - 1;
      const sy = Math.round(top + star.depth * (floor - top));
      const tw = reduce ? 0.85 : (Math.sin((tick + star.phase) * 0.35) + 1) / 2;
      const lift = tw * (0.7 + 0.3 * intensity);
      if (lift < 0.55 || sy < 0 || sy >= rows) continue;
      // Sparkles glint in the series colour via opacity (the `lift` wink)
      // rather than a lighter shade — so they never read as stray white
      // pixels on a light background.
      const starColor = s.seedOf(star.key).fill;
      c.fillStyle = rgb(starColor, 1, lift);
      c.fillRect(sx, sy, 1, 1);
      // At the peak of a wink the star flares into a 4-point glint.
      if (tw > 0.9) {
        c.fillStyle = rgb(starColor, 1, lift * 0.6 * (tw - 0.9) * 10);
        c.fillRect(sx - 1, sy, 1, 1);
        c.fillRect(sx + 1, sy, 1, 1);
        c.fillRect(sx, sy - 1, 1, 1);
        c.fillRect(sx, sy + 1, 1, 1);
      }
    }
  };

  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}

/**
 * Continuous dither canvas for area and line charts. Each series is reduced to a
 * `[top, floor]` band per backing column: areas fill from their value line down
 * to their floor; lines fill only a thin glow band hugging the line. The shared
 * {@link paintColumn} renders the ordered-dither scatter, capped by the bright
 * series line, with winking stars + scrub crosshair on top.
 */
export function CartesianCanvas() {
  const ctx = useChart();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bloomRef = useRef<HTMLCanvasElement>(null);

  const { width, height } = ctx.plot;
  const { cols, rows } = backingSize(width, height);
  const { ready, chartType, configKeys, bands, seriesSpecs, y, dataLength } = ctx;

  // Memoized: the pricey bit in the render path — a `resample` per series to
  // the backing column count. The canvas re-renders on every hover/cursor tick
  // (it consumes ctx), so without this the whole surface is rebuilt each time.
  // Pinned to the exact ctx fields it reads, plus the backing geometry.
  const targets = useMemo(() => {
    const out: Record<string, Surface> = {};
    if (!ready) return out;
    const h = height || 1;
    const glow = Math.max(6, Math.round(rows * 0.16));
    const defaultKind = chartType === "line" ? "line" : "area";
    for (const key of configKeys) {
      const band = bands[key];
      if (!band) continue;
      const line = (seriesSpecs[key]?.kind ?? defaultKind) === "line";
      const top = band.map((b) => (y(b[1]) / h) * (rows - 1));
      const floor = band.map((b, i) =>
        line ? Math.min(rows - 1, top[i] + glow) : (y(b[0]) / h) * (rows - 1),
      );
      out[key] = { top: resample(top, cols), floor: resample(floor, cols) };
    }
    return out;
  }, [ready, chartType, configKeys, bands, seriesSpecs, y, height, rows, cols]);

  // Memoized: the star field is deterministic — only its shape (series ×
  // column count) matters, so it need not be rebuilt on unrelated re-renders.
  const stars = useMemo(() => {
    const out: Star[] = [];
    const per = Math.max(4, Math.round(cols / 14));
    configKeys.forEach((key, k) => {
      for (let i = 0; i < per; i++) {
        const seed = i * 67 + 13 + k * 131;
        out.push({
          key,
          xi: seed % Math.max(dataLength, 1),
          depth: ((seed * 53 + 7) % 100) / 100,
          phase: (seed * 41) % 360,
        });
      }
    });
    return out;
  }, [configKeys, dataLength, cols]);

  // The RAF loop reads these through refs so it always sees the latest values
  // without re-subscribing. Refs are written in an effect (never during
  // render) — mutating a ref mid-render is a React anti-pattern that tears
  // under Strict Mode / concurrent rendering.
  const stateRef = useRef(ctx);
  const targetsRef = useRef(targets);
  const starsRef = useRef(stars);
  useEffect(() => {
    stateRef.current = ctx;
    targetsRef.current = targets;
    starsRef.current = stars;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startCartesianLoop({
      canvas,
      bloomCanvas: bloomRef.current,
      cols,
      rows,
      state: stateRef,
      targets: targetsRef,
      stars: starsRef,
    });
  }, [cols, rows]);

  const bloomActive = ctx.bloomOnHover ? ctx.isMouseInChart || ctx.hovered : true;
  const bloom = bloomLayerStyle(ctx.bloom, bloomActive);
  const pos = {
    left: ctx.margins.left,
    top: ctx.margins.top,
    width,
    height,
  } as const;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute"
        style={{ ...pos, imageRendering: "pixelated" }}
      />
      <canvas
        ref={bloomRef}
        className="pointer-events-none absolute"
        style={{
          ...pos,
          transition: "opacity 220ms ease",
          ...(bloom ?? { opacity: 0 }),
        }}
      />
    </>
  );
}
