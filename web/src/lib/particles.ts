// Canvas particle field: each stream is a sampled curve carrying traffic both ways.
// Density and speed follow measured throughput on a log scale; each particle's colour is
// drawn from the link's protocol mix when it spawns.

import { pointAtFraction, type Sampled } from './geometry.ts';

export interface Stream {
  id: string;
  path: Sampled;
  downBps: number; // flows from path start → end
  upBps: number; // flows end → start
  mix: { color: string; weight: number }[];
  baseColor: string;
  scale?: number; // visual weight (thicker trunks)
  faint?: boolean;
}

interface Particle {
  u: number;
  lane: number;
  color: string;
  size: number;
}

interface StreamState {
  stream: Stream;
  down: Particle[];
  up: Particle[];
  accDown: number;
  accUp: number;
}

const log1p = (bps: number) => Math.log10(1 + bps / 1e6); // 0 at 0, ~3 at 1 Gb/s

/** Particles visible per 300px of path at steady state. */
export function density(bps: number): number {
  if (bps < 2e3) return 0;
  return Math.min(26, 0.8 + 6.5 * log1p(bps));
}

/** Pixels per second. */
export function speed(bps: number): number {
  return 26 + 30 * log1p(bps);
}

export class ParticleField {
  private ctx: CanvasRenderingContext2D;
  private states = new Map<string, StreamState>();
  private sprites = new Map<string, HTMLCanvasElement>();
  private raf = 0;
  private last = 0;
  private reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(
    private canvas: HTMLCanvasElement,
    private width: number,
    private height: number,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setStreams(streams: Stream[]) {
    const seen = new Set<string>();
    for (const s of streams) {
      seen.add(s.id);
      const st = this.states.get(s.id);
      if (st) st.stream = s;
      else {
        const fresh: StreamState = { stream: s, down: [], up: [], accDown: 0, accUp: 0 };
        this.prefill(fresh);
        this.states.set(s.id, fresh);
      }
    }
    for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id);
  }

  start() {
    const loop = (t: number) => {
      const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
      this.last = t;
      this.frame(this.reduced ? 0 : dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private pickColor(s: Stream): string {
    const total = s.mix.reduce((a, m) => a + m.weight, 0);
    if (total <= 0) return s.baseColor;
    let r = Math.random() * total;
    for (const m of s.mix) {
      r -= m.weight;
      if (r <= 0) return m.color;
    }
    return s.mix[s.mix.length - 1].color;
  }

  private spawn(s: Stream, bps: number, u: number): Particle {
    return {
      u,
      lane: (Math.random() - 0.5) * 2.4 * (s.scale ?? 1),
      color: this.pickColor(s),
      size: (0.85 + Math.random() * 0.35) * (0.9 + 0.12 * log1p(bps)) * (s.scale ?? 1),
    };
  }

  private target(s: Stream, bps: number) {
    return Math.round((density(bps) * s.path.total) / 300);
  }

  private prefill(st: StreamState) {
    const { stream: s } = st;
    for (const [list, bps] of [[st.down, s.downBps], [st.up, s.upBps]] as const) {
      const n = this.target(s, bps);
      for (let i = 0; i < n; i++) list.push(this.spawn(s, bps, (i + Math.random() * 0.8) / n));
    }
  }

  private step(st: StreamState, dir: 'down' | 'up', dt: number) {
    const s = st.stream;
    const bps = dir === 'down' ? s.downBps : s.upBps;
    const list = dir === 'down' ? st.down : st.up;
    const du = (speed(bps) * dt) / Math.max(1, s.path.total);
    for (const p of list) p.u += du;
    // Spawn at the rate that keeps the target density: n particles crossing in 1/du frames.
    const n = this.target(s, bps);
    const perSec = (n * speed(bps)) / Math.max(1, s.path.total);
    const key = dir === 'down' ? 'accDown' : 'accUp';
    st[key] += perSec * dt;
    while (st[key] >= 1 && list.length < 90) {
      st[key] -= 1;
      list.push(this.spawn(s, bps, Math.random() * du));
    }
    if (st[key] > 1) st[key] = 0;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].u > 1) list.splice(i, 1);
    // When traffic drops sharply, thin the herd instead of waiting for it to drain.
    while (list.length > n * 1.6 + 2) list.splice(Math.floor(Math.random() * list.length), 1);
  }

  private sprite(color: string): HTMLCanvasElement {
    let c = this.sprites.get(color);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.18, color);
    grad.addColorStop(0.45, `${color}55`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this.sprites.set(color, c);
    return c;
  }

  private frame(dt: number) {
    const { canvas, ctx } = this;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const k = Math.min(cw / this.width, ch / this.height);
    const ox = (cw - this.width * k) / 2;
    const oy = (ch - this.height * k) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    ctx.globalCompositeOperation = 'lighter';

    for (const st of this.states.values()) {
      this.step(st, 'down', dt);
      this.step(st, 'up', dt);
      const s = st.stream;
      for (const dir of ['down', 'up'] as const) {
        const list = dir === 'down' ? st.down : st.up;
        const alpha = (s.faint ? 0.55 : 1) * (dir === 'down' ? 0.95 : 0.6);
        for (const p of list) {
          const pt = pointAtFraction(s.path, dir === 'down' ? p.u : 1 - p.u);
          const lane = dir === 'down' ? p.lane + 0.9 : p.lane - 0.9;
          const r = 5.5 * p.size;
          // Fade in/out over the first and last few percent of the path.
          ctx.globalAlpha = alpha * Math.max(0, Math.min(1, p.u * 14, (1 - p.u) * 14));
          ctx.drawImage(this.sprite(p.color), pt.x + pt.nx * lane - r, pt.y + pt.ny * lane - r, r * 2, r * 2);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
