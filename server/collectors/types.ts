import type { CollectorConfig, LabConfig } from '../config.ts';
import type { Domain, FactStore } from '../facts.ts';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface CollectorContext {
  lab: LabConfig;
  facts: FactStore;
  log: Logger;
  /** Domains real collectors already cover (the simulator skips these in mixed mode). */
  covered: Set<Domain>;
}

export interface Collector {
  id: string;
  kind: string;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Fact domains this collector writes. */
  domains: Domain[];
  /** Fetch from the source and write facts. Throw on failure; the runner records it. */
  poll(now: number): Promise<void>;
  stop?(): void;
}

export type CollectorFactory = (cfg: CollectorConfig, ctx: CollectorContext) => Collector;

/** Small helper for HTTP JSON APIs with a timeout. */
export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 8000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${redact(url)}`);
  return (await res.json()) as T;
}

/** Strips credentials from URLs before they reach logs or the UI. */
export function redact(url: string): string {
  return url.replace(/([?&](?:apikey|api_key|token|X-Plex-Token)=)[^&]+/gi, '$1***');
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
