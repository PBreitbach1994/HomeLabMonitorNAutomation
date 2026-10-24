import { useState } from 'react';
import type { NodeKind, Protocol, Snapshot, TopoLink, TopoNode } from '../../../shared/model.ts';
import { PROTOCOL_LABEL, PROTOCOLS } from '../../../shared/model.ts';
import { Sparkline } from '../components/charts/Sparkline.tsx';
import { TimeChart } from '../components/charts/TimeChart.tsx';
import { Panel } from '../components/panels.tsx';
import { HEALTH_COLOR, HEALTH_LABEL, MEDIUM_COLOR, PROTOCOL_COLOR, PROTOCOL_STACK, STATUS } from '../lib/colors.ts';
import { useHistory } from '../lib/data.ts';
import { fmtBps, fmtMs, fmtPct, fmtUptime } from '../lib/format.ts';

const ICON: Record<NodeKind, string> = {
  internet: '◍', router: '◇', switch: '☰', mesh: '◠', host: '▣', nas: '▤', device: '▫', laptop: '⌨', printer: '⎙', dock: '⇆', hub: '◉',
};

const total = (l?: TopoLink) => (l?.measured ? (l.downBps ?? 0) + (l.upBps ?? 0) : null);

export function NetworkView({ snap, selected, onSelect }: { snap: Snapshot; selected: string | null; onSelect: (id: string) => void }) {
  const sel = selected && snap.nodes.some((n) => n.id === selected) ? selected : snap.nodes.find((n) => n.kind === 'nas')?.id ?? snap.nodes[0].id;
  return (
    <div className="grid" style={{ gap: 'var(--gap)' }}>
      <Kpis snap={snap} />
      <div className="grid net-main" style={{ gridTemplateColumns: 'minmax(0, 1.75fr) minmax(320px, 1fr)' }}>
        <section className="panel">
          <TopologyTree snap={snap} sel={sel} onSel={onSelect} />
        </section>
        <div className="grid" style={{ alignContent: 'start' }}>
          <DevicePanel snap={snap} nodeId={sel} />
          <VpnCard snap={snap} />
        </div>
      </div>
      <div className="grid three">
        <ProtocolChart snap={snap} />
        <Busiest snap={snap} onSel={onSelect} />
        <LinkUtilization snap={snap} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ KPIs

function Kpis({ snap }: { snap: Snapshot }) {
  const t = snap.traffic;
  const top = t.topProtocol;
  return (
    <div className="grid four">
      <div className="panel kpi">
        <span className="l">Internet</span>
        <div>
          <div className="v sm num" style={{ color: '#5eead4' }}>↓ {fmtBps(snap.internet.downBps)}</div>
          <div className="v sm num" style={{ color: '#93c5fd' }}>↑ {fmtBps(snap.internet.upBps)}</div>
        </div>
        <Sparkline values={snap.internet.downHistory} color="#2dd4bf" width={120} height={40} />
      </div>
      <div className="panel kpi">
        <span className="l">Total network</span>
        <div className="v">{fmtBps(t.lanBps)}</div>
        <Sparkline values={t.lanHistory} color="#4ade80" width={120} height={40} />
      </div>
      <div className="panel kpi">
        <span className="l">Active devices</span>
        <div>
          <div className="v">{t.activeDevices ?? '—'}</div>
          <div className="s">{t.wifiGroups} groups on Wi-Fi</div>
        </div>
        <DeviceBars snap={snap} />
      </div>
      <div className="panel kpi">
        <span className="l">Top protocol</span>
        <div>
          <div className="v" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {top && <i className="sq" style={{ width: 18, height: 18, borderRadius: 5, background: PROTOCOL_COLOR[top], display: 'inline-block' }} />}
            {top ? PROTOCOL_LABEL[top] : '—'}
          </div>
          <div className="s">{top ? `${fmtPct(t.topProtocolShare)} of traffic` : 'no app traffic'}</div>
        </div>
        {top && <Sparkline values={t.byProtocol[top].slice(-40)} color={PROTOCOL_COLOR[top]} width={120} height={40} />}
      </div>
    </div>
  );
}

/** Per-edge-device throughput as tiny columns (one per device, biggest first). */
function DeviceBars({ snap }: { snap: Snapshot }) {
  const vals = snap.links
    .filter((l) => !snap.links.some((c) => c.from === l.to))
    .map((l) => total(l) ?? 0)
    .sort((a, b) => b - a)
    .slice(0, 10);
  const max = Math.log10(1 + Math.max(...vals, 1) / 1e3);
  return (
    <svg width={110} height={40} aria-hidden>
      {vals.map((v, i) => {
        const h = Math.max(3, (Math.log10(1 + v / 1e3) / max) * 36);
        return <rect key={i} x={i * 11} y={40 - h} width={7} height={h} rx={2} fill="#3b82f6" opacity={0.35 + 0.65 * (h / 36)} />;
      })}
    </svg>
  );
}

// ------------------------------------------------------------------ topology tree

function TNode({ node, link, sel, onSel, extra, wide }: { node: TopoNode; link?: TopoLink; sel: string; onSel: (id: string) => void; extra?: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`tnode ${sel === node.id ? 'sel' : ''}`} style={wide ? { width: '100%' } : undefined} onClick={() => onSel(node.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSel(node.id)}>
      <span className="ico" aria-hidden>{ICON[node.kind]}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nm">{node.label}</div>
        <div className="sb">{node.model ?? node.sublabel}</div>
      </div>
      {extra}
      {link?.measured && <Sparkline values={link.history} color={MEDIUM_COLOR[link.medium]} width={60} height={22} fill={false} />}
    </div>
  );
}

function VLine({ link }: { link?: TopoLink }) {
  const color = link ? MEDIUM_COLOR[link.medium] : '#2c3a56';
  const t = total(link);
  const dur = t ? Math.max(0.35, 2.4 - 0.55 * Math.log10(1 + t / 1e6)) : 0;
  return (
    <div className="tvline" style={{ background: color, ['--dur' as string]: `${dur}s`, opacity: link?.measured ? 0.95 : 0.35 }}>
      {link && (
        <span className="tvlabel">
          <b>{link.medium}</b> {link.measured ? `${fmtBps(Math.max(link.downBps ?? 0, link.upBps ?? 0))} · ${fmtPct(link.util)}` : '· no counters'}
        </span>
      )}
    </div>
  );
}

function TopologyTree({ snap, sel, onSel }: { snap: Snapshot; sel: string; onSel: (id: string) => void }) {
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  const kids = (id: string) => snap.nodes.filter((n) => n.parent === id);
  const upLink = (id: string) => snap.links.find((l) => l.to === id);
  const internet = snap.nodes.find((n) => n.kind === 'internet')!;

  // Follow the single-child chain (internet → router → core) down to where the tree fans out.
  const chain: TopoNode[] = [internet];
  for (;;) {
    const wired = kids(chain[chain.length - 1].id).filter((n) => n.kind !== 'mesh');
    if (wired.length !== 1 || !kids(wired[0].id).length) break;
    chain.push(wired[0]);
  }
  const fan = chain[chain.length - 1];
  const fanKids = kids(fan.id).filter((n) => n.kind !== 'mesh');
  const columns = fanKids.filter((n) => kids(n.id).length);
  const direct = fanKids.filter((n) => !kids(n.id).length);
  const router = chain.find((n) => n.kind === 'router');
  const mesh = snap.nodes.filter((n) => n.kind === 'mesh');
  const colCount = columns.length + (direct.length ? 1 : 0) + (mesh.length ? 1 : 0);
  const coreSwitch = chain.find((n) => n.kind === 'switch');
  const coreLinks = coreSwitch ? snap.links.filter((l) => l.from === coreSwitch.id) : [];
  const coreThrough = coreLinks.reduce((a, l) => a + (l.downBps ?? 0) + (l.upBps ?? 0), 0);

  const portRow = (n: TopoNode) => {
    const l = upLink(n.id);
    const isWifi = n.kind === 'mesh';
    return (
      <div key={n.id} className={`tport ${sel === n.id ? 'sel' : ''}`} onClick={() => onSel(n.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSel(n.id)}>
        <span className="ico" aria-hidden>{ICON[n.kind]}</span>
        <div style={{ minWidth: 0 }}>
          <div className="nm">{n.label}</div>
          <div className="sb">
            {isWifi ? `Wi-Fi · ${n.wifiClients ?? '—'} devices` : `${n.sublabel ?? ''} · ${l?.medium === '100M' ? '100M' : l?.medium ?? ''}`}
          </div>
          {!isWifi && <div className={`rt ${l?.measured ? '' : 'wifi'}`}>{l?.measured ? fmtBps(total(l)) : 'no counters'}</div>}
        </div>
        <div className="side">
          {l?.measured && <Sparkline values={l.history} color={l.bonded ? PROTOCOL_COLOR.soulseek : MEDIUM_COLOR[l.medium]} width={56} height={20} fill={false} />}
          {n.tag && <span className="tag-pill">{n.tag}</span>}
          <i className="sdot" style={{ background: HEALTH_COLOR[n.health], width: 6, height: 6 }} title={HEALTH_LABEL[n.health]} />
        </div>
      </div>
    );
  };

  return (
    <div className="tree">
      <div className="tree-top">
        <div className="tree-side hide-narrow">
          <div className="info-card">
            <div className="t">WAN</div>
            <div className="muted">Your ISP connection into the {router?.sublabel ?? 'router'}. Traffic shown is internet in / out.</div>
            <div className="r" style={{ marginTop: 4 }}><span>↓ {fmtBps(snap.internet.downBps)}</span><b>↑ {fmtBps(snap.internet.upBps)}</b></div>
          </div>
          {coreSwitch && (
            <div className="info-card">
              <div className="t">Core switch</div>
              <div className="r"><span>Ports</span><b>{coreLinks.length} downstream</b></div>
              {coreSwitch.ip && <div className="r"><span>Address</span><b>{coreSwitch.ip}</b></div>}
              <div className="r"><span>Through it</span><b>{fmtBps(coreThrough)}</b></div>
              <div className="r"><span>Monitoring</span><b>{upLink(coreSwitch.id)?.measured ? (snap.mode === 'demo' ? 'simulated' : 'live') : 'none'}</b></div>
            </div>
          )}
        </div>
        <div>
          {chain.map((n, i) => (
            <div key={n.id}>
              {i > 0 && <VLine link={upLink(n.id)} />}
              <div className="tree-row">
                <TNode node={n} link={n.kind === 'internet' ? undefined : upLink(n.id)} sel={sel} onSel={onSel} />
              </div>
            </div>
          ))}
        </div>
        <div className="tree-side hide-narrow">
          <div className="info-card">
            <div className="t">Internet health</div>
            <div className="r"><span>Latency</span><b>{fmtMs(snap.internet.rttMs)} ms</b></div>
            <div className="r"><span>Jitter</span><b>{fmtMs(snap.internet.jitterMs)} ms</b></div>
            <div className="r"><span>Gateway</span><b>{fmtMs(snap.internet.routerRttMs)} ms</b></div>
            <div className="r"><span>Loss</span><b>{snap.internet.lossPct == null ? '—' : `${snap.internet.lossPct}%`}</b></div>
            <div className="r"><span>Provider</span><b>{snap.internet.provider || '—'}</b></div>
          </div>
        </div>
      </div>

      {/* fan-out from the core to each access switch */}
      <svg width="100%" height="46" viewBox="0 0 100 46" preserveAspectRatio="none" style={{ display: 'block' }} aria-hidden>
        {[...columns, ...(direct.length ? [null] : [])].map((c, i) => {
          const cx = ((i + 0.5) / colCount) * 100;
          const l = c ? upLink(c.id) : undefined;
          return (
            <path
              key={c?.id ?? 'direct'}
              d={`M50,0 C50,26 ${cx.toFixed(2)},20 ${cx.toFixed(2)},46`}
              fill="none"
              stroke={l ? MEDIUM_COLOR[l.medium] : '#2c3a56'}
              strokeWidth={3}
              strokeOpacity={l?.measured ? 0.9 : 0.4}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <div className="tcols" style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}>
        {columns.map((c) => {
          const l = upLink(c.id);
          return (
            <div key={c.id}>
              <div className="muted num" style={{ fontSize: 12, margin: '0 0 6px 4px' }}>
                {l ? `${l.medium} · ${l.measured ? `${fmtBps(Math.max(l.downBps ?? 0, l.upBps ?? 0))} · ${fmtPct(l.util)}` : 'no counters'}` : ''}
              </div>
              <TNode node={c} link={l} sel={sel} onSel={onSel} wide />
              <div className="tports">{kids(c.id).map(portRow)}</div>
            </div>
          );
        })}
        {direct.length > 0 && (
          <div>
            <div className="muted" style={{ fontSize: 12, margin: '0 0 6px 4px' }}>Direct on {fan.label}</div>
            <div className="tports" style={{ marginTop: 0 }}>{direct.map(portRow)}</div>
          </div>
        )}
        {mesh.length > 0 && (
          <div>
            <div className="muted" style={{ fontSize: 11, margin: '0 0 6px 4px', letterSpacing: '0.12em' }}>WI-FI · {router?.sublabel?.split(' ')[0]?.toUpperCase() ?? 'MESH'} MESH</div>
            <div className="tports" style={{ marginTop: 0, marginLeft: 0, paddingLeft: 0 }}>
              {router && (
                <div className={`tport ${sel === router.id ? 'sel' : ''}`} onClick={() => onSel(router.id)} role="button" tabIndex={0}>
                  <span className="ico" aria-hidden>◠</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{router.label}</div>
                    <div className="sb">Wi-Fi · {router.wifiClients ?? '—'} devices</div>
                  </div>
                  <div className="side"><i className="sdot" style={{ background: HEALTH_COLOR[router.health], width: 6, height: 6 }} /></div>
                </div>
              )}
              {mesh.map(portRow)}
            </div>
          </div>
        )}
      </div>
      {byId.size === 0 && <div className="empty">No topology configured.</div>}
    </div>
  );
}

// ------------------------------------------------------------------ selected device

function DevicePanel({ snap, nodeId }: { snap: Snapshot; nodeId: string }) {
  const [tab, setTab] = useState<'overview' | 'traffic' | 'details'>('overview');
  const node = snap.nodes.find((n) => n.id === nodeId)!;
  const link = node.kind === 'internet' ? snap.links.find((l) => l.from === node.id) : snap.links.find((l) => l.to === node.id);
  const host = snap.hosts.find((h) => h.id === node.id);
  const parent = node.parent ? snap.nodes.find((n) => n.id === node.parent) : undefined;
  const keys = link ? [`link:${link.id}`, `link:${link.id}:down`, `link:${link.id}:up`] : [];
  const hist = useHistory(keys);
  const series = (k: string) => hist[k]?.points ?? [];
  const mean = (k: string) => {
    const v = series(k).filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const stepMs = (link && hist[`link:${link.id}`]?.stepMs) || 10_000;
  const mix = link ? PROTOCOLS.map((p) => [p, link.mix[p] ?? 0] as [Protocol, number]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]) : [];
  const mixTotal = mix.reduce((a, [, v]) => a + v, 0);
  const touching = snap.links.filter((l) => l.from === node.id || l.to === node.id).sort((a, b) => (total(b) ?? 0) - (total(a) ?? 0)).slice(0, 6);
  const other = (l: TopoLink) => snap.nodes.find((n) => n.id === (l.from === node.id ? l.to : l.from))?.label ?? '';
  const maxTouch = Math.max(1, ...touching.map((l) => total(l) ?? 0));

  return (
    <section className="panel">
      <div className="h2">Selected device</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <span className="ico" style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--panel-3)', display: 'grid', placeItems: 'center', fontSize: 18 }} aria-hidden>{ICON[node.kind]}</span>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600 }}>{node.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <i className="sdot" style={{ background: HEALTH_COLOR[node.health] }} />
            <span className="dim">{node.health === 'ok' ? 'Online' : HEALTH_LABEL[node.health]}</span>
          </div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(['overview', 'traffic', 'details'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="dim" style={{ fontSize: 13 }}>Throughput · 1h</div>
          <div className="big num">{link?.measured ? fmtBps(total(link)) : '—'}</div>
          {link?.measured ? (
            <TimeChart series={[{ key: 'total', label: 'Total', color: '#2dd4bf', values: series(`link:${link.id}`) }]} stepMs={stepMs} height={150} />
          ) : (
            <div className="empty">No counters measure this device's link.</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginTop: 6 }}>
            <span style={{ color: '#5eead4' }}>↓ Download {fmtBps(mean(`link:${link?.id}:down`))}</span>
            <span style={{ color: '#93c5fd' }}>↑ Upload {fmtBps(mean(`link:${link?.id}:up`))}</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5, textAlign: 'right' }}>1h averages</div>

          <div className="section-title">Top protocols <small>this device</small></div>
          {mix.length ? (
            mix.map(([p, v]) => (
              <div className="mix-row" key={p}>
                <i className="sq" style={{ background: PROTOCOL_COLOR[p] }} />
                <span>{PROTOCOL_LABEL[p]}</span>
                <div className="bar"><i style={{ width: `${(v / (mixTotal || 1)) * 100}%`, background: PROTOCOL_COLOR[p] }} /></div>
                <span className="v">{fmtPct(v / (mixTotal || 1))}</span>
              </div>
            ))
          ) : (
            <div className="muted">No traffic attributed.</div>
          )}

          <div className="section-title">Device details</div>
          <dl className="kv">
            <dt>Type</dt><dd>{node.model ?? node.sublabel ?? node.kind}</dd>
            {node.ip && (<><dt>IP address</dt><dd>{node.ip}</dd></>)}
            {link && (<><dt>Link</dt><dd>{parent?.label ?? ''} · {link.medium}{link.bonded ? ' (bond)' : ''}</dd></>)}
            {host && (
              <>
                <dt>Uptime</dt><dd>{fmtUptime(host.uptimeS)}</dd>
                <dt>CPU</dt><dd>{host.cpuPct == null ? '—' : `${Math.round(host.cpuPct)}%`}</dd>
                <dt>Memory</dt><dd>{host.memPct == null ? '—' : `${Math.round(host.memPct)}%`}</dd>
                <dt>Temperature</dt><dd>{host.tempC == null ? '—' : `${Math.round(host.tempC)}°C`}</dd>
              </>
            )}
            {node.wifiClients != null && (<><dt>Wi-Fi clients</dt><dd>{node.wifiClients}</dd></>)}
          </dl>

          <div className="section-title">Live links <small>top {touching.length}</small></div>
          {touching.map((l) => (
            <div className="mix-row" key={l.id} style={{ gridTemplateColumns: '14px minmax(0,1.2fr) 1fr 74px' }}>
              <i className="sq" style={{ background: MEDIUM_COLOR[l.medium] }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{other(l)} · {l.medium}</span>
              <div className="bar"><i style={{ width: `${((total(l) ?? 0) / maxTouch) * 100}%`, background: MEDIUM_COLOR[l.medium] }} /></div>
              <span className="v">{fmtBps(total(l))}</span>
            </div>
          ))}
        </>
      )}

      {tab === 'traffic' && (
        link?.measured ? (
          <>
            <div className="legend" style={{ marginBottom: 6 }}>
              <span className="k"><i className="line" style={{ background: '#2dd4bf' }} />Download ↓</span>
              <span className="k"><i className="line" style={{ background: '#a78bfa' }} />Upload ↑</span>
            </div>
            <TimeChart
              series={[
                { key: 'down', label: 'Download', color: '#2dd4bf', values: series(`link:${link.id}:down`) },
                { key: 'up', label: 'Upload', color: '#a78bfa', values: series(`link:${link.id}:up`) },
              ]}
              stepMs={stepMs}
              height={200}
            />
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Now ↓</dt><dd>{fmtBps(link.downBps)}</dd>
              <dt>Now ↑</dt><dd>{fmtBps(link.upBps)}</dd>
              <dt>Utilization</dt><dd>{fmtPct(link.util)}</dd>
            </dl>
          </>
        ) : (
          <div className="empty">No counters measure this device's link.</div>
        )
      )}

      {tab === 'details' && (
        <dl className="kv">
          <dt>Node id</dt><dd>{node.id}</dd>
          <dt>Kind</dt><dd>{node.kind}</dd>
          {link && (
            <>
              <dt>Measured at</dt><dd>{link.port ?? '—'}</dd>
              <dt>Counters</dt><dd>{link.measured ? (link.approx ? 'approximate' : 'yes') : 'none'}</dd>
              <dt>Link speed</dt><dd>{fmtBps(link.speedBps)}</dd>
            </>
          )}
          <dt>Status</dt><dd>{HEALTH_LABEL[node.health]}</dd>
          <dt>Data</dt><dd>{snap.mode === 'demo' ? 'simulated' : snap.mode === 'mixed' ? 'live + simulated' : 'live'}</dd>
        </dl>
      )}
    </section>
  );
}

function VpnCard({ snap }: { snap: Snapshot }) {
  const v = snap.vpn;
  const host = snap.nodes.find((n) => n.id === v.host)?.label ?? v.host ?? '—';
  const apps = snap.services.filter((s) => s.vpn && ['sabnzbd', 'qbittorrent', 'soulseek'].includes(s.id)).map((s) => s.label);
  return (
    <section className="panel">
      <div className="h2">VPN tunnel</div>
      <div className={`sealed ${v.up === false ? 'bad' : ''}`} style={{ marginTop: 8, color: v.up == null ? 'var(--text-2)' : undefined }}>
        {v.up == null ? 'No data' : v.up ? 'Sealed' : 'Down'}
      </div>
      <div className="dim" style={{ marginTop: 4 }}>
        {apps.length ? `${apps.join(', ')} run inside Gluetun on ${host}` : `${v.services.length} services route through Gluetun on ${host}`}
        {v.throughputBps != null ? ` · ${fmtBps(v.throughputBps)}` : ''}
      </div>
      {(v.publicIp || v.country) && (
        <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
          Exit {v.publicIp ?? ''} {v.country ? `· ${v.country}` : ''} {v.provider ? `· ${v.provider}` : ''}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ bottom row

function ProtocolChart({ snap }: { snap: Snapshot }) {
  const series = PROTOCOL_STACK.filter((p) => snap.traffic.byProtocol[p].some((v) => v > 0) || p === 'other').map((p) => ({
    key: p,
    label: PROTOCOL_LABEL[p],
    color: PROTOCOL_COLOR[p],
    values: snap.traffic.byProtocol[p],
  }));
  return (
    <section className="panel">
      <div className="h2">Network traffic <small>by protocol · 1h</small></div>
      <div style={{ marginTop: 14 }}>
        <TimeChart series={series} stepMs={30_000} height={220} stacked />
      </div>
      <div className="legend">
        {series.map((s) => (
          <span className="k" key={s.key}><i className="sq" style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
    </section>
  );
}

function Busiest({ snap, onSel }: { snap: Snapshot; onSel: (id: string) => void }) {
  const label = (id: string) => snap.nodes.find((n) => n.id === id);
  return (
    <section className="panel">
      <div className="h2">Busiest right now</div>
      <table className="table" style={{ marginTop: 10 }}>
        <tbody>
          {snap.traffic.busiest.map((b, i) => {
            const n = label(b.node);
            return (
              <tr key={`${b.node}-${b.protocol}-${i}`} onClick={() => onSel(b.node)} style={{ cursor: 'pointer' }}>
                <td className="n">{fmtBps(b.bps)}</td>
                <td>
                  <span className="muted" aria-hidden style={{ marginRight: 8 }}>{n ? ICON[n.kind] : ''}</span>
                  {n?.label ?? b.node}
                </td>
                <td className="r dim">
                  <i className="sdot" style={{ background: PROTOCOL_COLOR[b.protocol], width: 7, height: 7, marginRight: 6 }} />
                  {PROTOCOL_LABEL[b.protocol]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {snap.traffic.busiest.length === 0 && <div className="empty">No measured traffic.</div>}
    </section>
  );
}

function LinkUtilization({ snap }: { snap: Snapshot }) {
  const label = (id: string) => snap.nodes.find((n) => n.id === id)?.label ?? id;
  const rows = snap.links.filter((l) => l.measured && l.medium !== 'wifi').sort((a, b) => (b.util ?? 0) - (a.util ?? 0)).slice(0, 13);
  return (
    <Panel title="Link utilization" dot="#2dd4bf">
      {rows.map((l) => {
        const u = l.util ?? 0;
        const color = u >= 0.85 ? STATUS.critical : u >= 0.6 ? STATUS.warning : '#60a5fa';
        return (
          <div className="util-row" key={l.id} title={`${label(l.from)} → ${label(l.to)} · ${l.medium} · ↓${fmtBps(l.downBps)} ↑${fmtBps(l.upBps)}`}>
            <span className="lbl">{label(l.from).replace(/\s*\(.*\)/, '')} → {label(l.to)}</span>
            <div className="bar"><i style={{ width: `${Math.max(1.5, u * 100)}%`, background: color }} /></div>
            <span className="v">{fmtPct(u)}</span>
          </div>
        );
      })}
    </Panel>
  );
}
