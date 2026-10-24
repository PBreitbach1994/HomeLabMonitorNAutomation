export interface Pt {
  x: number;
  y: number;
}

export interface Curve {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p3: Pt;
}

export function bezierAt(c: Curve, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return {
    x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p3.y,
  };
}

export const curvePath = (c: Curve) =>
  `M${c.p0.x.toFixed(1)},${c.p0.y.toFixed(1)} C${c.c1.x.toFixed(1)},${c.c1.y.toFixed(1)} ${c.c2.x.toFixed(1)},${c.c2.y.toFixed(1)} ${c.p3.x.toFixed(1)},${c.p3.y.toFixed(1)}`;

/** Horizontal S-curve (left → right). */
export function hCurve(a: Pt, b: Pt, k = 0.5): Curve {
  const dx = (b.x - a.x) * k;
  return { p0: a, c1: { x: a.x + dx, y: a.y }, c2: { x: b.x - dx, y: b.y }, p3: b };
}

/** Vertical S-curve (top → bottom). */
export function vCurve(a: Pt, b: Pt, k = 0.5): Curve {
  const dy = (b.y - a.y) * k;
  return { p0: a, c1: { x: a.x, y: a.y + dy }, c2: { x: b.x, y: b.y - dy }, p3: b };
}

export function offsetCurve(c: Curve, dx: number, dy: number): Curve {
  const o = (p: Pt) => ({ x: p.x + dx, y: p.y + dy });
  return { p0: o(c.p0), c1: o(c.c1), c2: o(c.c2), p3: o(c.p3) };
}

/** Arc-length table so particles move at constant speed along a curve. */
export interface Sampled {
  xs: Float32Array;
  ys: Float32Array;
  lens: Float32Array; // cumulative length at each sample
  total: number;
}

export function sampleCurve(c: Curve, n = 48): Sampled {
  const xs = new Float32Array(n + 1);
  const ys = new Float32Array(n + 1);
  const lens = new Float32Array(n + 1);
  let total = 0;
  for (let i = 0; i <= n; i++) {
    const p = bezierAt(c, i / n);
    xs[i] = p.x;
    ys[i] = p.y;
    if (i > 0) total += Math.hypot(p.x - xs[i - 1], p.y - ys[i - 1]);
    lens[i] = total;
  }
  return { xs, ys, lens, total };
}

/** Position and unit normal at fraction `u` (0..1) of the arc length. */
export function pointAtFraction(s: Sampled, u: number): { x: number; y: number; nx: number; ny: number } {
  const target = Math.min(1, Math.max(0, u)) * s.total;
  let lo = 0;
  let hi = s.lens.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (s.lens[mid] < target) lo = mid;
    else hi = mid;
  }
  const seg = s.lens[hi] - s.lens[lo] || 1;
  const f = (target - s.lens[lo]) / seg;
  const dx = s.xs[hi] - s.xs[lo];
  const dy = s.ys[hi] - s.ys[lo];
  const len = Math.hypot(dx, dy) || 1;
  return { x: s.xs[lo] + dx * f, y: s.ys[lo] + dy * f, nx: -dy / len, ny: dx / len };
}
