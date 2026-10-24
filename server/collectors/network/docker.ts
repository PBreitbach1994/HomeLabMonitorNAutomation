// Docker Engine collector: container state + health via `GET /containers/json?all=1`, over the
// unix socket or a TCP endpoint such as docker-socket-proxy (CONTAINERS=1 is all it needs).

import type { CollectorConfig } from '../../config.ts';
import type { ContainerFact, ContainerState } from '../../facts.ts';
import type { Collector, CollectorContext } from '../types.ts';
import { getJson, intervalMs, optStr, stripSlash } from './util.ts';

const STATES: ContainerState[] = ['running', 'exited', 'paused', 'restarting', 'created', 'dead'];

export function healthFromStatus(status: string): ContainerFact['health'] {
  const m = /\((healthy|unhealthy|health: starting)\)/i.exec(status);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h === 'health: starting' ? 'starting' : (h as 'healthy' | 'unhealthy');
}

function containerName(names: unknown): string | null {
  if (!Array.isArray(names) || !names.length) return null;
  const stripped = names.filter((n): n is string => typeof n === 'string').map((n) => n.replace(/^\//, ''));
  // Legacy --link aliases show up as "/other/alias"; the real name has no inner slash.
  return stripped.find((n) => !n.includes('/')) ?? stripped[0] ?? null;
}

/** Maps the Engine API container list to facts (without `at`). */
export function parseDockerContainers(json: unknown, host?: string): Omit<ContainerFact, 'at'>[] {
  if (!Array.isArray(json)) throw new Error('docker: /containers/json did not return a list');
  const out: Omit<ContainerFact, 'at'>[] = [];
  for (const c of json as Record<string, unknown>[]) {
    const name = containerName(c.Names);
    if (!name) continue;
    const raw = typeof c.State === 'string' ? c.State.toLowerCase() : '';
    const state = (STATES as string[]).includes(raw) ? (raw as ContainerState) : 'unknown';
    // Engine API ≥ 1.52 adds Health{Status} to the summary; older versions only have it in Status.
    const hs = (c.Health as { Status?: unknown } | undefined)?.Status;
    const health = hs === 'healthy' || hs === 'unhealthy'
      ? hs
      : hs === 'starting'
        ? 'starting'
        : healthFromStatus(typeof c.Status === 'string' ? c.Status : '');
    out.push({ name, host, state, health });
  }
  return out;
}

export function createDocker(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = optStr(cfg, 'url');
  const socket = optStr(cfg, 'socket');
  if (!url && !socket) throw new Error('docker: set "url" (e.g. http://switchyard:2375) or "socket" (e.g. /var/run/docker.sock)');
  if (url && socket) throw new Error('docker: set either "url" or "socket", not both');
  const host = optStr(cfg, 'host');
  const endpoint = url ? `${stripSlash(url)}/containers/json?all=1` : 'http://localhost/containers/json?all=1';

  return {
    id: cfg.id,
    kind: 'docker',
    intervalMs: intervalMs(cfg, 15),
    domains: ['containers'],
    async poll(now) {
      const json = await getJson(endpoint, { socketPath: socket });
      for (const c of parseDockerContainers(json, host)) ctx.facts.containers.set(c.name, { ...c, at: now });
    },
  };
}
