// Tailscale collector: backend state + online peers → facts.tailscale.
// Either runs `tailscale status --json`, or — when `socket` is set — asks tailscaled's LocalAPI
// over its unix socket directly (no CLI needed inside the dashboard container; mount the socket).

import type { CollectorConfig } from '../../config.ts';
import type { TailscaleFact } from '../../facts.ts';
import type { Collector, CollectorContext } from '../types.ts';
import { TIMEOUT_MS, getJson, intervalMs, optStr, run } from './util.ts';

export function parseTailscaleStatus(json: unknown): Omit<TailscaleFact, 'at'> {
  const s = json as { BackendState?: unknown; Peer?: unknown } | null;
  if (!s || typeof s !== 'object' || typeof s.BackendState !== 'string') {
    throw new Error('tailscale: status has no BackendState');
  }
  const peers = s.Peer && typeof s.Peer === 'object' ? Object.values(s.Peer as Record<string, { Online?: unknown }>) : [];
  return {
    up: s.BackendState === 'Running',
    peersOnline: peers.filter((p) => p?.Online === true).length,
  };
}

async function statusViaCli(bin: string): Promise<unknown> {
  const r = await run(bin, ['status', '--json'], TIMEOUT_MS);
  const out = r.stdout.trim();
  // `status --json` still prints JSON (BackendState "Stopped"/"NeedsLogin") when logged out;
  // it fails without JSON only when tailscaled itself is unreachable.
  if (out.startsWith('{')) {
    try {
      return JSON.parse(out);
    } catch {
      /* fall through */
    }
  }
  const why = (r.stderr || r.stdout).trim().split('\n').pop() || (r.timedOut ? 'timed out' : `exit ${r.code}`);
  throw new Error(`${bin} status --json: ${why}`);
}

export function createTailscale(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const socket = optStr(cfg, 'socket');
  const bin = optStr(cfg, 'bin') ?? 'tailscale';

  return {
    id: cfg.id,
    kind: 'tailscale',
    intervalMs: intervalMs(cfg, 30),
    domains: ['tailscale'],
    async poll(now) {
      const json = socket
        ? await getJson('http://local-tailscaled.sock/localapi/v0/status', { socketPath: socket })
        : await statusViaCli(bin);
      ctx.facts.tailscale = { ...parseTailscaleStatus(json), at: now };
    },
  };
}
