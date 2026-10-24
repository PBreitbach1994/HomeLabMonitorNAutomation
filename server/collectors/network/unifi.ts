// UniFi Network collector: switch port counters from `stat/device` → facts.ifaces.
// Keys are "<node>/<port_idx>", matching `measure: flex-a/3` in lab.yaml.
//
// UniFi OS consoles (UDM, UCG, Cloud Key Gen2+, UniFi OS Server):
//   POST /api/auth/login → TOKEN cookie + x-csrf-token header
//   GET  /proxy/network/api/s/{site}/stat/device
// Legacy self-hosted Network Application (no UniFi OS): POST /api/login, GET /api/s/{site}/stat/device.

import type { CollectorConfig } from '../../config.ts';
import type { IfaceSample } from '../../facts.ts';
import type { Collector, CollectorContext } from '../types.ts';
import {
  type HttpResponse, intervalMs, isOk, onceLogger, optBool, optMap, optStr, parseJson, reqStr, request, stripSlash,
} from './util.ts';

export interface UnifiPort {
  key: string;
  node: string;
  mac: string;
  portIdx: number;
  name?: string;
  sample: IfaceSample;
}

export interface UnifiParse {
  ports: UnifiPort[];
  /** Configured switches not present (or not connected) in the controller's response. */
  missing: { mac: string; node: string }[];
}

/** Lower-case, colon-separated; accepts "AA-BB-…", "aabb.ccdd.eeff", "aabbccddeeff". */
export function normalizeMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex.match(/../g)!.join(':') : mac.toLowerCase();
}

type Json = Record<string, unknown>;

/**
 * Maps `stat/device` port tables to iface samples for the switches listed in `devices`
 * (MAC → topology node id). Devices that aren't connected (state ≠ 1) are left out so their
 * links go stale instead of showing a flat zero.
 */
export function parseUnifiDevices(json: unknown, devices: Record<string, string>): UnifiParse {
  const body = json as { meta?: { rc?: string; msg?: string }; data?: unknown } | unknown[];
  if (!Array.isArray(body) && body?.meta?.rc === 'error') {
    throw new Error(`UniFi API error: ${body.meta.msg ?? 'unknown'}`);
  }
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
  if (!list) throw new Error('UniFi stat/device: unexpected response shape (no data[])');

  const byMac = new Map(Object.entries(devices).map(([mac, node]) => [normalizeMac(mac), node]));
  const seen = new Set<string>();
  const ports: UnifiPort[] = [];
  for (const d of list as Json[]) {
    const mac = typeof d.mac === 'string' ? normalizeMac(d.mac) : '';
    const node = byMac.get(mac);
    if (!node) continue;
    if (typeof d.state === 'number' && d.state !== 1) continue;
    seen.add(mac);
    for (const p of Array.isArray(d.port_table) ? (d.port_table as Json[]) : []) {
      const portIdx = typeof p.port_idx === 'number' ? p.port_idx : Number(p.port_idx);
      const rx = Number(p.rx_bytes);
      const tx = Number(p.tx_bytes);
      if (!Number.isFinite(portIdx) || !Number.isFinite(rx) || !Number.isFinite(tx)) continue;
      const speed = Number(p.speed);
      ports.push({
        key: `${node}/${portIdx}`,
        node,
        mac,
        portIdx,
        name: typeof p.name === 'string' ? p.name : undefined,
        sample: {
          inOctets: rx, // bytes the switch received on this port
          outOctets: tx,
          speedBps: Number.isFinite(speed) ? speed * 1e6 : undefined,
          up: p.enable === false ? false : typeof p.up === 'boolean' ? p.up : undefined,
        },
      });
    }
  }
  const missing = [...byMac].filter(([mac]) => !seen.has(mac)).map(([mac, node]) => ({ mac, node }));
  return { ports, missing };
}

// ------------------------------------------------------------------ client

function cookiesFrom(res: HttpResponse): string[] {
  const raw = res.headers['set-cookie'] ?? [];
  return raw.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=') && !/=\s*$/.test(c));
}

function header(res: HttpResponse, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

interface ClientOptions {
  url: string;
  username: string;
  password: string;
  site: string;
  insecure: boolean;
  /** Force the legacy controller API instead of auto-detecting. */
  legacy?: boolean;
}

export class UnifiClient {
  private cookie: string | null = null;
  private csrf: string | null = null;
  private mode: 'unifios' | 'legacy' | null;
  private loginBlockedUntil = 0;
  private loginFailures = 0;

  constructor(private o: ClientOptions) {
    this.mode = o.legacy == null ? null : o.legacy ? 'legacy' : 'unifios';
  }

  private send(path: string, method = 'GET', body?: unknown): Promise<HttpResponse> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    return request(`${this.o.url}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      insecure: this.o.insecure,
    });
  }

  private remember(res: HttpResponse) {
    const updated = header(res, 'x-updated-csrf-token') ?? header(res, 'x-csrf-token');
    if (updated) this.csrf = updated;
  }

  async login(now = Date.now()): Promise<void> {
    if (now < this.loginBlockedUntil) {
      throw new Error(`UniFi login was rejected; next attempt in ${Math.ceil((this.loginBlockedUntil - now) / 1000)}s`);
    }
    this.cookie = null;
    this.csrf = null;
    // The console answered but said no: back off so a wrong password doesn't trip its login
    // throttling / lockout. (Network errors propagate from send() without backoff.)
    const rejected = (msg: string): never => {
      this.loginFailures++;
      this.loginBlockedUntil = now + Math.min(10 * 60_000, 30_000 * 2 ** (this.loginFailures - 1));
      throw new Error(msg);
    };
    const creds = { username: this.o.username, password: this.o.password };
    if (this.mode !== 'legacy') {
      const res = await this.send('/api/auth/login', 'POST', creds);
      if (res.status === 404 && this.mode == null) {
        this.mode = 'legacy';
      } else if (isOk(res)) {
        this.mode = 'unifios';
        this.cookie = cookiesFrom(res).join('; ') || null;
        this.remember(res);
      } else {
        rejected(`UniFi OS login failed: HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
      }
    }
    if (this.mode === 'legacy') {
      const res = await this.send('/api/login', 'POST', creds);
      if (!isOk(res)) rejected(`UniFi controller login failed: HTTP ${res.status}`);
      const cookies = cookiesFrom(res);
      this.cookie = cookies.join('; ') || null;
      this.csrf = cookies.find((c) => c.startsWith('csrf_token='))?.slice('csrf_token='.length) ?? null;
    }
    if (!this.cookie) rejected('UniFi login returned no session cookie');
    this.loginFailures = 0;
  }

  private devicePath(): string {
    const site = encodeURIComponent(this.o.site);
    return this.mode === 'legacy' ? `/api/s/${site}/stat/device` : `/proxy/network/api/s/${site}/stat/device`;
  }

  async statDevice(now = Date.now()): Promise<unknown> {
    if (!this.cookie) await this.login(now);
    let res = await this.send(this.devicePath());
    if (res.status === 401) {
      await this.login(now);
      res = await this.send(this.devicePath());
    }
    if (!isOk(res)) {
      if (res.status === 401) this.cookie = null;
      throw new Error(`UniFi stat/device: HTTP ${res.status}${res.status === 404 ? ` (is site "${this.o.site}" right?)` : ''}`);
    }
    this.remember(res);
    return parseJson(res, 'UniFi stat/device');
  }
}

export function createUnifi(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = stripSlash(reqStr(cfg, 'url', 'e.g. https://192.168.4.2'));
  const username = reqStr(cfg, 'username');
  const password = reqStr(cfg, 'password');
  const devices = optMap(cfg, 'devices') ?? {};
  if (!Object.keys(devices).length) throw new Error('unifi: "devices" (switch MAC → node id) needs at least one entry');
  const client = new UnifiClient({
    url,
    username,
    password,
    site: optStr(cfg, 'site') ?? 'default',
    insecure: optBool(cfg, 'insecure') ?? false,
    legacy: optBool(cfg, 'legacy'),
  });
  const once = onceLogger(ctx.log);

  return {
    id: cfg.id,
    kind: 'unifi',
    intervalMs: intervalMs(cfg, 10),
    domains: ['ifaces'],
    async poll(now) {
      const { ports, missing } = parseUnifiDevices(await client.statDevice(now), devices);
      if (missing.length) {
        const names = missing.map((m) => `${m.node} (${m.mac})`).join(', ');
        once('warn', `collector "${cfg.id}": switches not found or offline on the controller: ${names}`);
      }
      if (!ports.length) throw new Error('no port data for any configured switch (check MACs in "devices")');
      for (const p of ports) ctx.facts.setIface(p.key, p.sample, now);
    },
  };
}
