// Shared plumbing for the media collectors: config validation, HTTP with timeouts and
// secret-safe errors, and small helpers for walking untyped JSON.

import type { CollectorConfig } from '../../config.ts';
import { num, redact, str } from '../types.ts';

export const HTTP_TIMEOUT_MS = 8000;

// ------------------------------------------------------------------ config

export function configError(cfg: CollectorConfig, msg: string): Error {
  return new Error(`${cfg.kind} collector "${cfg.id}": ${msg}`);
}

export function optionalString(cfg: CollectorConfig, field: string): string | undefined {
  const v = cfg[field];
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function requireString(cfg: CollectorConfig, field: string, hint?: string): string {
  const v = optionalString(cfg, field);
  if (!v) throw configError(cfg, `\`${field}\` is required${hint ? ` (${hint})` : ''}`);
  return v;
}

/** Validates `cfg.url` (http/https) and returns it without trailing slashes. */
export function requireUrl(cfg: CollectorConfig, field = 'url'): string {
  const raw = requireString(cfg, field, 'e.g. http://host:port');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw configError(cfg, `\`${field}\` is not a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw configError(cfg, `\`${field}\` must be http:// or https://`);
  if (u.search) throw configError(cfg, `\`${field}\` must not contain a query string (put credentials in their own fields)`);
  return raw.replace(/\/+$/, '');
}

/** `cfg.interval` is in seconds. */
export function intervalMs(cfg: CollectorConfig, defaultSeconds: number): number {
  return Math.round(Math.max(1, num(cfg.interval, defaultSeconds)) * 1000);
}

/** A `{ key: value }` map of strings (e.g. Plex `clients`); anything else is a config error. */
export function stringMap(cfg: CollectorConfig, field: string): Record<string, string> {
  const v = cfg[field];
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw configError(cfg, `\`${field}\` must be a map`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (val != null && val !== '') out[k] = String(val);
  return out;
}

// ------------------------------------------------------------------ secrets

/** Removes secret values (raw and URL-encoded) from a message before it reaches logs or the UI. */
export function scrub(message: string, secrets: readonly (string | undefined)[] = []): string {
  let out = message;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const variant of new Set([s, encodeURIComponent(s)])) out = out.split(variant).join('***');
  }
  return out;
}

// ------------------------------------------------------------------ http

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Values that must never appear in an error message (API keys, passwords, tokens). */
  secrets?: readonly (string | undefined)[];
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  const e = err as (Error & { cause?: { code?: string; message?: string } }) | undefined;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `no response within ${timeoutMs / 1000}s`;
  const detail = e?.cause?.code ?? e?.cause?.message;
  const msg = e?.message ?? String(err);
  return detail && !msg.includes(detail) ? `${msg} (${detail})` : msg;
}

/** fetch() with a timeout; network errors are rethrown with the (redacted) URL and no secrets. */
export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = HTTP_TIMEOUT_MS, secrets = [], ...init } = opts;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(scrub(`${redact(url)}: ${describeFetchError(err, timeoutMs)}`, secrets));
  }
}

/** Reads a JSON body, turning HTTP errors / non-JSON bodies into secret-free errors. */
export async function readJson<T = unknown>(
  res: Response,
  url: string,
  secrets: readonly (string | undefined)[] = [],
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<T> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(res.status, scrub(`${res.status} ${res.statusText}`.trim() + ` from ${redact(url)}`, secrets));
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(scrub(`${redact(url)}: ${describeFetchError(err, timeoutMs)}`, secrets));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(scrub(`unexpected (non-JSON) response from ${redact(url)}`, secrets));
  }
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await httpRequest(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  return readJson<T>(res, url, opts.secrets, opts.timeoutMs);
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ------------------------------------------------------------------ untyped JSON

export type Json = Record<string, unknown>;

export function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** *arr endpoints answer either `{ records: [...] }` (paged) or a bare array. */
export function records(v: unknown): Json[] {
  const rows = Array.isArray(v) ? v : list(obj(v).records);
  return rows.map(obj);
}

/** A finite number, or null (unlike `num`, which needs a fallback). */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = num(v, NaN);
  return Number.isFinite(n) ? n : null;
}

/** ISO date string → epoch ms. Timestamps without a zone are treated as UTC. */
export function parseDate(v: unknown): number | null {
  const s = str(v).trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? `${s}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Unix seconds → epoch ms (0 / missing / negative → null). */
export function fromUnix(v: unknown): number | null {
  const n = numOrNull(v);
  return n != null && n > 0 ? n * 1000 : null;
}

/** `ImportBlocked` → `importBlocked` (older *arr builds serialize enums PascalCase). */
export function lowerFirst(v: unknown): string | undefined {
  const s = str(v).trim();
  return s ? s[0].toLowerCase() + s.slice(1) : undefined;
}

export function clamp01(n: number | null): number | null {
  return n == null ? null : Math.min(1, Math.max(0, n));
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}
