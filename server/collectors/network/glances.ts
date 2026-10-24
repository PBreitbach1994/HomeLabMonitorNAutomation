// Glances REST collector: host CPU / memory / temperature / uptime → facts.hosts.
// Glances must run in web-server mode (`glances -w`, or the nicolargo/glances image with
// GLANCES_OPT=-w); the REST API lives under /api/<version>/<plugin>.

import type { CollectorConfig } from '../../config.ts';
import type { HostFact } from '../../facts.ts';
import type { Collector, CollectorContext } from '../types.ts';
import { HttpError, basicAuth, errMsg, getJson, intervalMs, onceLogger, optNum, optStr, reqStr, stripSlash } from './util.ts';

export interface GlancesRaw {
  cpu: unknown;
  mem: unknown;
  sensors?: unknown;
  uptime?: unknown;
}

/** "11 days, 1:02:03" / "1 day, 0:00:05" / "3:04:05" (Python timedelta str) → seconds. */
export function parseUptime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(?:(\d+) days?,\s*)?(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?\s*$/.exec(v);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** CPU package / die sensors, preferred over NVMe, GPU, ACPI and other "core"-typed sensors. */
const CPU_LABEL = /package|tctl|tdie|tccd|\bcpu|coretemp|k10temp|x86_pkg|soc|^core \d/i;

/**
 * Hottest CPU temperature in °C, or null when Glances reports none. Glances types every
 * psutil temperature as `temperature_core` (NVMe "Composite", "acpitz", GPU "edge" too), so
 * CPU-looking labels win when present; otherwise the hottest temperature_core sensor.
 */
export function pickTemperature(sensors: unknown): number | null {
  if (!Array.isArray(sensors)) return null;
  const temps = (sensors as Record<string, unknown>[])
    .filter((s) => s && s.type === 'temperature_core')
    .map((s) => {
      let c = typeof s.value === 'number' ? s.value : Number(s.value);
      if (s.unit === 'F') c = ((c - 32) * 5) / 9;
      return { label: typeof s.label === 'string' ? s.label : '', c };
    })
    .filter((s) => Number.isFinite(s.c) && s.c > 0 && s.c < 150);
  const cpu = temps.filter((t) => CPU_LABEL.test(t.label));
  const pool = cpu.length ? cpu : temps;
  return pool.length ? Math.max(...pool.map((t) => t.c)) : null;
}

function pct(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseGlances(raw: GlancesRaw): Omit<HostFact, 'at'> {
  return {
    cpuPct: pct((raw.cpu as { total?: unknown } | null)?.total),
    memPct: pct((raw.mem as { percent?: unknown } | null)?.percent),
    tempC: pickTemperature(raw.sensors),
    uptimeS: parseUptime(raw.uptime),
  };
}

export function createGlances(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const host = reqStr(cfg, 'host', 'topology node id the metrics belong to');
  const url = stripSlash(reqStr(cfg, 'url', 'e.g. http://switchyard:61208'));
  const apiVersion = optNum(cfg, 'apiVersion') ?? 4;
  const username = optStr(cfg, 'username');
  const password = optStr(cfg, 'password');
  const headers: Record<string, string> = username ? { authorization: basicAuth(username, password ?? '') } : {};
  const base = `${url}/api/${apiVersion}`;
  const once = onceLogger(ctx.log);

  /** sensors/uptime are optional (plugin disabled, no sensors in a VM); cpu/mem are not. */
  const optional = async (plugin: string): Promise<unknown> => {
    try {
      return await getJson(`${base}/${plugin}`, { headers });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) throw err;
      once('info', `collector "${cfg.id}": ${plugin} unavailable (${errMsg(err)}) — reporting null`);
      return undefined;
    }
  };

  return {
    id: cfg.id,
    kind: 'glances',
    intervalMs: intervalMs(cfg, 10),
    domains: ['hosts'],
    async poll(now) {
      const [cpu, mem, sensors, uptime] = await Promise.all([
        getJson(`${base}/cpu`, { headers }).catch((err: unknown) => {
          if (err instanceof HttpError && err.status === 404) {
            throw new Error(`${errMsg(err)} — Glances 3.x serves /api/3 (set apiVersion: 3)`);
          }
          throw err;
        }),
        getJson(`${base}/mem`, { headers }),
        optional('sensors'),
        optional('uptime'),
      ]);
      ctx.facts.hosts.set(host, { ...parseGlances({ cpu, mem, sensors, uptime }), at: now });
    },
  };
}
