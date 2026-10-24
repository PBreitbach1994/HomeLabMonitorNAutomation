import type { LabConfig, NodeConfig } from '../config.ts';
import { parseSpeed } from '../config.ts';
import type { FactStore } from '../facts.ts';
import type { Medium, Protocol, TopoLink } from '../../shared/model.ts';
import { PROTOCOLS } from '../../shared/model.ts';

/** Counter samples older than this are treated as missing. */
export const STALE_MS = 60_000;

export interface LinkDef {
  id: string;
  from: string;
  to: string;
  medium: Medium;
  speedBps: number;
  bonded: boolean;
  approx: boolean;
  port?: string;
  measure?: { key: string; side: 'upstream' | 'downstream' };
}

export interface Topology {
  nodes: Map<string, NodeConfig>;
  links: Map<string, LinkDef>;
  linkByChild: Map<string, LinkDef>;
  children: Map<string, string[]>;
  internetId: string;
  leaves: Set<string>;
}

export const linkIdFor = (child: string) => `${child}-up`;
/** Key the simulator writes for each link, so demo data never collides with real port keys. */
export const simKeyFor = (linkId: string) => `link:${linkId}`;

export function buildTopology(lab: LabConfig): Topology {
  const nodes = new Map(lab.topology.nodes.map((n) => [n.id, n]));
  const links = new Map<string, LinkDef>();
  const linkByChild = new Map<string, LinkDef>();
  const children = new Map<string, string[]>();
  for (const n of lab.topology.nodes) {
    if (!n.parent || !n.link) continue;
    children.set(n.parent, [...(children.get(n.parent) ?? []), n.id]);
    const l = n.link;
    let measure: LinkDef['measure'];
    if (l.measure) {
      const device = l.measure.split('/')[0];
      const side = l.side ?? (device === n.id ? 'downstream' : 'upstream');
      measure = { key: l.measure, side };
    }
    const def: LinkDef = {
      id: linkIdFor(n.id),
      from: n.parent,
      to: n.id,
      medium: l.medium,
      speedBps: parseSpeed(l.speed, l.medium),
      bonded: !!l.bonded,
      approx: !!l.approx,
      port: l.port,
      measure,
    };
    links.set(def.id, def);
    linkByChild.set(n.id, def);
  }
  const internetId = lab.topology.nodes.find((n) => n.kind === 'internet')!.id;
  const leaves = new Set(lab.topology.nodes.filter((n) => n.id !== internetId && !children.has(n.id)).map((n) => n.id));
  return { nodes, links, linkByChild, children, internetId, leaves };
}

/** Chain of node ids from `id` up to the root, inclusive. */
export function ancestry(topo: Topology, id: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = topo.nodes.get(cur)?.parent;
  }
  return out;
}

export interface PathHop {
  linkId: string;
  dir: 'down' | 'up'; // down = toward the link's `to` node
}

/** Links traversed by traffic flowing from node `a` to node `b`. */
export function pathBetween(topo: Topology, a: string, b: string): PathHop[] {
  if (a === b) return [];
  const upA = ancestry(topo, a);
  const upB = ancestry(topo, b);
  const setB = new Set(upB);
  const lca = upA.find((n) => setB.has(n));
  if (!lca) return [];
  const hops: PathHop[] = [];
  for (const n of upA) {
    if (n === lca) break;
    hops.push({ linkId: linkIdFor(n), dir: 'up' });
  }
  const down: PathHop[] = [];
  for (const n of upB) {
    if (n === lca) break;
    down.push({ linkId: linkIdFor(n), dir: 'down' });
  }
  return [...hops, ...down.reverse()];
}

interface Rates {
  downBps: number | null;
  upBps: number | null;
  measured: boolean;
}

/** Reads a link's rates: its real port if fresh, else the simulator's key, else nothing. */
export function measureLink(def: LinkDef, facts: FactStore, now: number): Rates {
  if (def.measure) {
    const f = facts.ifaces.get(def.measure.key);
    if (f && now - f.at < STALE_MS && f.inBps != null && f.outBps != null) {
      return def.measure.side === 'downstream'
        ? { downBps: f.inBps, upBps: f.outBps, measured: true }
        : { downBps: f.outBps, upBps: f.inBps, measured: true };
    }
  }
  const sim = facts.ifaces.get(simKeyFor(def.id));
  if (sim && now - sim.at < STALE_MS && sim.inBps != null && sim.outBps != null) {
    // The simulator always writes as if measured on the downstream device.
    return { downBps: sim.inBps, upBps: sim.outBps, measured: true };
  }
  return { downBps: null, upBps: null, measured: false };
}

export interface AppFlow {
  protocol: Protocol;
  from: string;
  to: string;
  bps: number;
  /** Node the flow is attributed to in "busiest right now" (the local endpoint). */
  owner: string;
}

/** Derives per-protocol app flows from download clients and Plex sessions. */
export function appFlows(topo: Topology, facts: FactStore, lab: LabConfig, now: number): AppFlow[] {
  const flows: AppFlow[] = [];
  const hostForApp = (app: string) => lab.services.find((s) => s.app === app || s.id === app)?.host;
  for (const [id, d] of facts.downloads) {
    if (now - d.at > STALE_MS) continue;
    const host = d.host ?? hostForApp(d.client) ?? hostForApp(id);
    if (!host || !topo.nodes.has(host)) continue;
    if (d.downBps > 0) flows.push({ protocol: d.protocol, from: topo.internetId, to: host, bps: d.downBps, owner: host });
    if (d.upBps > 0) flows.push({ protocol: d.protocol, from: host, to: topo.internetId, bps: d.upBps, owner: host });
  }
  const plex = facts.plex;
  if (plex && now - plex.at < STALE_MS) {
    const host = plex.host ?? hostForApp('plex');
    if (host && topo.nodes.has(host)) {
      for (const s of plex.sessions) {
        const target = s.nodeId && topo.nodes.has(s.nodeId) ? s.nodeId : s.local ? topo.nodes.get(host)?.parent : topo.internetId;
        if (target) flows.push({ protocol: 'plex', from: host, to: target, bps: s.bandwidthBps, owner: host });
      }
    }
  }
  return flows;
}

/**
 * Splits each link's measured traffic into protocols: app flows are laid on their topology
 * path and capped at what the link actually carried; the remainder is "other".
 */
export function attribute(
  topo: Topology,
  rates: Map<string, Rates>,
  flows: AppFlow[],
): Map<string, Partial<Record<Protocol, number>>> {
  const raw = new Map<string, Record<Protocol, number>>();
  for (const f of flows) {
    for (const hop of pathBetween(topo, f.from, f.to)) {
      const m = raw.get(hop.linkId) ?? { usenet: 0, torrent: 0, soulseek: 0, plex: 0, other: 0 };
      m[f.protocol] += f.bps;
      raw.set(hop.linkId, m);
    }
  }
  const out = new Map<string, Partial<Record<Protocol, number>>>();
  for (const id of topo.links.keys()) {
    const r = rates.get(id);
    const total = r?.measured ? (r.downBps ?? 0) + (r.upBps ?? 0) : null;
    const m = raw.get(id);
    if (total == null) {
      if (m) out.set(id, m);
      continue;
    }
    const attributed = m ? PROTOCOLS.reduce((s, p) => s + (p === 'other' ? 0 : m[p]), 0) : 0;
    const scale = attributed > total && attributed > 0 ? total / attributed : 1;
    const mix: Partial<Record<Protocol, number>> = {};
    for (const p of PROTOCOLS) {
      if (p === 'other' || !m || !m[p]) continue;
      mix[p] = m[p] * scale;
    }
    mix.other = Math.max(0, total - attributed * scale);
    out.set(id, mix);
  }
  return out;
}

export function toTopoLink(
  def: LinkDef,
  r: Rates,
  mix: Partial<Record<Protocol, number>>,
  history: number[],
): TopoLink {
  const util = r.measured ? Math.max(r.downBps ?? 0, r.upBps ?? 0) / def.speedBps : null;
  return {
    id: def.id,
    from: def.from,
    to: def.to,
    medium: def.medium,
    bonded: def.bonded || undefined,
    speedBps: def.speedBps,
    measured: r.measured,
    approx: def.approx || undefined,
    downBps: r.downBps,
    upBps: r.upBps,
    util: util == null ? null : Math.min(1, util),
    mix,
    history,
    port: def.port,
  };
}
