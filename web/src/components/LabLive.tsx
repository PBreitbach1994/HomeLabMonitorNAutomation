import { useMemo, useRef } from 'react';
import type { HostState, Snapshot } from '../../../shared/model.ts';
import { HEALTH_COLOR, MEDIUM_COLOR, PROTOCOL_COLOR, STATUS } from '../lib/colors.ts';
import { fmtBps, fmtMs } from '../lib/format.ts';
import { curvePath, sampleCurve, vCurve, type Curve } from '../lib/geometry.ts';
import type { Stream } from '../lib/particles.ts';
import { useParticles } from './NetworkMap.tsx';

const W = 1200;
const H = 600;
const NET = { x: 600, y: 64 };
const ROUTER = { x: 600, y: 178 };
const HOST_Y = 318;
const PLEX = { x: 1030, y: 178 };

/** Schematic: internet → router → hosts, with the containers grouped by VPN namespace under each host. */
export function LabLive({ snap }: { snap: Snapshot }) {
  const hosts = useMemo(() => {
    const vpnHosts = new Set(snap.services.filter((s) => s.vpn).map((s) => s.host));
    const rank = (h: HostState) => (vpnHosts.has(h.id) ? 0 : snap.nodes.find((n) => n.id === h.id)?.kind === 'nas' ? 2 : 1);
    return [...snap.hosts].sort((a, b) => rank(a) - rank(b));
  }, [snap.hosts, snap.services, snap.nodes]);

  const xs = hosts.map((_, i) => (hosts.length === 1 ? 600 : 230 + (i * 740) / (hosts.length - 1)));
  const hostLink = (id: string) => snap.links.find((l) => l.to === id);
  const wan = snap.links.find((l) => snap.nodes.find((n) => n.id === l.from)?.kind === 'internet');
  const plexHost = snap.services.find((s) => s.id === 'plex' || s.label === 'Plex')?.host;
  const plexBps = snap.plex.sessions.reduce((a, s) => a + s.bandwidthBps, 0);
  const sabHost = snap.vpn.host ?? hosts[0]?.id;
  const nasHost = hosts.find((h) => snap.nodes.find((n) => n.id === h.id)?.kind === 'nas')?.id;

  const curves = useMemo(() => {
    const m = new Map<string, Curve>();
    m.set('wan', vCurve({ x: NET.x, y: NET.y + 26 }, { x: ROUTER.x, y: ROUTER.y - 14 }));
    hosts.forEach((h, i) => m.set(h.id, vCurve({ x: ROUTER.x, y: ROUTER.y + 14 }, { x: xs[i], y: HOST_Y - 40 }, 0.6)));
    const pi = hosts.findIndex((h) => h.id === plexHost);
    if (pi >= 0) m.set('plex', { p0: { x: xs[pi] + 30, y: HOST_Y - 26 }, c1: { x: xs[pi] + 60, y: HOST_Y - 110 }, c2: { x: PLEX.x, y: PLEX.y + 90 }, p3: { x: PLEX.x, y: PLEX.y + 18 } });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts.map((h) => h.id).join('|'), plexHost]);
  const sampled = useMemo(() => new Map([...curves].map(([k, c]) => [k, sampleCurve(c, 40)])), [curves]);

  const streams = useMemo<Stream[]>(() => {
    const out: Stream[] = [];
    if (wan?.measured) {
      out.push({
        id: 'wan', path: sampled.get('wan')!, downBps: wan.downBps ?? 0, upBps: wan.upBps ?? 0, baseColor: MEDIUM_COLOR['10G'], scale: 1.25,
        mix: Object.entries(wan.mix).map(([p, w]) => ({ color: p === 'other' ? MEDIUM_COLOR['10G'] : PROTOCOL_COLOR[p as keyof typeof PROTOCOL_COLOR], weight: w ?? 0 })),
      });
    }
    for (const h of hosts) {
      const l = hostLink(h.id);
      if (!l?.measured || !sampled.has(h.id)) continue;
      out.push({
        id: h.id, path: sampled.get(h.id)!, downBps: l.downBps ?? 0, upBps: l.upBps ?? 0, baseColor: MEDIUM_COLOR[l.medium],
        mix: Object.entries(l.mix).map(([p, w]) => ({ color: p === 'other' ? MEDIUM_COLOR[l.medium] : PROTOCOL_COLOR[p as keyof typeof PROTOCOL_COLOR], weight: w ?? 0 })),
      });
    }
    if (plexBps > 0 && sampled.has('plex')) {
      out.push({ id: 'plex', path: sampled.get('plex')!, downBps: plexBps, upBps: 0, baseColor: PROTOCOL_COLOR.plex, mix: [{ color: PROTOCOL_COLOR.plex, weight: 1 }] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.links, sampled, plexBps]);

  const canvas = useRef<HTMLCanvasElement>(null);
  useParticles(canvas, W, H, streams);

  const sabX = xs[hosts.findIndex((h) => h.id === sabHost)];
  const nasX = xs[hosts.findIndex((h) => h.id === nasHost)];
  const sessions = snap.plex.sessions.length;
  const core = snap.nodes.find((n) => n.kind === 'switch' && snap.nodes.find((p) => p.id === n.parent)?.kind === 'router');

  return (
    <div>
      <div className="map-scroll">
        <div className="map-box" style={{ aspectRatio: `${W} / ${H}` }}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Lab schematic">
            <defs>
              <radialGradient id="hostOrb" cx="50%" cy="45%" r="55%">
                <stop offset="0" stopColor="#6ee7b7" />
                <stop offset="0.5" stopColor="#10b981" />
                <stop offset="1" stopColor="#064e3b" />
              </radialGradient>
              <radialGradient id="hostHalo" cx="50%" cy="50%" r="50%">
                <stop offset="0.55" stopColor="#10b981" stopOpacity="0.25" />
                <stop offset="1" stopColor="#10b981" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* decorative arc through the hosts */}
            <path d={`M150,${HOST_Y + 70} Q600,${HOST_Y - 190} 1050,${HOST_Y + 70}`} fill="none" stroke="#c7d2fe" strokeOpacity={0.08} strokeWidth={10} />
            {[...curves].map(([k, c]) => (
              <path key={k} d={curvePath(c)} fill="none" stroke={k === 'plex' ? PROTOCOL_COLOR.plex : '#cbd5e1'} strokeOpacity={k === 'plex' ? (plexBps ? 0.35 : 0.12) : 0.22} strokeWidth={k === 'wan' ? 4 : 2} strokeDasharray={k === 'plex' && !plexBps ? '2 5' : undefined} />
            ))}
            {sabX != null && nasX != null && sabHost !== nasHost && (
              <g>
                <path d={`M${sabX + 20},${HOST_Y + 34} Q${(sabX + nasX) / 2},${HOST_Y + 96} ${nasX - 20},${HOST_Y + 34}`} fill="none" stroke="#94a3b8" strokeOpacity={0.4} strokeDasharray="1.5 5" strokeWidth={1.6} strokeLinecap="round" />
              </g>
            )}

            {/* internet */}
            <circle cx={NET.x} cy={NET.y} r={30} fill="#10b981" opacity={0.18} />
            <circle cx={NET.x} cy={NET.y} r={18} fill="url(#hostOrb)" />
            <text className="svg-label" x={NET.x - 46} y={NET.y - 6} textAnchor="end" fontSize={17} fontWeight={700}>Internet</text>
            <text className="svg-sub" x={NET.x - 46} y={NET.y + 12} textAnchor="end" fontSize={11}>RTT {fmtMs(snap.internet.rttMs)} ms</text>
            <text className="svg-mono" x={NET.x + 44} y={NET.y - 4} fontSize={12.5} fill="#e8edf5">↓ {fmtBps(snap.internet.downBps)} ↑ {fmtBps(snap.internet.upBps)}</text>
            <text className="svg-sub" x={NET.x + 44} y={NET.y + 12} fontSize={10.5}>
              today {fmtGB(snap.internet.todayDownBytes)} ↓ {fmtGB(snap.internet.todayUpBytes)} ↑
            </text>

            {/* router */}
            <rect x={ROUTER.x - 12} y={ROUTER.y - 12} width={24} height={24} rx={3} transform={`rotate(45 ${ROUTER.x} ${ROUTER.y})`} fill="#34d399" />
            <text className="svg-sub" x={ROUTER.x - 26} y={ROUTER.y - 4} textAnchor="end" fontSize={11}>Router</text>
            <text className="svg-sub" x={ROUTER.x - 26} y={ROUTER.y + 10} textAnchor="end" fontSize={10}>{fmtMs(snap.internet.routerRttMs)} ms</text>
            {core && (
              <>
                <text className="svg-sub" x={ROUTER.x + 28} y={ROUTER.y - 4} fontSize={10}>{core.label}</text>
                {snap.links
                  .filter((l) => l.from === core.id)
                  .slice(0, 3)
                  .map((l, i) => (
                    <text key={l.id} className="svg-mono" x={ROUTER.x + 28} y={ROUTER.y + 10 + i * 12} fontSize={9} fill="#6b778c">
                      → {snap.nodes.find((n) => n.id === l.to)?.label}: ↓{fmtBps(l.downBps)} ↑{fmtBps(l.upBps)}
                    </text>
                  ))}
              </>
            )}

            {/* plex clients */}
            <circle cx={PLEX.x} cy={PLEX.y} r={16} fill={sessions ? PROTOCOL_COLOR.plex : '#334155'} opacity={sessions ? 0.9 : 0.6} />
            <text className="svg-label" x={PLEX.x} y={PLEX.y - 26} textAnchor="middle" fontSize={14} fontWeight={600}>Plex clients</text>
            <text className="svg-sub" x={PLEX.x} y={PLEX.y + 34} textAnchor="middle" fontSize={11}>
              {sessions ? `${sessions} streaming · ${fmtBps(plexBps)}` : 'nothing playing'}
            </text>

            {/* hosts */}
            {hosts.map((h, i) => {
              const x = xs[i];
              const l = hostLink(h.id);
              const r = 32;
              const circ = 2 * Math.PI * (r + 7);
              const cpu = h.cpuPct ?? 0;
              return (
                <g key={h.id}>
                  <circle cx={x} cy={HOST_Y} r={r + 22} fill="url(#hostHalo)" />
                  <circle cx={x} cy={HOST_Y} r={r + 7} fill="none" stroke="#1f2b42" strokeWidth={3} />
                  {h.cpuPct != null && (
                    <circle cx={x} cy={HOST_Y} r={r + 7} fill="none" stroke={cpu > 90 ? STATUS.critical : cpu > 70 ? STATUS.warning : '#60a5fa'} strokeWidth={3} strokeLinecap="round" strokeDasharray={`${(cpu / 100) * circ} ${circ}`} transform={`rotate(-90 ${x} ${HOST_Y})`} />
                  )}
                  <circle cx={x} cy={HOST_Y} r={r} fill={h.health === 'ok' ? 'url(#hostOrb)' : HEALTH_COLOR[h.health]} opacity={h.health === 'ok' ? 1 : 0.7} />
                  <circle cx={x} cy={HOST_Y} r={r * 0.45} fill="#d1fae5" opacity={0.18} />
                  <text className="svg-label" x={x} y={HOST_Y + r + 30} textAnchor="middle" fontSize={17} fontWeight={700}>{h.label}</text>
                  <text className="svg-sub" x={x} y={HOST_Y + r + 46} textAnchor="middle" fontSize={11}>
                    CPU {h.cpuPct == null ? '—' : `${Math.round(h.cpuPct)}%`}
                    {h.tempC != null ? ` · ${Math.round(h.tempC)}°` : ''}
                    {h.role ? ` · ${h.role}` : ''}
                  </text>
                  <text className="svg-mono" x={x} y={HOST_Y + r + 62} textAnchor="middle" fontSize={12} fill="#e8edf5">
                    ↓ {fmtBps(l?.downBps)} ↑ {fmtBps(l?.upBps)}
                  </text>
                </g>
              );
            })}
          </svg>
          <canvas ref={canvas} aria-hidden />
          {hosts.map((h, i) => (
            <HostChips key={h.id} snap={snap} hostId={h.id} x={xs[i]} />
          ))}
        </div>
      </div>
      <div className="legend" style={{ marginTop: 4 }}>
        <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.usenet }} />Usenet · SABnzbd</span>
        <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.torrent }} />Torrent · via VPN</span>
        <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.soulseek }} />Soulseek</span>
        <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.plex }} />Plex streams</span>
        <span className="k"><i className="sw" style={{ background: MEDIUM_COLOR['2.5G'] }} />Host uplink</span>
        <span className="k"><i className="line dotted" style={{ color: '#94a3b8' }} />NFS · logical link</span>
        <span className="k muted" style={{ marginLeft: 'auto' }}>particle density follows measured throughput</span>
      </div>
    </div>
  );
}

function fmtGB(b: number | null) {
  if (b == null) return '—';
  return b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`;
}

function HostChips({ snap, hostId, x }: { snap: Snapshot; hostId: string; x: number }) {
  const svcs = snap.services.filter((s) => s.host === hostId);
  const vpn = svcs.filter((s) => s.vpn);
  const plain = svcs.filter((s) => !s.vpn);
  const vols = snap.storage.filter((v) => v.host === hostId);
  if (!svcs.length && !vols.length) return null;
  const chip = (id: string, label: string, color: string) => (
    <span className="svc-chip" key={id}>
      <i className="sdot" style={{ background: color, width: 6, height: 6 }} />
      {label}
    </span>
  );
  const short = (l: string) => ({ ReadMeABook: 'RMAB', Audiobookshelf: 'ABS', qBittorrent: 'qBit', 'Calibre-Web': 'Cal-Web' })[l] ?? l;
  return (
    <div className="lab-chips" style={{ left: `${(x / W) * 100}%`, top: `${((HOST_Y + 112) / H) * 100}%` }}>
      {vpn.length > 0 && (
        <div className="ns-box">
          <div className="ns-title">
            Gluetun namespace ·{' '}
            <span style={{ color: snap.vpn.up ? '#4ade80' : snap.vpn.up === false ? '#f87171' : undefined }}>
              {snap.vpn.up ? 'VPN up' : snap.vpn.up === false ? 'VPN down' : 'VPN unknown'}
            </span>
          </div>
          <div className="ns-grid">{vpn.map((s) => chip(s.id, short(s.label), HEALTH_COLOR[s.health]))}</div>
        </div>
      )}
      {plain.length > 0 && (
        <div className="ns-box plain">
          {vpn.length > 0 && <div className="ns-title">Outside VPN</div>}
          <div className="ns-grid" style={{ gridTemplateColumns: `repeat(${Math.min(2, plain.length)}, auto)` }}>
            {plain.map((s) => chip(s.id, short(s.label), HEALTH_COLOR[s.health]))}
          </div>
        </div>
      )}
      {vols.length > 0 && (
        <div className="ns-grid" style={{ gridTemplateColumns: 'repeat(2, auto)' }}>
          {vols.map((v) => chip(v.id, v.label, HEALTH_COLOR[v.health]))}
        </div>
      )}
    </div>
  );
}
