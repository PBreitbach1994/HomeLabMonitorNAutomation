import type { LabConfig } from './config.ts';
import type { FactStore } from './facts.ts';
import { History } from './history.ts';
import { correlate } from './derive/pipeline.ts';
import { IncidentEngine } from './derive/incidents.ts';
import {
  STALE_MS, appFlows, attribute, buildTopology, measureLink, toTopoLink, type Topology,
} from './derive/topology.ts';
import type {
  BusyFlow, Health, HostState, InternetState, Protocol, ServiceState, Snapshot, TopoLink, TopoNode,
  TrafficState, VolumeState, VpnState,
} from '../shared/model.ts';
import { PROTOCOLS } from '../shared/model.ts';

const HEALTH_RANK: Record<Health, number> = { crit: 4, warn: 3, unknown: 2, off: 1, ok: 0 };
const worst = (...hs: Health[]): Health => hs.reduce((a, b) => (HEALTH_RANK[b] > HEALTH_RANK[a] ? b : a), 'ok');
const fresh = (at: number | undefined, now: number, ms = STALE_MS) => at != null && now - at < ms;
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

export class SnapshotBuilder {
  readonly history = new History(10_000, 360);
  readonly topo: Topology;
  private rev = 0;
  private incidents = new IncidentEngine();
  private today: { day: string; down: number; up: number; at: number } | null = null;

  constructor(
    private lab: LabConfig,
    private facts: FactStore,
  ) {
    this.topo = buildTopology(lab);
  }

  build(now = Date.now()): Snapshot {
    const { lab, facts, topo, history } = this;
    const label = (id: string) => topo.nodes.get(id)?.label ?? id;

    // --- links -------------------------------------------------------------
    const rates = new Map([...topo.links.values()].map((d) => [d.id, measureLink(d, facts, now)]));
    const flows = appFlows(topo, facts, lab, now);
    const mixes = attribute(topo, rates, flows);
    const wanDef = [...topo.links.values()].find((l) => l.from === topo.internetId);
    const wan = wanDef ? rates.get(wanDef.id)! : null;
    const edgeDefs = [...topo.links.values()].filter((l) => topo.leaves.has(l.to));

    // --- traffic totals ----------------------------------------------------
    const lanDown = edgeDefs.some((l) => rates.get(l.id)!.measured) ? sum(edgeDefs.map((l) => rates.get(l.id)!.downBps)) : null;
    const lanUp = lanDown == null ? null : sum(edgeDefs.map((l) => rates.get(l.id)!.upBps));
    const lanTotal = lanDown == null ? null : lanDown + (wan?.upBps ?? 0);
    const protocolNow = Object.fromEntries(PROTOCOLS.map((p) => [p, 0])) as Record<Protocol, number>;
    for (const f of flows) protocolNow[f.protocol] += f.bps;
    const attributed = sum(PROTOCOLS.filter((p) => p !== 'other').map((p) => protocolNow[p]));
    protocolNow.other = Math.max(0, (lanTotal ?? attributed) - attributed);

    this.integrateToday(now, wan?.downBps ?? null, wan?.upBps ?? null);

    // --- record history before reading it back ------------------------------
    const hostIds = lab.topology.nodes.filter((n) => n.kind === 'host' || n.kind === 'nas').map((n) => n.id);
    const internetPing = facts.ping.get('internet');
    const routerPing = facts.ping.get('router');
    const pingFresh = internetPing && fresh(internetPing.at, now) ? internetPing : null;
    if (history.due(now)) {
      for (const def of topo.links.values()) {
        const r = rates.get(def.id)!;
        history.record(`link:${def.id}`, r.measured ? (r.downBps ?? 0) + (r.upBps ?? 0) : null);
        history.record(`link:${def.id}:down`, r.measured ? r.downBps : null);
        history.record(`link:${def.id}:up`, r.measured ? r.upBps : null);
        history.record(`util:${def.id}`, r.measured ? Math.max(r.downBps ?? 0, r.upBps ?? 0) / def.speedBps : null);
      }
      history.record('internet:down', wan?.downBps ?? null);
      history.record('internet:up', wan?.upBps ?? null);
      history.record('internet:rtt', pingFresh?.rttMs ?? null);
      history.record('lan:total', lanTotal);
      for (const p of PROTOCOLS) history.record(`proto:${p}`, lanTotal == null && !flows.length ? null : protocolNow[p]);
      for (const id of hostIds) {
        const h = facts.hosts.get(id);
        history.record(`host:${id}:cpu`, h && fresh(h.at, now) ? h.cpuPct : null);
      }
      history.lastSampleAt = now;
    }

    const links: TopoLink[] = [...topo.links.values()].map((d) =>
      toTopoLink(d, rates.get(d.id)!, mixes.get(d.id) ?? {}, history.dense(`link:${d.id}`, 30)),
    );

    // --- nodes -------------------------------------------------------------
    const linkTouching = (id: string) => links.filter((l) => l.from === id || l.to === id);
    const nodes: TopoNode[] = lab.topology.nodes.map((n) => {
      let health: Health = 'unknown';
      let wifiClients: number | null | undefined;
      switch (n.kind) {
        case 'internet':
          health = pingFresh ? (pingFresh.lossPct >= 100 ? 'crit' : 'ok') : wan?.measured ? 'ok' : 'unknown';
          break;
        case 'router':
          health = routerPing && fresh(routerPing.at, now) ? (routerPing.lossPct >= 100 ? 'crit' : 'ok') : linkTouching(n.id).some((l) => l.measured) ? 'ok' : 'unknown';
          wifiClients = facts.wifi && fresh(facts.wifi.at, now, 5 * 60_000) ? facts.wifi.routerClients : null;
          break;
        case 'switch':
          health = linkTouching(n.id).some((l) => l.measured) ? 'ok' : 'unknown';
          break;
        case 'mesh': {
          const m = facts.mesh.get(n.id);
          health = m && fresh(m.at, now, 5 * 60_000) ? (m.online ? 'ok' : 'crit') : 'unknown';
          wifiClients = m ? m.clients : null;
          break;
        }
        case 'host':
        case 'nas': {
          const h = facts.hosts.get(n.id);
          health = !h ? 'unknown' : fresh(h.at, now) ? 'ok' : 'crit';
          break;
        }
        default: {
          const up = links.find((l) => l.to === n.id);
          health = up?.measured ? 'ok' : 'unknown';
        }
      }
      return {
        id: n.id,
        label: n.label,
        sublabel: n.sublabel,
        kind: n.kind,
        parent: n.parent,
        linkId: n.parent ? `${n.id}-up` : undefined,
        health,
        ip: n.ip,
        model: n.model,
        location: n.location,
        wifiClients,
        tag: n.tag,
      };
    });

    // --- hosts -------------------------------------------------------------
    const hosts: HostState[] = hostIds.map((id) => {
      const n = nodes.find((x) => x.id === id)!;
      const h = facts.hosts.get(id);
      const ok = h && fresh(h.at, now);
      return {
        id,
        label: n.label,
        role: topo.nodes.get(id)?.role,
        health: n.health,
        cpuPct: ok ? h.cpuPct : null,
        memPct: ok ? h.memPct : null,
        tempC: ok ? h.tempC : null,
        uptimeS: ok && h.uptimeS != null ? h.uptimeS + (now - h.at) / 1000 : null,
        cpuHistory: history.dense(`host:${id}:cpu`, 60),
      };
    });

    // --- services ----------------------------------------------------------
    const services: ServiceState[] = lab.services.map((s) => {
      const c = facts.containers.get(s.container ?? s.id);
      const http = facts.http.get(s.id);
      const base = { id: s.id, label: s.label, host: s.host, vpn: !!s.vpn, url: s.url };
      const httpDown = http && fresh(http.at, now) && !http.up;
      if (!c || !fresh(c.at, now, STALE_MS * 2)) {
        if (http && fresh(http.at, now)) return { ...base, state: http.up ? 'running' : 'stopped', health: http.up ? 'ok' : 'crit' };
        return { ...base, state: 'unknown', health: 'unknown' };
      }
      switch (c.state) {
        case 'running':
          if (httpDown || c.health === 'unhealthy') return { ...base, state: 'degraded', health: 'warn' };
          return { ...base, state: 'running', health: 'ok', note: s.expect === 'manual' ? 'MANUAL START' : undefined };
        case 'paused':
          return { ...base, state: 'paused', health: s.expect === 'paused' ? 'ok' : 'warn', note: 'PAUSED' };
        case 'restarting':
          return { ...base, state: 'degraded', health: 'warn', note: 'RESTARTING' };
        default:
          if (s.expect === 'manual' || s.expect === 'paused') return { ...base, state: 'manual', health: 'off', note: 'MANUAL START' };
          return { ...base, state: 'stopped', health: 'crit', note: c.state === 'exited' ? 'EXITED' : c.state.toUpperCase() };
      }
    });

    // --- storage -----------------------------------------------------------
    const storage: VolumeState[] = [...facts.volumes.values()].map((v) => {
      const enc = v.enclosure ? facts.enclosures.get(v.enclosure) : undefined;
      const encBad = enc && (enc.health === 'warn' || enc.health === 'crit');
      return {
        id: v.id,
        label: v.label,
        host: v.host,
        enclosure: v.enclosure,
        usedBytes: v.usedBytes,
        totalBytes: v.totalBytes,
        health: worst(v.health, ...v.disks.map((d) => d.health), enc?.health ?? 'ok'),
        note: encBad ? `${enc.label} reports "${enc.note ?? 'Abnormal'}"` : undefined,
        disks: v.disks.map((d) => ({ id: d.id, slot: d.slot, model: d.model, health: d.health, tempC: d.tempC, ssd: d.ssd })),
      };
    });

    // --- internet / vpn / wifi ---------------------------------------------
    const internet: InternetState = {
      provider: lab.lab.provider ?? topo.nodes.get(topo.internetId)?.sublabel ?? '',
      health: nodes.find((n) => n.kind === 'internet')!.health,
      downBps: wan?.downBps ?? null,
      upBps: wan?.upBps ?? null,
      avgDownBps: history.mean('internet:down', 3600_000),
      avgUpBps: history.mean('internet:up', 3600_000),
      rttMs: pingFresh?.rttMs ?? null,
      routerRttMs: routerPing && fresh(routerPing.at, now) ? routerPing.rttMs : null,
      jitterMs: pingFresh?.jitterMs ?? null,
      lossPct: pingFresh?.lossPct ?? null,
      rttHistory: history.dense('internet:rtt', 180),
      downHistory: history.dense('internet:down', 60),
      upHistory: history.dense('internet:up', 60),
      todayDownBytes: this.today?.down ?? null,
      todayUpBytes: this.today?.up ?? null,
    };

    const vpnServices = lab.services.filter((s) => s.vpn).map((s) => s.id);
    const v = facts.vpn && fresh(facts.vpn.at, now) ? facts.vpn : null;
    const vpnApps = new Set(lab.services.filter((s) => s.vpn).flatMap((s) => [s.id, s.app]));
    const vpnBps = sum([...facts.downloads.entries()].filter(([id, d]) => vpnApps.has(d.client) || vpnApps.has(id)).map(([, d]) => d.downBps + d.upBps));
    const vpn: VpnState = {
      health: v ? (v.up ? 'ok' : 'crit') : 'unknown',
      up: v ? v.up : null,
      provider: v?.provider ?? null,
      publicIp: v?.publicIp ?? null,
      country: v?.country ?? null,
      host: v?.host ?? lab.services.find((s) => s.vpn)?.host ?? null,
      throughputBps: v ? vpnBps : null,
      services: vpnServices,
    };

    const meshNodes = lab.topology.nodes.filter((n) => n.kind === 'mesh');
    const wifiFresh = facts.wifi && fresh(facts.wifi.at, now, 5 * 60_000) ? facts.wifi : null;
    const routerCount = lab.topology.nodes.some((n) => n.kind === 'router') ? 1 : 0;
    const meshOnline = meshNodes.filter((n) => facts.mesh.get(n.id)?.online).length;
    const wifi = {
      nodesOnline: wifiFresh ? meshOnline + routerCount : null,
      nodesTotal: meshNodes.length + routerCount,
      devices: wifiFresh?.devices ?? null,
      wired: wifiFresh?.wired ?? null,
      updateAvailable: !!wifiFresh?.updateAvailable,
    };

    // --- traffic -----------------------------------------------------------
    const busiest: BusyFlow[] = [];
    for (const l of links) {
      const isWan = l.from === topo.internetId;
      if (!isWan && !topo.leaves.has(l.to)) continue;
      for (const p of PROTOCOLS) {
        const bps = l.mix[p] ?? 0;
        if (bps <= 0 || (isWan && p !== 'other')) continue;
        busiest.push({ node: isWan ? topo.internetId : l.to, protocol: p, bps });
      }
    }
    busiest.sort((a, b) => b.bps - a.bps);
    const wiredActive = edgeDefs.filter((d) => {
      const r = rates.get(d.id)!;
      return d.medium !== 'wifi' && r.measured && (r.downBps ?? 0) + (r.upBps ?? 0) > 50e3;
    }).length;
    const wifiGroups =
      meshNodes.filter((n) => (facts.mesh.get(n.id)?.clients ?? 0) > 0).length + ((wifiFresh?.routerClients ?? 0) > 0 ? 1 : 0);
    const top = PROTOCOLS.filter((p) => p !== 'other').reduce<Protocol | null>(
      (best, p) => (protocolNow[p] > 0 && (!best || protocolNow[p] > protocolNow[best]) ? p : best),
      null,
    );
    const traffic: TrafficState = {
      lanBps: lanTotal,
      lanDownBps: lanDown,
      lanUpBps: lanUp,
      lanHistory: history.dense('lan:total', 60),
      activeDevices: lanDown == null ? null : wiredActive + wifiGroups,
      wifiGroups,
      topProtocol: top,
      topProtocolShare: top && lanTotal ? protocolNow[top] / lanTotal : null,
      byProtocol: Object.fromEntries(PROTOCOLS.map((p) => [p, history.downsample(`proto:${p}`, 3, 120)])) as Record<Protocol, number[]>,
      protocolNow,
      busiest: busiest.slice(0, 12),
    };

    // --- pipeline + incidents ---------------------------------------------
    const { items: pipeline, tracked } = correlate(facts, now);
    const incidents = this.incidents.evaluate({
      now,
      facts,
      services,
      hosts,
      storage,
      links,
      internet,
      vpn,
      pipeline,
      nodeLabel: label,
      utilHistory: (id) => history.get(`util:${id}`),
    });

    return {
      rev: ++this.rev,
      ts: now,
      mode: lab.mode,
      lab: { name: lab.lab.name },
      attention: incidents.filter((i) => i.state === 'open' && i.severity !== 'info').length,
      nodes,
      links,
      internet,
      hosts,
      services,
      storage,
      pipeline,
      pipelineTracked: tracked,
      incidents,
      cameras: facts.cameras.filter((c) => now - c.ts < 24 * 3600_000).slice(0, 8),
      vpn,
      tailscale: facts.tailscale && fresh(facts.tailscale.at, now, 5 * 60_000)
        ? { up: facts.tailscale.up, peersOnline: facts.tailscale.peersOnline }
        : { up: null, peersOnline: null },
      wifi,
      plex: { sessions: facts.plex && fresh(facts.plex.at, now) ? facts.plex.sessions : [] },
      traffic,
      sources: [...facts.sources.values()].map((s) => ({ id: s.id, kind: s.kind, ok: s.ok, lastOk: s.lastOk, error: s.lastError })),
    };
  }

  /** Integrates WAN bytes for "today", resetting at local midnight. */
  private integrateToday(now: number, downBps: number | null, upBps: number | null) {
    const day = new Date(now).toLocaleDateString('en-CA', { timeZone: this.lab.lab.timezone });
    const seed = this.facts.wanToday;
    if (!this.today || this.today.day !== day) {
      const seeded = seed && new Date(seed.at).toLocaleDateString('en-CA', { timeZone: this.lab.lab.timezone }) === day;
      this.today = { day, down: seeded ? seed.downBytes : 0, up: seeded ? seed.upBytes : 0, at: now };
      if (downBps == null && !seeded) this.today = null;
      return;
    }
    const dt = Math.min(60, (now - this.today.at) / 1000);
    this.today.down += ((downBps ?? 0) / 8) * dt;
    this.today.up += ((upBps ?? 0) / 8) * dt;
    this.today.at = now;
  }
}
