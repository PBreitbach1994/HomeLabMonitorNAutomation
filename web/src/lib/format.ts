export const DASH = '—';

/** 868 Mb/s · 2.6 Gb/s · 372 kb/s */
export function fmtBps(bps: number | null | undefined, opts: { unit?: boolean } = {}): string {
  if (bps == null || !Number.isFinite(bps)) return DASH;
  const unit = opts.unit ?? true;
  const [v, u] =
    bps >= 1e9 ? [bps / 1e9, 'Gb/s'] : bps >= 1e6 ? [bps / 1e6, 'Mb/s'] : bps >= 1e3 ? [bps / 1e3, 'kb/s'] : [bps, 'b/s'];
  const digits = v >= 100 || u === 'b/s' ? 0 : v >= 10 ? (u === 'Gb/s' ? 1 : 0) : 1;
  return `${v.toFixed(digits)}${unit ? ` ${u}` : ''}`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b)) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtPct(x: number | null | undefined, digits = 0): string {
  if (x == null || !Number.isFinite(x)) return DASH;
  const p = x * 100;
  if (p > 0 && p < 1) return '<1%';
  return `${p.toFixed(digits)}%`;
}

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null) return DASH;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtUptime(s: number | null | undefined): string {
  if (s == null) return DASH;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return DASH;
  return ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();
}

/** Compact axis ticks: 0 · 500M · 1G */
export function fmtAxisBps(bps: number): string {
  if (bps === 0) return '0';
  if (bps >= 1e9) return `${+(bps / 1e9).toFixed(1)}G`;
  if (bps >= 1e6) return `${Math.round(bps / 1e6)}M`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)}k`;
  return `${Math.round(bps)}`;
}

/** Rounds a max value up to a clean axis ceiling and returns evenly spaced ticks. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}
