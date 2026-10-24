import type { ReactNode } from 'react';
import type { CameraEvent, Evidence, Incident, PipelineItem, Snapshot } from '../../../shared/model.ts';
import { STAGE_LABEL, STAGES } from '../../../shared/model.ts';
import { HEALTH_COLOR, HEALTH_LABEL, STATUS } from '../lib/colors.ts';
import { fmtAgo, fmtBps, fmtBytes, fmtMs, fmtPct, fmtUptime } from '../lib/format.ts';
import { Ring } from './charts/Ring.tsx';
import { Sparkline } from './charts/Sparkline.tsx';

export function Panel({
  title,
  right,
  dot,
  className = '',
  children,
}: {
  title: string;
  right?: ReactNode;
  dot?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${className}`} style={dot ? ({ '--title-dot': dot } as React.CSSProperties) : undefined}>
      <div className="panel-head">
        <h2 className="panel-title" style={{ margin: 0 }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ media pipeline

const EVIDENCE_TEXT: Record<Evidence, string> = {
  verified: 'verified',
  inferred: 'inferred',
  none: 'no evidence yet',
  active: 'in progress',
  failed: 'failed',
  blocked: 'blocked',
};

function PipelineRow({ item, now }: { item: PipelineItem; now: number }) {
  const cur = item.stages[item.current];
  const statusClass = cur === 'failed' && !item.status.includes('replaced') ? 'failed' : cur === 'blocked' ? 'blocked' : '';
  const furthest = Math.max(...STAGES.map((s, i) => (item.stages[s] !== 'none' ? i : -1)));
  return (
    <div className="pipe-row">
      <div className="pipe-top">
        <span className="kind-ico" aria-hidden>{item.kind === 'movie' ? '▶' : item.kind === 'music' ? '♪' : '▤'}</span>
        <span className="pipe-title" title={item.title}>{item.title}</span>
        <span className={`pipe-status ${statusClass}`}>
          {item.status}
          {item.progress != null && cur === 'active' ? ` ${Math.round(item.progress * 100)}%` : ''} · {fmtAgo(item.updatedAt, now)}
        </span>
      </div>
      <div className="stages" role="list" aria-label={`${item.title} pipeline`}>
        {STAGES.map((s, i) => (
          <div key={s} className={`stage ${i <= furthest && i > 0 ? 'lit' : ''}`} role="listitem" title={`${STAGE_LABEL[s]}: ${EVIDENCE_TEXT[item.stages[s]]}`}>
            <span className={`d ${item.stages[s]}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MediaPipeline({ snap, now, limit = 4 }: { snap: Snapshot; now: number; limit?: number }) {
  const items = snap.pipeline.slice(0, limit);
  return (
    <Panel title="Media pipeline" right={<span className="panel-note">{snap.pipelineTracked} tracked</span>}>
      {items.length ? (
        <>
          <div className="stage-labels" aria-hidden>
            {STAGES.map((s) => <span key={s}>{STAGE_LABEL[s]}</span>)}
          </div>
          {items.map((i) => <PipelineRow key={i.id} item={i} now={now} />)}
        </>
      ) : (
        <div className="empty">Nothing in flight.</div>
      )}
      <div className="pipe-legend">
        <span><i style={{ background: '#34d399' }} />verified</span>
        <span><i style={{ border: '2px dashed #34d399' }} />inferred</span>
        <span><i style={{ border: '2px solid #34405a' }} />no evidence yet</span>
        <span><i style={{ background: STATUS.critical }} />failed</span>
        <span><i style={{ background: STATUS.warning }} />blocked</span>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ hosts

export function Hosts({ snap }: { snap: Snapshot }) {
  return (
    <Panel title="Hosts">
      {snap.hosts.map((h) => (
        <div className="host-row" key={h.id}>
          <div className="host-name">
            <span className="sdot glow" style={{ background: HEALTH_COLOR[h.health], color: HEALTH_COLOR[h.health] }} title={HEALTH_LABEL[h.health]} />
            <span>{h.label}</span>
          </div>
          <Ring value={h.cpuPct} label={`${h.label} CPU`} />
          <div>
            <div className="metric-label">Memory</div>
            <div className="metric-val">{fmtPct(h.memPct == null ? null : h.memPct / 100)}</div>
            <div className="bar"><i style={{ width: `${h.memPct ?? 0}%` }} /></div>
          </div>
          <div className="temp">
            <div className="metric-label">Temp</div>
            <div className="metric-val">{h.tempC == null ? '—' : `${Math.round(h.tempC)}°`}</div>
          </div>
          <div className="up">
            <div className="metric-label">Up</div>
            <div className="metric-val">{fmtUptime(h.uptimeS)}</div>
          </div>
        </div>
      ))}
    </Panel>
  );
}

// ------------------------------------------------------------------ services

export function Services({ snap }: { snap: Snapshot }) {
  const expected = snap.services.filter((s) => s.note !== 'MANUAL START' && s.state !== 'manual' && !(s.state === 'paused' && s.health === 'ok'));
  const up = expected.filter((s) => s.state === 'running').length;
  const bad = expected.length - up;
  return (
    <Panel
      title="Services"
      right={
        <span className={`svc-count ${bad ? 'bad' : ''}`} title={`${up} of ${expected.length} expected services running`}>
          {up}<small>/{expected.length}</small>
        </span>
      }
    >
      <div className="svc-grid">
        {snap.services.map((s) => {
          const cls = s.health === 'crit' ? 'bad' : s.health === 'warn' ? 'warn' : s.health === 'off' || s.health === 'unknown' ? 'off' : '';
          return (
            <div key={s.id} className={`svc ${cls}`} title={`${s.label} · ${s.state}${s.vpn ? ' · via VPN' : ''}`}>
              <span className="n">
                <i className="sdot" style={{ background: HEALTH_COLOR[s.health] }} />
                {s.label}
              </span>
              {s.note && <span className="tag">{s.note}</span>}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ storage

export function Storage({ snap }: { snap: Snapshot }) {
  const worst = snap.storage.some((v) => v.health === 'crit') ? 'crit' : snap.storage.some((v) => v.health === 'warn') ? 'warn' : 'ok';
  const hostLabel = (id: string) => snap.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <Panel
      title="Storage"
      dot={worst === 'ok' ? undefined : worst === 'warn' ? STATUS.warning : STATUS.critical}
      className={worst !== 'ok' ? 'warn-edge' : ''}
      right={
        snap.storage.length ? (
          <span className="chip ok" style={{ padding: '2px 6px' }} title="Collector reporting">✓</span>
        ) : undefined
      }
    >
      {snap.storage.length === 0 && <div className="empty">No storage collector configured.</div>}
      <div className="vol-grid">
        {snap.storage.map((v) => {
          const used = v.usedBytes != null && v.totalBytes ? v.usedBytes / v.totalBytes : null;
          const free = v.usedBytes != null && v.totalBytes != null ? v.totalBytes - v.usedBytes : null;
          return (
            <div key={v.id}>
              <div className="vol-head">
                <span className="vol-name">{v.label}</span>
                <span className="vol-host">{hostLabel(v.host)}{v.enclosure ? ` · ${v.enclosure}` : ''}</span>
                <span className="vol-pct">{fmtPct(used)}</span>
              </div>
              <div className="vol-bar" role="meter" aria-valuenow={used == null ? undefined : Math.round(used * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${v.label} used`}>
                <i style={{ width: `${(used ?? 0) * 100}%`, background: used != null && used > 0.9 ? STATUS.warning : undefined }} />
              </div>
              <div className="vol-foot">
                <span>{fmtBytes(free)} free</span>
                <span className="pips" aria-label={`${v.disks.length} disks`}>
                  {v.disks.map((d) => (
                    <i key={d.id} title={`${d.slot} · ${d.model} · ${HEALTH_LABEL[d.health]}${d.tempC != null ? ` · ${d.tempC}°C` : ''}`} style={{ background: d.health === 'ok' ? (d.ssd ? '#c9a23a' : '#16a34a') : HEALTH_COLOR[d.health] }} />
                  ))}
                </span>
              </div>
              {v.note && <div className="vol-note" style={{ color: v.health === 'crit' ? '#f87171' : '#f59e8b' }}>{v.note}</div>}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ incidents

function IncidentRow({ i, now }: { i: Incident; now: number }) {
  const badge = i.state === 'recovered' ? 'recovered' : i.severity;
  return (
    <div className={`inc ${i.state}`}>
      <span className={`badge ${badge}`}>{badge.toUpperCase()}</span>
      <div>
        <div className="inc-title">{i.title}</div>
        <div className="inc-detail">{i.detail}</div>
      </div>
      <span className="inc-time">{fmtAgo(i.state === 'recovered' ? i.resolvedAt : i.openedAt, now)}</span>
    </div>
  );
}

export function Incidents({ snap, now }: { snap: Snapshot; now: number }) {
  const open = snap.incidents.filter((i) => i.state === 'open').length;
  return (
    <Panel
      title="Incidents"
      dot={open ? STATUS.warning : STATUS.good}
      className={snap.attention ? 'warn-edge' : ''}
      right={<span className="panel-note">{open} open</span>}
    >
      {snap.incidents.length === 0 ? (
        <div className="empty">All quiet. Nothing has gone wrong in the last day.</div>
      ) : (
        <div className="inc-list">
          {snap.incidents.map((i) => <IncidentRow key={i.id} i={i} now={now} />)}
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ cameras

const CAM_ICON: Record<CameraEvent['kind'], string> = { motion: '◎', person: '☺', vehicle: '⛟', pet: '✿', doorbell: '♫' };

export function Cameras({ snap, now }: { snap: Snapshot; now: number }) {
  return (
    <Panel title="Cameras" right={<span className="pill" style={{ fontSize: 12, padding: '2px 10px' }}>Home</span>}>
      {snap.cameras.length === 0 ? (
        <div className="empty">No recent camera events</div>
      ) : (
        snap.cameras.slice(0, 5).map((c) => (
          <div className="cam" key={c.id}>
            <span className="cam-ico" aria-hidden>{CAM_ICON[c.kind]}</span>
            <div className="t">
              <div>{c.camera}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{c.kind === 'person' ? 'Person detected' : c.kind === 'vehicle' ? 'Vehicle detected' : c.kind === 'pet' ? 'Pet detected' : c.kind === 'doorbell' ? 'Doorbell' : 'Motion'}</div>
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>{fmtAgo(c.ts, now)}</span>
          </div>
        ))
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ network summary

function StatusChip({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span className={`chip ${ok == null ? 'unknown' : ok ? 'ok' : 'bad'}`}>
      {ok == null ? '?' : ok ? '✓' : '✕'} {label}
    </span>
  );
}

export function NetworkSummary({ snap }: { snap: Snapshot }) {
  const net = snap.internet;
  const w = snap.wifi;
  return (
    <Panel title="Network">
      <div className="net-top">
        <div>
          <div className="net-rtt">{fmtMs(net.rttMs)}<small>ms</small></div>
          <div className="muted" style={{ marginTop: 6 }}>internet round-trip · router {fmtMs(net.routerRttMs)} ms</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <Sparkline values={net.rttHistory} width={900} height={46} color="#60a5fa" fill responsive />
        </div>
      </div>
      <div className="net-row">
        <span className="net-rate">↓ {fmtBps(net.avgDownBps)}</span>
        <span className="net-rate">↑ {fmtBps(net.avgUpBps)}</span>
        <span className="muted">internet · avg this hour</span>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          today {fmtBytes(net.todayDownBytes)} ↓ {fmtBytes(net.todayUpBytes)} ↑
        </span>
      </div>
      <div className="chips">
        <StatusChip ok={net.health === 'unknown' ? null : net.health === 'ok'} label="Internet" />
        <StatusChip ok={snap.vpn.up} label={snap.vpn.up === false ? 'VPN down' : 'VPN up'} />
        <StatusChip ok={snap.tailscale.up} label="Tailscale" />
      </div>
      <div className="net-foot">
        <span>eero mesh</span>
        <span className="muted">
          {w.nodesOnline ?? '—'}/{w.nodesTotal} online · {w.devices ?? '—'} devices · {w.wired ?? '—'} wired
          {w.updateAvailable ? ' · update waiting' : ''}
        </span>
      </div>
    </Panel>
  );
}
