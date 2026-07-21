// @ts-nocheck -- upstream Dither Kit source is not noUncheckedIndexedAccess-safe.
import { useEffect, useRef } from "react";
import {
  BAYER,
  OFF_TIER,
  backingSize,
  bloomLayerStyle,
  easeInOutCubic,
  prefersReducedMotion,
} from "./dither-paint";
import { rgb } from "./palette";
import { sliceAtAngle } from "./polar";
import { usePolarChart } from "./polar-context";

const TOP = -Math.PI / 2;
const TAU = Math.PI * 2;
const POP = 6; // px the hovered slice bulges outward

/**
 * Dither canvas for pie / donut charts. Each backing pixel is mapped back to
 * plot space, tested for its slice by angle, and filled with the ordered-dither
 * scatter — dense at the outer edge, thinning toward the centre — capped by a
 * bright arc on the rim. The pie sweeps in clockwise on mount; the hovered slice
 * bulges outward with a brighter rim while the rest dim.
 */
export function PieCanvas() {
  const ctx = usePolarChart();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bloomRef = useRef<HTMLCanvasElement>(null);

  const { width, height } = ctx.plot;
  const { cols, rows } = backingSize(width, height);

  // The RAF loop reads the latest ctx through a ref; written in an effect
  // (never during render) — mutating a ref mid-render tears under Strict Mode /
  // concurrent rendering.
  const state = useRef(ctx);
  useEffect(() => {
    state.current = ctx;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const c = canvas?.getContext("2d");
    if (!(canvas && c) || cols <= 0 || rows <= 0) return;
    canvas.width = cols;
    canvas.height = rows;

    const bloomCanvas = bloomRef.current;
    const bloomCtx = bloomCanvas?.getContext("2d") ?? null;
    if (bloomCanvas) {
      bloomCanvas.width = cols;
      bloomCanvas.height = rows;
    }

    const reduce = prefersReducedMotion();
    const animate = state.current.animate && !reduce;
    const duration = state.current.animationDuration;
    let raf = 0;
    let animStart = 0;
    let lastProg = -1;
    let lastRevision = state.current.revision;
    let intensity = 0;
    let popEase = 0; // eases the hovered slice's outward bulge
    let needsFill = true;
    let lastPaintSig = "";
    let lastSelected: string | null | undefined = Symbol() as never;
    let lastHover: number | null | undefined = Symbol() as never;

    const paint = (prog: number) => {
      const s = state.current;
      const slices = s.pie;
      if (!slices) return;
      c.clearRect(0, 0, cols, rows);
      const cx = s.center.x;
      const cy = s.center.y;
      const outerR = s.outerRadius;
      const innerR = s.innerRadius;
      const revealAngle = TOP + easeInOutCubic(prog) * TAU;

      for (let y = 0; y < rows; y++) {
        const py = ((y + 0.5) * height) / rows;
        for (let x = 0; x < cols; x++) {
          const px = ((x + 0.5) * width) / cols;
          const dx = px - cx;
          const dy = py - cy;
          const r = Math.hypot(dx, dy);
          if (r < innerR) continue;
          const angle = Math.atan2(dy, dx);
          let na = angle;
          while (na < TOP) na += TAU;
          while (na >= TOP + TAU) na -= TAU;
          if (na > revealAngle) continue; // clockwise sweep-in
          const si = sliceAtAngle(slices, angle);
          if (si < 0) continue;
          const slice = slices[si];
          const active = s.hoverIndex === si;
          const localOuter = active ? outerR + POP * popEase : outerR;
          if (r > localOuter) continue;

          const seed = s.seedOf(slice.name);
          const variant = s.variantOf(slice.name);
          const emphasis = s.selectedDataKey ?? s.focusDataKey;
          const selDim = emphasis !== null && emphasis !== slice.name ? 0.3 : 1;
          const it = intensity + (active ? 0.4 * popEase : 0);

          // Bright rim on the outer edge — thicker on the hovered slice.
          if (localOuter - r < (active ? 1.4 + popEase : 1.4)) {
            c.fillStyle = rgb(seed.fill, 1, selDim);
            c.fillRect(x, y, 1, 1);
            continue;
          }
          const density = (r - innerR) / Math.max(localOuter - innerR, 1);
          const bias = variant === "dotted" ? 0.12 : 0;
          if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
          const lit = variant === "solid" || density > BAYER[y & 3][x & 3] - 0.1 * it - bias;
          if (variant === "dotted" && !lit) continue;
          // Density → opacity (see the colour-vs-opacity note in dither-paint);
          // off cells drop to a faint tier, never a hole to the background.
          const k = (0.35 + density * 0.65) * (1 + 0.22 * it);
          const alpha = Math.min(1, (lit ? k : k * OFF_TIER) * selDim);
          c.fillStyle = rgb(seed.fill, 1, alpha);
          c.fillRect(x, y, 1, 1);
        }
      }
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const s = state.current;
      if (!s.ready || !s.pie) return;
      if (bloomCtx) {
        const on = s.bloom !== "off" && (!s.bloomOnHover || s.isMouseInChart);
        if (on) {
          bloomCtx.clearRect(0, 0, cols, rows);
          bloomCtx.drawImage(canvas, 0, 0);
        }
      }
      if (s.revision !== lastRevision) {
        lastRevision = s.revision;
        animStart = 0;
        lastProg = -1;
      }
      if (!animStart) animStart = now;
      const prog = animate ? Math.min(1, (now - animStart) / duration) : 1;

      const emphasisNow = s.selectedDataKey ?? s.focusDataKey;
      if (emphasisNow !== lastSelected) {
        lastSelected = emphasisNow;
        needsFill = true;
      }
      if (s.hoverIndex !== lastHover) {
        lastHover = s.hoverIndex;
        popEase = 0; // a freshly-hovered slice bulges out from rest
        needsFill = true;
      }
      const itTarget = s.isMouseInChart ? 1 : 0;
      if (Math.abs(intensity - itTarget) > 0.001) {
        intensity += (itTarget - intensity) * (reduce ? 1 : 0.16);
        needsFill = true;
      } else intensity = itTarget;
      // Ease the hovered slice's bulge in (and back out when nothing's hovered).
      const popTarget = s.hoverIndex != null ? 1 : 0;
      if (Math.abs(popEase - popTarget) > 0.001) {
        popEase += (popTarget - popEase) * (reduce ? 1 : 0.22);
        needsFill = true;
      } else popEase = popTarget;
      if (prog !== lastProg) {
        lastProg = prog;
        needsFill = true;
      }

      // Live tweak repaint (variant, donut inner radius) without re-sweeping.
      const paintSig = `${s.innerRadius}|${s.pie.map((sl) => s.variantOf(sl.name)).join(",")}`;
      if (paintSig !== lastPaintSig) {
        lastPaintSig = paintSig;
        needsFill = true;
      }

      if (!needsFill) return;
      paint(prog);
      needsFill = false;
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [cols, rows, width, height]);

  const bloom = bloomLayerStyle(ctx.bloom, ctx.bloomOnHover ? ctx.isMouseInChart : true);
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
