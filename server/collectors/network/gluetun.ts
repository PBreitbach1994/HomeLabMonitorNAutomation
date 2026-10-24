// Gluetun control-server collector: tunnel status + exit IP → facts.vpn.
// An unreachable control server is a collector failure, not "VPN down": only an explicit
// non-running status from Gluetun marks the tunnel down.

import type { CollectorConfig } from '../../config.ts';
import type { VpnFact } from '../../facts.ts';
import type { Collector, CollectorContext } from '../types.ts';
import { HttpError, basicAuth, errMsg, getJson, intervalMs, onceLogger, optStr, reqStr, stripSlash } from './util.ts';

export interface GluetunRaw {
  /** `/v1/vpn/status` or `/v1/openvpn/status`: `{ "status": "running" | "stopped" | … }` */
  status: unknown;
  /** `/v1/publicip/ip`: `{ public_ip, country, region, city, organization, … }` (older builds: only public_ip) */
  publicIp?: unknown;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseGluetun(raw: GluetunRaw, opts: { provider?: string } = {}): Omit<VpnFact, 'at' | 'host'> {
  const status = nonEmpty((raw.status as { status?: unknown } | null)?.status);
  if (!status) throw new Error('gluetun: status response has no "status" field');
  const ip = (raw.publicIp ?? {}) as Record<string, unknown>;
  return {
    up: status.toLowerCase() === 'running',
    provider: opts.provider ?? nonEmpty(ip.organization),
    publicIp: nonEmpty(ip.public_ip),
    country: nonEmpty(ip.country),
  };
}

export function createGluetun(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = stripSlash(reqStr(cfg, 'url', 'control server, e.g. http://switchyard:8000'));
  const host = optStr(cfg, 'host');
  const provider = optStr(cfg, 'provider');
  const apiKey = optStr(cfg, 'apiKey');
  const username = optStr(cfg, 'username');
  const password = optStr(cfg, 'password');
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  else if (username) headers.authorization = basicAuth(username, password ?? '');
  const once = onceLogger(ctx.log);
  let statusPath = '/v1/vpn/status';

  const getStatus = async (): Promise<unknown> => {
    try {
      return await getJson(`${url}${statusPath}`, { headers });
    } catch (err) {
      // Builds before the generic /v1/vpn routes only have the OpenVPN one.
      if (err instanceof HttpError && err.status === 404 && statusPath === '/v1/vpn/status') {
        statusPath = '/v1/openvpn/status';
        return getJson(`${url}${statusPath}`, { headers });
      }
      if (err instanceof HttpError && err.status === 401) {
        throw new Error(`${errMsg(err)} — the control server wants auth (set apiKey, or username/password)`);
      }
      throw err;
    }
  };

  return {
    id: cfg.id,
    kind: 'gluetun',
    intervalMs: intervalMs(cfg, 15),
    domains: ['vpn'],
    async poll(now) {
      const [status, publicIp] = await Promise.all([
        getStatus(),
        getJson(`${url}/v1/publicip/ip`, { headers }).catch((err: unknown) => {
          once('warn', `collector "${cfg.id}": public IP unavailable (${errMsg(err)})`);
          return undefined;
        }),
      ]);
      ctx.facts.vpn = { ...parseGluetun({ status, publicIp }, { provider }), host, at: now };
    },
  };
}
