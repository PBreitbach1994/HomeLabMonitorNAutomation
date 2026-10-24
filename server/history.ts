/** Fixed-size ring buffer of samples; null marks a step with no data. */
export class Ring {
  private buf: (number | null)[];
  private head = 0;
  private count = 0;

  constructor(readonly size: number) {
    this.buf = new Array(size).fill(null);
  }

  push(v: number | null): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.size;
    this.count = Math.min(this.size, this.count + 1);
  }

  /** Oldest → newest, at most `n` most recent samples. */
  values(n = this.count): (number | null)[] {
    const len = Math.min(n, this.count);
    const out: (number | null)[] = new Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = this.buf[(this.head - len + i + this.size) % this.size];
    }
    return out;
  }

  get length(): number {
    return this.count;
  }
}

/** Per-metric ring buffers sampled on a fixed step (default 10s × 360 = 1h). */
export class History {
  private series = new Map<string, Ring>();
  lastSampleAt = 0;

  constructor(
    readonly stepMs = 10_000,
    readonly size = 360,
  ) {}

  due(now: number): boolean {
    return now - this.lastSampleAt >= this.stepMs;
  }

  record(key: string, value: number | null): void {
    let ring = this.series.get(key);
    if (!ring) {
      ring = new Ring(this.size);
      this.series.set(key, ring);
    }
    ring.push(value == null || !Number.isFinite(value) ? null : value);
  }

  get(key: string, n?: number): (number | null)[] {
    return this.series.get(key)?.values(n) ?? [];
  }

  /** Recent values with gaps filled by 0, for sparklines. */
  dense(key: string, n?: number): number[] {
    return this.get(key, n).map((v) => v ?? 0);
  }

  /** Averages consecutive groups of `factor` samples (e.g. 10s → 30s). */
  downsample(key: string, factor: number, n?: number): number[] {
    const vals = this.get(key);
    const out: number[] = [];
    const start = vals.length % factor;
    for (let i = start; i < vals.length; i += factor) {
      const group = vals.slice(i, i + factor).filter((v): v is number => v != null);
      out.push(group.length ? group.reduce((a, b) => a + b, 0) / group.length : 0);
    }
    return n ? out.slice(-n) : out;
  }

  /** Mean of the non-null samples within the last `windowMs`. */
  mean(key: string, windowMs: number): number | null {
    const vals = this.get(key, Math.ceil(windowMs / this.stepMs)).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  keys(): string[] {
    return [...this.series.keys()];
  }
}
