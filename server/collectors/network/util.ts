// Shared plumbing for the network collectors: typed config accessors, an HTTP client built on
// node:http/https (self-signed TLS + unix sockets, which global fetch can't do without undici),
// and a child-process runner for CLI-backed sources (ping, tailscale).

import { execFile } from 'node:child_process';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CollectorConfig } from '../../config.ts';
import { redact, type Logger } from '../types.ts';

/** Default budget for any single network call or child process. */
export const TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// ------------------------------------------------------------------ config

/**
 * Reads a string field. Env interpolation turns an unset `${SECRET}` into '', so empty
 * strings count as "not set". Numbers/booleans are stringified (YAML `community: 1234`).
 */
export function optStr(cfg: CollectorConfig, key: string): string | undefined {
  const v = cfg[key];
  if (typeof v === 'string') return v.length ? v : undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function reqStr(cfg: CollectorConfig, key: string, hint?: string): string {
  const v = optStr(cfg, key);
  if (v == null) throw new Error(`${cfg.kind}: "${key}" is required${hint ? ` (${hint})` : ''}`);
  return v;
}

export function optNum(cfg: CollectorConfig, key: string): number | undefined {
  const v = cfg[key];
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${cfg.kind}: "${key}" must be a number, got ${JSON.stringify(v)}`);
  return n;
}

export function optBool(cfg: CollectorConfig, key: string): boolean | undefined {
  const v = cfg[key];
  if (v == null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  throw new Error(`${cfg.kind}: "${key}" must be true or false, got ${JSON.stringify(v)}`);
}

/** A `{ key: value }` map with string values (YAML may give numbers; they're stringified). */
export function optMap(cfg: CollectorConfig, key: string): Record<string, string> | undefined {
  const v = cfg[key];
  if (v == null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${cfg.kind}: "${key}" must be a map`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val == null || val === '') continue;
    if (typeof val !== 'string' && typeof val !== 'number') {
      throw new Error(`${cfg.kind}: "${key}.${k}" must be a string`);
    }
    out[k] = String(val);
  }
  return out;
}

export function optList(cfg: CollectorConfig, key: string): string[] | undefined {
  const v = cfg[key];
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${cfg.kind}: "${key}" must be a list`);
  return v.filter((x) => x != null && x !== '').map(String);
}

/** `interval` is in seconds in lab.yaml. */
export function intervalMs(cfg: CollectorConfig, defaultS: number): number {
  const s = optNum(cfg, 'interval');
  return (s != null && s > 0 ? s : defaultS) * 1000;
}

export function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Logs a message once per distinct text, so a persistent condition doesn't spam every poll. */
export function onceLogger(log: Logger): (level: 'info' | 'warn', msg: string) => void {
  const seen = new Set<string>();
  return (level, msg) => {
    if (seen.has(msg)) return;
    seen.add(msg);
    log[level](msg);
  };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------ HTTP

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Accept self-signed / untrusted TLS certificates. */
  insecure?: boolean;
  /** Unix socket to connect to instead of the URL's host (Docker, tailscaled). */
  socketPath?: string;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** One HTTP request with a hard deadline covering connect, headers and body. Never throws on status. */
export function request(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const { method = 'GET', headers = {}, body, timeoutMs = TIMEOUT_MS, insecure, socketPath } = opts;
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`invalid URL ${redact(url)}`));
      return;
    }
    const https = u.protocol === 'https:';
    if (!https && u.protocol !== 'http:') {
      reject(new Error(`unsupported URL scheme in ${redact(url)}`));
      return;
    }
    const label = socketPath ? `${method} ${redact(`${u.pathname}${u.search}`)} via ${socketPath}` : `${method} ${redact(url)}`;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label}: ${err.message}`));
    };
    const send = https ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method,
        socketPath,
        // Fresh connection per request: polls are seconds apart, and a pooled keep-alive socket the
        // server has since closed shows up as a spurious "socket hang up".
        agent: false,
        headers: {
          accept: 'application/json',
          ...(body != null ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...headers,
        },
        ...(https ? { rejectUnauthorized: !insecure } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            fail(new Error(`response larger than ${MAX_BODY_BYTES} bytes`));
            req.destroy();
          } else chunks.push(c);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('response aborted')));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    timer = setTimeout(() => {
      fail(new Error(`timed out after ${timeoutMs}ms`));
      req.destroy();
    }, timeoutMs);
    req.on('error', fail);
    if (body != null) req.write(body);
    req.end();
  });
}

export function isOk(res: HttpResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

export function parseJson<T = unknown>(res: HttpResponse, what: string): T {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`${what}: response is not JSON (HTTP ${res.status}, ${res.body.slice(0, 80).replace(/\s+/g, ' ')}…)`);
  }
}

/** GET a JSON document; non-2xx is an error carrying the status. */
export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await request(url, opts);
  if (!isOk(res)) throw new HttpError(res.status, `HTTP ${res.status} from ${redact(url)}`);
  return parseJson<T>(res, redact(url));
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ child processes

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a command with a C locale (stable number formatting) and a deadline. A non-zero exit
 * is *not* an error (ping exits 1 on 100% loss); only failing to start it is.
 */
export function run(bin: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          const code = (err as NodeJS.ErrnoException).code;
          reject(new Error(code === 'ENOENT' ? `"${bin}" not found` : `${bin}: ${code} ${err.message}`));
          return;
        }
        const e = err as (Error & { code?: number; killed?: boolean; signal?: string }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: !!e?.killed,
        });
      },
    );
  });
}
