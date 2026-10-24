// ICMP ping collector: shells out to the system `ping` (needs NET_RAW or an unprivileged ICMP
// socket range, which most distros allow) and writes RTT / jitter / loss per named target.

import type { CollectorConfig } from '../../config.ts';
import type { Collector, CollectorContext } from '../types.ts';
import { TIMEOUT_MS, intervalMs, optMap, optNum, optStr, run } from './util.ts';

export interface PingResult {
  transmitted: number;
  received: number;
  lossPct: number;
  rttMs: number | null;
  jitterMs: number | null;
}

function stddev(xs: number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}

/**
 * Parses the summary of Linux iputils or BusyBox ping (also BSD/macOS). Returns null when
 * there's no statistics block (unknown host, socket errors…). Jitter is iputils' `mdev`;
 * BusyBox prints no mdev, so it's computed the same way (population std-dev) from the replies.
 */
export function parsePing(stdout: string): PingResult | null {
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(stdout);
  if (!counts) return null;
  const transmitted = Number(counts[1]);
  const received = Number(counts[2]);
  const lossMatch = /([\d.]+)% packet loss/.exec(stdout);
  const lossPct = lossMatch ? Number(lossMatch[1]) : transmitted ? ((transmitted - received) / transmitted) * 100 : 100;

  const rtt = /(?:rtt|round-trip) min\/avg\/max(?:\/(?:mdev|stddev))? = ([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))? ?ms/.exec(stdout);
  const times = [...stdout.matchAll(/\btime[=<]([\d.]+) ?ms/g)].map((m) => Number(m[1]));
  let rttMs: number | null = rtt ? Number(rtt[2]) : null;
  let jitterMs: number | null = rtt?.[4] != null ? Number(rtt[4]) : null;
  if (rttMs == null && received > 0 && times.length) rttMs = times.reduce((s, x) => s + x, 0) / times.length;
  if (jitterMs == null && received > 0 && times.length) jitterMs = stddev(times);
  return { transmitted, received, lossPct, rttMs: received > 0 ? rttMs : null, jitterMs: received > 0 ? jitterMs : null };
}

/** Errors that mean "this collector can't ping at all" rather than "the target is unreachable". */
const SETUP_ERROR = /operation not permitted|permission denied|socket: |invalid (?:option|number|argument|interval)|unrecognized option|usage:/i;

export function createPing(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const targets = optMap(cfg, 'targets') ?? {};
  if (!Object.keys(targets).length) throw new Error('ping: "targets" (name → host) needs at least one entry');
  const bin = optStr(cfg, 'bin') ?? 'ping';
  const count = Math.max(1, Math.round(optNum(cfg, 'count') ?? 3));
  const args = (host: string) => ['-c', String(count), '-i', '0.2', '-W', '1', host];

  return {
    id: cfg.id,
    kind: 'ping',
    intervalMs: intervalMs(cfg, 5),
    domains: ['ping'],
    async poll(now) {
      const errors: string[] = [];
      await Promise.all(
        Object.entries(targets).map(async ([name, host]) => {
          const r = await run(bin, args(host), TIMEOUT_MS);
          const parsed = parsePing(r.stdout);
          if (!parsed) {
            const why = (r.stderr || r.stdout).trim().split('\n').pop() || (r.timedOut ? 'timed out' : `exit ${r.code}`);
            if (SETUP_ERROR.test(why)) throw new Error(`ping ${host}: ${why}`);
            // Unknown host / network unreachable: record it as total loss, and surface why.
            errors.push(`${name} (${host}): ${why}`);
            ctx.facts.ping.set(name, { target: host, rttMs: null, jitterMs: null, lossPct: 100, at: now });
            return;
          }
          ctx.facts.ping.set(name, { target: host, rttMs: parsed.rttMs, jitterMs: parsed.jitterMs, lossPct: parsed.lossPct, at: now });
        }),
      );
      if (errors.length) throw new Error(errors.join('; '));
    },
  };
}
