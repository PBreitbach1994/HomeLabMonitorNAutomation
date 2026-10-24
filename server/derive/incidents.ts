// Rules look at derived state and return findings; the engine owns the lifecycle
// (debounced open → recovered, kept for a day).

import type { FactStore } from '../facts.ts';
import type {
  HostState, Incident, InternetState, PipelineItem, ServiceState, Severity, TopoLink, VolumeState, VpnState,
} from '../../shared/model.ts';

export interface Finding {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  source: string;
  /** When the condition actually started, if the source knows (e.g. a failed download's time). */
  since?: number;
  /** Set for conditions that already ended before we saw them, so restarts keep recent context. */
  resolvedAt?: number;
}

export interface RuleContext {
  now: number;
  facts: FactStore;
  services: ServiceState[];
  hosts: HostState[];
  storage: VolumeState[];
  links: TopoLink[];
  internet: InternetState;
  vpn: VpnState;
  pipeline: PipelineItem[];
  nodeLabel: (id: string) => string;
  utilHistory: (linkId: string) => (number | null)[];
}

export interface Rule {
  id: string;
  /** Condition must persist this long before an incident opens. */
  forMs?: number;
  evaluate(ctx: RuleContext): Finding[];
}

const BLOCKED_STATES = new Set(['importBlocked', 'importPending', 'failedPending']);

export const RULES: Rule[] = [
  {
    id: 'service-down',
    forMs: 20_000,
    evaluate: ({ services, nodeLabel }) =>
      services
        .filter((s) => s.state === 'stopped' || s.state === 'degraded')
        .map((s) => ({
          key: `service:${s.id}`,
          severity: s.state === 'stopped' ? 'critical' : 'warning',
          title: s.state === 'stopped' ? `${s.label} is down` : `${s.label} is not responding`,
          detail: s.state === 'stopped'
            ? `Container stopped on ${nodeLabel(s.host)}${s.note ? ` — ${s.note}` : ''}`
            : `Container is running on ${nodeLabel(s.host)} but its health check fails`,
          source: s.id,
        })),
  },
  {
    id: 'host-down',
    forMs: 30_000,
    evaluate: ({ hosts }) =>
      hosts
        .filter((h) => h.health === 'crit')
        .map((h) => ({
          key: `host:${h.id}`,
          severity: 'critical',
          title: `${h.label} unreachable`,
          detail: 'No metrics or ping response',
          source: h.id,
        })),
  },
  {
    id: 'vpn-down',
    forMs: 10_000,
    evaluate: ({ vpn, nodeLabel }) =>
      vpn.up === false
        ? [{
            key: 'vpn',
            severity: 'critical',
            title: 'VPN tunnel down',
            detail: `Gluetun${vpn.host ? ` on ${nodeLabel(vpn.host)}` : ''} reports the tunnel down — ${vpn.services.length} apps have no egress`,
            source: 'gluetun',
          }]
        : [],
  },
  {
    id: 'internet',
    forMs: 15_000,
    evaluate: ({ internet }) => {
      if (internet.lossPct != null && internet.lossPct >= 100) {
        return [{ key: 'internet', severity: 'critical', title: 'Internet down', detail: 'Pings to the internet are failing', source: 'ping' }];
      }
      if (internet.rttMs != null && internet.rttMs > 100) {
        return [{
          key: 'internet-latency',
          severity: 'warning',
          title: 'High internet latency',
          detail: `Round-trip ${Math.round(internet.rttMs)} ms`,
          source: 'ping',
        }];
      }
      return [];
    },
  },
  {
    id: 'storage-health',
    evaluate: ({ facts, storage, nodeLabel }) => {
      const out: Finding[] = [];
      for (const enc of facts.enclosures.values()) {
        if (enc.health !== 'warn' && enc.health !== 'crit') continue;
        const vols = storage.filter((v) => v.enclosure === enc.id);
        const disk = vols.flatMap((v) => v.disks.map((d) => ({ d, v }))).find((x) => x.d.health !== 'ok');
        out.push({
          key: `enclosure:${enc.id}`,
          severity: enc.health === 'crit' ? 'critical' : 'warning',
          title: `${enc.label} health: ${enc.health === 'crit' ? 'critical' : 'warning'}`,
          detail: disk ? `${disk.d.model} in ${disk.v.label} reports ${disk.d.health === 'crit' ? 'failure' : 'warning'}` : enc.note ?? 'Enclosure reports a problem',
          source: 'storage',
        });
      }
      for (const v of storage) {
        for (const d of v.disks) {
          const enc = v.enclosure ? facts.enclosures.get(v.enclosure) : undefined;
          // Disks in an enclosure that already raised an incident are covered by that one.
          if (d.health === 'ok' || d.health === 'unknown' || enc?.health === 'warn' || enc?.health === 'crit') continue;
          out.push({
            key: `disk:${d.id}`,
            severity: d.health === 'crit' ? 'critical' : 'warning',
            title: `Disk ${d.slot} ${d.health === 'crit' ? 'failing' : 'degraded'}`,
            detail: `${d.model} in ${v.label} on ${nodeLabel(v.host)}`,
            source: 'storage',
          });
        }
        if (v.usedBytes != null && v.totalBytes && v.usedBytes / v.totalBytes > 0.9) {
          out.push({
            key: `volume-full:${v.id}`,
            severity: v.usedBytes / v.totalBytes > 0.97 ? 'critical' : 'warning',
            title: `${v.label} is ${Math.round((v.usedBytes / v.totalBytes) * 100)}% full`,
            detail: `on ${nodeLabel(v.host)}`,
            source: 'storage',
          });
        }
      }
      return out;
    },
  },
  {
    id: 'download-failed',
    evaluate: ({ pipeline }) => {
      const out: Finding[] = [];
      for (const item of pipeline) {
        if (item.stages.downloaded !== 'failed') continue;
        // Recovered once the same media was imported by a later release.
        const replacement = item.mediaKey
          ? pipeline.find((p) => p.id !== item.id && p.mediaKey === item.mediaKey && p.stages.imported === 'verified' && p.updatedAt >= item.updatedAt)
          : undefined;
        out.push({
          key: `dl-failed:${item.id}`,
          severity: 'warning',
          title: 'Download not completed',
          detail: `${item.title}: downloading failed`,
          source: item.client || 'downloads',
          since: item.updatedAt,
          resolvedAt: replacement ? replacement.updatedAt : undefined,
        });
      }
      return out;
    },
  },
  {
    id: 'arr-stuck',
    evaluate: ({ facts }) => {
      const out: Finding[] = [];
      for (const [id, arr] of facts.arr) {
        const stuck = arr.queue.filter((q) => BLOCKED_STATES.has(q.trackedState ?? '') && q.trackedStatus !== 'ok');
        if (!stuck.length) continue;
        const messages = stuck.flatMap((q) => q.messages);
        const first = messages[0] ?? 'Import blocked';
        const manual = /manual import/i.test(messages.join(' ')) || /match/i.test(first);
        out.push({
          key: `arr-stuck:${id}`,
          severity: 'warning',
          title: `${stuck.length} download${stuck.length > 1 ? 's' : ''} stuck in ${arr.label}`,
          detail: `${messages.length} × ${shorten(first)}${manual ? ' — needs a manual import' : ''} — ${arr.label} → Activity → Queue`,
          source: id,
        });
      }
      return out;
    },
  },
  {
    id: 'arr-health',
    evaluate: ({ facts }) =>
      [...facts.arr.entries()].flatMap(([id, arr]) =>
        arr.health
          .filter((h) => h.type === 'warning' || h.type === 'error')
          .map((h) => ({
            key: `arr-health:${id}:${h.source ?? h.message}`,
            severity: h.type === 'error' ? 'critical' as const : 'warning' as const,
            title: `${arr.label} health`,
            detail: h.message,
            source: id,
          })),
      ),
  },
  {
    id: 'source-down',
    forMs: 60_000,
    evaluate: ({ facts }) =>
      [...facts.sources.values()]
        .filter((s) => !s.ok && s.lastError)
        .map((s) => ({
          key: `source:${s.id}`,
          severity: 'info',
          title: `Can't reach ${s.id}`,
          detail: s.lastError ?? 'collector failing',
          source: s.id,
        })),
  },
  {
    id: 'link-saturated',
    evaluate: ({ links, nodeLabel, utilHistory }) =>
      links
        .filter((l) => {
          const h = utilHistory(l.id).slice(-30);
          return h.length >= 30 && h.every((u) => u != null && u > 0.9);
        })
        .map((l) => ({
          key: `link:${l.id}`,
          severity: 'warning',
          title: `${nodeLabel(l.from)} → ${nodeLabel(l.to)} saturated`,
          detail: `Above 90% of ${l.medium} for 5 minutes`,
          source: 'network',
        })),
  },
];

function shorten(msg: string): string {
  if (/didn'?t match|did not match|not.*matched/i.test(msg)) return "release name didn't match";
  return msg.length > 60 ? `${msg.slice(0, 57)}…` : msg;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const RECOVERED_TTL_MS = 24 * 3600_000;

export class IncidentEngine {
  private open = new Map<string, Incident>();
  private pending = new Map<string, number>();
  private recovered: Incident[] = [];
  private recoveredKeys = new Set<string>();

  constructor(private rules: Rule[] = RULES) {}

  evaluate(ctx: RuleContext): Incident[] {
    const findings: { f: Finding; rule: Rule }[] = [];
    for (const rule of this.rules) {
      try {
        for (const f of rule.evaluate(ctx)) findings.push({ f, rule });
      } catch {
        // A broken rule must never take the dashboard down.
      }
    }
    return this.update(findings, ctx.now);
  }

  update(findings: { f: Finding; rule?: Rule }[], now: number): Incident[] {
    const active = new Set<string>();
    for (const { f, rule } of findings) {
      if (f.resolvedAt != null) {
        const open = this.open.get(f.key);
        if (open) this.close(f.key, open, f.resolvedAt);
        else if (!this.recoveredKeys.has(f.key)) this.addRecovered(f, f.since ?? f.resolvedAt, f.resolvedAt);
        continue;
      }
      active.add(f.key);
      const existing = this.open.get(f.key);
      if (existing) {
        Object.assign(existing, { severity: f.severity, title: f.title, detail: f.detail });
        continue;
      }
      const firstSeen = this.pending.get(f.key) ?? now;
      this.pending.set(f.key, firstSeen);
      if (now - firstSeen >= (rule?.forMs ?? 0)) {
        this.pending.delete(f.key);
        const openedAt = f.since ?? firstSeen;
        this.open.set(f.key, {
          id: `${f.key}@${openedAt}`,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          source: f.source,
          openedAt,
          resolvedAt: null,
          state: 'open',
        });
      }
    }
    for (const key of this.pending.keys()) if (!active.has(key)) this.pending.delete(key);
    for (const [key, inc] of this.open) if (!active.has(key)) this.close(key, inc, now);

    this.recovered = this.recovered.filter((i) => now - (i.resolvedAt ?? now) < RECOVERED_TTL_MS).slice(0, 30);
    const open = [...this.open.values()].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.openedAt - a.openedAt,
    );
    return [...open, ...this.recovered];
  }

  private close(key: string, inc: Incident, at: number) {
    this.open.delete(key);
    this.rememberRecovered(key);
    this.recovered.unshift({ ...inc, state: 'recovered', resolvedAt: at });
    this.recovered.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  }

  private rememberRecovered(key: string) {
    this.recoveredKeys.add(key);
    if (this.recoveredKeys.size > 2000) this.recoveredKeys.delete(this.recoveredKeys.values().next().value!);
  }

  private addRecovered(f: Finding, openedAt: number, resolvedAt: number) {
    this.rememberRecovered(f.key);
    this.recovered.push({
      id: `${f.key}@${openedAt}`,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      source: f.source,
      openedAt,
      resolvedAt,
      state: 'recovered',
    });
    this.recovered.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  }
}
