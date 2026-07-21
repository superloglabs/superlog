// @ts-nocheck -- upstream Dither Kit source is not noUncheckedIndexedAccess-safe.
type Row = Record<string, unknown>;

const TOP = -Math.PI / 2;
const TAU = Math.PI * 2;

export type PieSlice = {
  name: string;
  value: number;
  start: number; // radians
  end: number;
  mid: number;
};

/** Slice angles from each data row's value under `dataKey`, named by `nameKey`. */
export function pieSlices(data: Row[], dataKey: string, nameKey: string): PieSlice[] {
  const vals = data.map((r) => Math.max(0, Number(r[dataKey]) || 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  let a = TOP;
  return data.map((r, i) => {
    const span = (vals[i] / total) * TAU;
    const slice = {
      name: String(r[nameKey] ?? i),
      value: vals[i],
      start: a,
      end: a + span,
      mid: a + span / 2,
    };
    a += span;
    return slice;
  });
}

/** Which slice a pointer angle falls in (or -1). */
export function sliceAtAngle(slices: PieSlice[], angle: number): number {
  // Normalize so comparisons against [start, end) (which begin at TOP) work.
  let a = angle;
  while (a < TOP) a += TAU;
  while (a >= TOP + TAU) a -= TAU;
  return slices.findIndex((s) => a >= s.start && a < s.end);
}

export type RadarAxis = { label: string; angle: number };

/** Evenly-spaced spokes, one per data row, labelled by `nameKey`. */
export function radarAxes(data: Row[], nameKey: string): RadarAxis[] {
  const n = Math.max(data.length, 1);
  return data.map((r, i) => ({
    label: String(r[nameKey] ?? i),
    angle: TOP + (i / n) * TAU,
  }));
}

/** Nearest radar spoke to a pointer angle. */
export function axisAtAngle(axes: RadarAxis[], angle: number): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  axes.forEach((ax, i) => {
    let d = Math.abs(((angle - ax.angle + Math.PI * 3) % TAU) - Math.PI);
    d = Math.abs(d);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export const polarX = (cx: number, r: number, angle: number) => cx + Math.cos(angle) * r;
export const polarY = (cy: number, r: number, angle: number) => cy + Math.sin(angle) * r;

/** Even-odd point-in-polygon test (polygon as flat [x0,y0,x1,y1,…]). */
export function pointInPolygon(px: number, py: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance from a point to the nearest edge of a polygon — drives the radial
 * dither density (dense near the edge, thinning to the centre). */
export function distToPolygonEdge(px: number, py: number, poly: number[]): number {
  let best = Number.POSITIVE_INFINITY;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    const dx = xj - xi;
    const dy = yj - yi;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - xi) * dx + (py - yi) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const ex = xi + t * dx - px;
    const ey = yi + t * dy - py;
    const d = Math.hypot(ex, ey);
    if (d < best) best = d;
  }
  return best;
}
