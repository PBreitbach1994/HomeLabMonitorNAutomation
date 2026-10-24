import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot, TopoLink, TopoNode } from '../../../shared/model.ts';
import { PROTOCOL_LABEL, PROTOCOLS } from '../../../shared/model.ts';
import { HEALTH_COLOR, MEDIUM_COLOR, MEDIUM_WIDTH, PROTOCOL_COLOR } from '../lib/colors.ts';
import { fmtBps, fmtPct } from '../lib/format.ts';
import { curvePath, hCurve, offsetCurve, sampleCurve, vCurve, type Curve, type Pt } from '../lib/geometry.ts';
import { ParticleField, type Stream } from '../lib/particles.ts';

const W = 1200;
const LEAF_W = 188;
const LEAF_H = 38;
const SWITCH_W = 152;
const SWITCH_H = 44;

type Shape = 'globe' | 'diamond' | 'switch' | 'leaf' | 'orb';

interface Placed {
  node: TopoNode;
  x: number;
  y: number;
  shape: Shape;
}

interface Layout {
  H: number;
  placed: Map<string, Placed>;
  curves: Map<string, Curve>;
  wanCurve: Curve | null;
}

const isMesh = (n: TopoNode) => n.kind === 'mesh';

function shapeOf(n: TopoNode, isLeaf: boolean): Shape {
  if (n.kind === 'internet') return 'globe';
  if (n.kind === 'router') return 'diamond';
  if (n.kind === 'mesh') return 'orb';
  return isLeaf ? 'leaf' : 'switch';
}

function rightAnchor(p: Placed): Pt {
  switch (p.shape) {
    case 'globe': return { x: p.x + 20, y: p.y };
    case 'diamond': return { x: p.x + 15, y: p.y };
    case 'switch': return { x: p.x + SWITCH_W / 2, y: p.y };
    default: return { x: p.x + LEAF_W / 2, y: p.y };
  }
}

function leftAnchor(p: Placed): Pt {
  switch (p.shape) {
    case 'globe': return { x: p.x - 20, y: p.y };
    case 'diamond': return { x: p.x - 15, y: p.y };
    case 'switch': return { x: p.x - SWITCH_W / 2, y: p.y };
    case 'orb': return { x: p.x, y: p.y - 13 };
    default: return { x: p.x - LEAF_W / 2, y: p.y };
  }
}

/** Left→right tree: internal nodes in depth columns, every leaf in the right column, mesh along the bottom. */
export function layoutMap(nodes: TopoNode[]): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of nodes) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n.id]);
  const root = nodes.find((n) => n.kind === 'internet') ?? nodes[0];
  const wiredKids = (id: string) => (children.get(id) ?? []).filter((c) => !isMesh(byId.get(c)!));

  const leaves: string[] = [];
  const internal: { id: string; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    const kids = wiredKids(id);
    if (!kids.length && id !== root.id) leaves.push(id);
    else {
      internal.push({ id, depth });
      kids.forEach((k) => walk(k, depth + 1));
    }
  };
  walk(root.id, 0);
  const mesh = nodes.filter(isMesh);

  const top = 60;
  const gap = 50;
  const H = Math.max(560, top + leaves.length * gap + 30);
  const placed = new Map<string, Placed>();
  leaves.forEach((id, i) => {
    placed.set(id, { node: byId.get(id)!, x: 1000, y: top + i * gap + gap / 2, shape: 'leaf' });
  });

  const maxDepth = Math.max(1, ...internal.map((n) => n.depth));
  const colX = (d: number) => {
    if (d === 0) return 72;
    if (d === 1 || maxDepth === 1) return 215;
    return 215 + ((d - 1) * (700 - 215)) / (maxDepth - 1);
  };
  const yOf = (id: string): number => {
    const p = placed.get(id);
    if (p) return p.y;
    const kids = wiredKids(id);
    if (!kids.length) return H / 2;
    const ys = kids.map(yOf);
    return ys.reduce((a, b) => a + b, 0) / ys.length;
  };
  for (const { id, depth } of [...internal].sort((a, b) => b.depth - a.depth)) {
    const n = byId.get(id)!;
    placed.set(id, { node: n, x: colX(depth), y: yOf(id), shape: shapeOf(n, false) });
  }
  // Keep the internet + router comfortably above the mesh row.
  const meshY = H - 92;
  for (const p of placed.values()) if ((p.shape === 'globe' || p.shape === 'diamond') && p.y > meshY - 150) p.y = meshY - 150;

  mesh.forEach((n, i) => {
    const x = mesh.length === 1 ? 330 : 140 + (i * 470) / (mesh.length - 1);
    placed.set(n.id, { node: n, x, y: meshY, shape: 'orb' });
  });

  const curves = new Map<string, Curve>();
  let wanCurve: Curve | null = null;
  for (const n of nodes) {
    if (!n.parent || !n.linkId) continue;
    const a = placed.get(n.parent);
    const b = placed.get(n.id);
    if (!a || !b) continue;
    if (b.shape === 'orb') {
      curves.set(n.linkId, vCurve({ x: a.x, y: a.y + 15 }, leftAnchor(b), 0.55));
    } else {
      const c = hCurve(rightAnchor(a), leftAnchor(b), 0.5);
      curves.set(n.linkId, c);
      if (a.shape === 'globe') wanCurve = c;
    }
  }
  return { H, placed, curves, wanCurve };
}

const mixOf = (l: TopoLink) =>
  PROTOCOLS.filter((p) => (l.mix[p] ?? 0) > 0).map((p) => ({
    color: p === 'other' ? MEDIUM_COLOR[l.medium] : PROTOCOL_COLOR[p],
    weight: l.mix[p] ?? 0,
  }));

function linkTotal(l: TopoLink) {
  return (l.downBps ?? 0) + (l.upBps ?? 0);
}

export function useParticles(canvas: React.RefObject<HTMLCanvasElement | null>, width: number, height: number, streams: Stream[]) {
  const field = useRef<ParticleField | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const f = new ParticleField(canvas.current, width, height);
    field.current = f;
    f.start();
    return () => f.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    field.current?.setSize(width, height);
  }, [width, height]);
  useEffect(() => {
    field.current?.setStreams(streams);
  }, [streams]);
}

type TipTarget = { kind: 'link'; link: TopoLink } | { kind: 'node'; node: TopoNode };
type Tip = TipTarget & { x: number; y: number };

export function NetworkMap({ snap, onSelect }: { snap: Snapshot; onSelect?: (nodeId: string) => void }) {
  const structure = snap.nodes.map((n) => `${n.id}<${n.parent ?? ''}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutMap(snap.nodes), [structure]);
  const { H, placed, curves } = layout;
  const linkById = useMemo(() => new Map(snap.links.map((l) => [l.id, l])), [snap.links]);
  const childLinks = (id: string) => snap.links.filter((l) => l.from === id && placed.get(l.to)?.shape !== 'orb');

  const sampled = useMemo(() => new Map([...curves].map(([id, c]) => [id, sampleCurve(c)])), [curves]);
  const streams = useMemo<Stream[]>(
    () =>
      snap.links
        .filter((l) => sampled.has(l.id) && l.measured)
        .map((l) => ({
          id: l.id,
          path: sampled.get(l.id)!,
          downBps: l.downBps ?? 0,
          upBps: l.upBps ?? 0,
          mix: mixOf(l),
          baseColor: MEDIUM_COLOR[l.medium],
          scale: l.medium === '10G' ? 1.1 : l.medium === 'wifi' ? 0.8 : 0.95,
          faint: l.medium === 'wifi',
        })),
    [snap.links, sampled],
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  useParticles(canvas, W, H, streams);

  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const tipAt = (e: React.PointerEvent, t: TipTarget) => {
    const r = box.current!.getBoundingClientRect();
    setTip({ ...t, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const busiest = [...snap.links].filter((l) => l.measured).sort((a, b) => linkTotal(b) - linkTotal(a)).slice(0, 3);
  const label = (id: string) => snap.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <div>
      <div className="map-scroll">
        <div className="map-box" ref={box} style={{ aspectRatio: `${W} / ${H}` }} onPointerLeave={() => setTip(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Network map">
            <defs>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <radialGradient id="orb" cx="50%" cy="50%" r="50%">
                <stop offset="0" stopColor="#bfdbfe" />
                <stop offset="0.45" stopColor="#60a5fa" />
                <stop offset="1" stopColor="#1e3a8a" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* cables */}
            {snap.links.map((l) => {
              const c = curves.get(l.id);
              if (!c) return null;
              const d = curvePath(c);
              const color = MEDIUM_COLOR[l.medium];
              const w = MEDIUM_WIDTH[l.medium];
              const wifi = l.medium === 'wifi';
              const active = l.measured && linkTotal(l) > 5e3;
              return (
                <g key={l.id}>
                  {!wifi && active && <path d={d} stroke={color} strokeWidth={w * 3.2} opacity={0.08} fill="none" />}
                  <path
                    d={d}
                    fill="none"
                    stroke={l.bonded ? PROTOCOL_COLOR.soulseek : color}
                    strokeWidth={l.bonded ? 1.2 : w}
                    strokeOpacity={wifi ? 0.5 : active ? 0.55 : 0.25}
                    strokeDasharray={wifi ? '1.5 6' : l.bonded ? '3 4' : !l.measured ? '2 5' : undefined}
                    strokeLinecap="round"
                  />
                  <path
                    className="hit"
                    d={d}
                    stroke="transparent"
                    strokeWidth={14}
                    fill="none"
                    onPointerMove={(e) => tipAt(e, { kind: 'link', link: l })}
                    onPointerLeave={() => setTip(null)}
                  />
                </g>
              );
            })}

            {/* VPN tunnel rides along the WAN */}
            {layout.wanCurve && (
              <g>
                <path
                  d={curvePath(offsetCurve(layout.wanCurve, 0, 11))}
                  fill="none"
                  stroke={snap.vpn.up === false ? '#d03b3b' : MEDIUM_COLOR.vpn}
                  strokeWidth={2.4}
                  strokeOpacity={snap.vpn.up == null ? 0.25 : 0.7}
                  strokeDasharray="5 4"
                />
                <text
                  x={(layout.wanCurve.p0.x + layout.wanCurve.p3.x) / 2}
                  y={layout.wanCurve.p0.y + 30}
                  textAnchor="middle"
                  fontSize={10.5}
                  fill={snap.vpn.up === false ? '#f87171' : '#34d399'}
                  opacity={0.85}
                >
                  {snap.vpn.up === false ? 'VPN tunnel down' : snap.vpn.up ? 'Sealed VPN tunnel · Gluetun' : 'VPN · no data'}
                </text>
              </g>
            )}

            {/* trunk labels */}
            {snap.links.map((l) => {
              const c = curves.get(l.id);
              const a = placed.get(l.from);
              const b = placed.get(l.to);
              if (!c || !a || !b || b.shape === 'leaf' || b.shape === 'orb') return null;
              const mx = (c.p0.x + c.p3.x) / 2;
              const my = (c.p0.y + c.p3.y) / 2;
              const isWan = a.shape === 'globe';
              const text = l.measured
                ? `${isWan ? '' : `${l.medium}  `}↓${fmtBps(l.downBps)} ↑${fmtBps(l.upBps)}${isWan ? '' : ` · ${fmtPct(l.util)}`}`
                : `${l.medium} · no counters`;
              // Steep fan-out links get their label parked above the child card instead of mid-curve.
              const steep = Math.abs(c.p3.y - c.p0.y) > 60;
              return (
                <text
                  key={`lbl-${l.id}`}
                  className="svg-mono"
                  x={steep ? c.p3.x : mx}
                  y={steep ? c.p3.y - SWITCH_H / 2 - 8 : my - 9}
                  textAnchor={steep ? 'start' : 'middle'}
                  fontSize={10}
                  fill="#a5afc2"
                >
                  {text}
                </text>
              );
            })}

            {/* nodes */}
            {[...placed.values()].map((p) => (
              <NodeGlyph
                key={p.node.id}
                p={p}
                link={p.node.linkId ? linkById.get(p.node.linkId) : undefined}
                childLinks={p.shape === 'switch' ? childLinks(p.node.id) : []}
                onHover={(e) => tipAt(e, { kind: 'node', node: p.node })}
                onLeave={() => setTip(null)}
                onClick={() => onSelect?.(p.node.id)}
              />
            ))}
          </svg>
          <canvas ref={canvas} aria-hidden />
          {tip && <MapTip tip={tip} snap={snap} boxWidth={box.current?.clientWidth ?? 0} />}
        </div>
      </div>
      <div className="map-foot">
        <span>Busiest cables</span>
        {busiest.map((l) => (
          <span key={l.id}>
            {label(l.from)} → {label(l.to)} <b>{fmtBps(Math.max(l.downBps ?? 0, l.upBps ?? 0))}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function NodeGlyph({
  p,
  link,
  childLinks,
  onHover,
  onLeave,
  onClick,
}: {
  p: Placed;
  link?: TopoLink;
  childLinks: TopoLink[];
  onHover: (e: React.PointerEvent) => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const { node: n, x, y } = p;
  const health = HEALTH_COLOR[n.health];
  const handlers = { onPointerMove: onHover, onPointerLeave: onLeave, onClick, className: 'hit' };
  switch (p.shape) {
    case 'globe':
      return (
        <g {...handlers}>
          <text className="svg-sub" x={x} y={y - 46} textAnchor="middle" fontSize={9.5}>
            {n.sublabel}
          </text>
          <text className="svg-label" x={x} y={y - 31} textAnchor="middle" fontSize={12.5} fontWeight={600}>
            {n.label}
          </text>
          <circle cx={x} cy={y} r={22} fill="#0f2a2a" stroke="#2dd4bf" strokeOpacity={0.6} strokeWidth={1.4} filter="url(#glow)" />
          <g stroke="#5eead4" strokeOpacity={0.75} fill="none" strokeWidth={1}>
            <circle cx={x} cy={y} r={12} />
            <ellipse cx={x} cy={y} rx={5} ry={12} />
            <line x1={x - 12} x2={x + 12} y1={y} y2={y} />
            <path d={`M${x - 10},${y - 6} Q${x},${y - 3} ${x + 10},${y - 6} M${x - 10},${y + 6} Q${x},${y + 3} ${x + 10},${y + 6}`} />
          </g>
        </g>
      );
    case 'diamond':
      return (
        <g {...handlers}>
          <text className="svg-label" x={x} y={y - 38} textAnchor="middle" fontSize={12.5} fontWeight={600}>
            {n.label}
          </text>
          <text className="svg-sub" x={x} y={y - 25} textAnchor="middle" fontSize={9.5}>
            {n.sublabel}
          </text>
          <rect x={x - 11} y={y - 11} width={22} height={22} rx={3} transform={`rotate(45 ${x} ${y})`} fill={n.health === 'unknown' ? '#3b4a63' : '#34d399'} filter="url(#glow)" />
          <rect x={x - 5} y={y - 5} width={10} height={10} rx={1.5} transform={`rotate(45 ${x} ${y})`} fill="#d1fae5" opacity={0.8} />
        </g>
      );
    case 'switch': {
      const leds = childLinks.slice(0, 10);
      return (
        <g {...handlers}>
          <rect x={x - SWITCH_W / 2} y={y - SWITCH_H / 2} width={SWITCH_W} height={SWITCH_H} rx={7} fill="#141e31" stroke="#2a3854" />
          <text className="svg-label" x={x - SWITCH_W / 2 + 10} y={y - 6} fontSize={11} fontWeight={600}>
            {n.label}
          </text>
          {leds.map((l, i) => {
            const lit = l.measured && linkTotal(l) > 1e4;
            return (
              <rect
                key={l.id}
                x={x - SWITCH_W / 2 + 10 + i * 13}
                y={y + 6}
                width={9}
                height={4}
                rx={1.5}
                fill={lit ? (l.bonded ? PROTOCOL_COLOR.soulseek : MEDIUM_COLOR[l.medium]) : '#2a3549'}
                opacity={lit ? 0.95 : 1}
              />
            );
          })}
          <circle cx={x + SWITCH_W / 2 - 10} cy={y - 10} r={3} fill={health} />
        </g>
      );
    }
    case 'orb': {
      const clients = n.wifiClients;
      return (
        <g {...handlers}>
          <circle cx={x} cy={y} r={22} fill="url(#orb)" opacity={0.35} />
          <circle cx={x} cy={y} r={15} fill="none" stroke="#60a5fa" strokeOpacity={0.35} strokeDasharray="1.5 3.5" />
          <circle cx={x} cy={y} r={7} fill={n.health === 'crit' ? '#d03b3b' : '#60a5fa'} filter="url(#glow)" />
          <text className="svg-label" x={x} y={y + 38} textAnchor="middle" fontSize={11.5} fontWeight={600}>
            {n.label}
          </text>
          <text className="svg-sub" x={x} y={y + 51} textAnchor="middle" fontSize={9.5}>
            {n.sublabel}
            {clients != null ? ` · ${clients} on Wi-Fi` : ''}
          </text>
        </g>
      );
    }
    default: {
      const total = link?.measured ? linkTotal(link) : null;
      const left = x - LEAF_W / 2;
      return (
        <g {...handlers}>
          <rect x={left} y={y - LEAF_H / 2} width={LEAF_W} height={LEAF_H} rx={7} fill="#121b2c" stroke={total && total > 1e8 ? '#34507a' : '#24324b'} />
          <rect x={left + 9} y={y - 5} width={9} height={10} rx={2} fill="none" stroke="#7b879c" strokeWidth={1} />
          <circle cx={left + 13.5} cy={y} r={1.6} fill={health} />
          <text className="svg-label" x={left + 26} y={y - 3} fontSize={10.5} fontWeight={600}>
            {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
          </text>
          <text className="svg-sub" x={left + 26} y={y + 10} fontSize={8.5}>
            {n.sublabel}
          </text>
          {link && (
            <>
              <text x={left + LEAF_W - 9} y={y - 3} textAnchor="end" fontSize={9} fontWeight={700} fill={link.bonded ? PROTOCOL_COLOR.soulseek : MEDIUM_COLOR[link.medium]}>
                {link.medium === '100M' ? '<1G' : link.medium}
              </text>
              <text className="svg-mono" x={left + LEAF_W - 9} y={y + 10} textAnchor="end" fontSize={8.5} fill="#8b97ab">
                {total != null && total >= 1e5 ? fmtBps(total) : ''}
              </text>
            </>
          )}
        </g>
      );
    }
  }
}

function MapTip({ tip, snap, boxWidth }: { tip: Tip; snap: Snapshot; boxWidth: number }) {
  const label = (id: string) => snap.nodes.find((n) => n.id === id)?.label ?? id;
  const flip = tip.x > boxWidth - 300;
  const style = { left: tip.x + (flip ? -16 : 16), top: tip.y + 14, transform: flip ? 'translateX(-100%)' : undefined };
  if (tip.kind === 'link') {
    const l = tip.link;
    const mix = PROTOCOLS.filter((p) => (l.mix[p] ?? 0) > 1e3);
    return (
      <div className="map-tip" style={style}>
        <div className="t">
          {label(l.from)} → {label(l.to)}
        </div>
        <div className="r">
          <span>{l.port ?? 'Link'}</span>
          <b>
            {l.medium}
            {l.bonded ? ' · bond' : ''}
          </b>
        </div>
        {l.measured ? (
          <>
            <div className="r">
              <span>Down ↓</span>
              <b>{fmtBps(l.downBps)}</b>
            </div>
            <div className="r">
              <span>Up ↑</span>
              <b>{fmtBps(l.upBps)}</b>
            </div>
            <div className="r">
              <span>Utilization{l.approx ? ' (approx)' : ''}</span>
              <b>{fmtPct(l.util)}</b>
            </div>
            {mix.map((p) => (
              <div className="r" key={p}>
                <span>
                  <i className="key" style={{ background: p === 'other' ? MEDIUM_COLOR[l.medium] : PROTOCOL_COLOR[p] }} />
                  {PROTOCOL_LABEL[p]}
                </span>
                <b>{fmtBps(l.mix[p])}</b>
              </div>
            ))}
          </>
        ) : (
          <div className="r">
            <span>No counters for this link</span>
          </div>
        )}
      </div>
    );
  }
  const n = tip.node;
  return (
    <div className="map-tip" style={style}>
      <div className="t">{n.label}</div>
      {n.model && <div className="r"><span>{n.model}</span></div>}
      {n.ip && (
        <div className="r">
          <span>IP</span>
          <b>{n.ip}</b>
        </div>
      )}
      <div className="r">
        <span>Status</span>
        <b>{n.health === 'ok' ? 'Online' : n.health === 'unknown' ? 'No data' : n.health === 'crit' ? 'Down' : 'Warning'}</b>
      </div>
      {n.wifiClients != null && (
        <div className="r">
          <span>Wi-Fi clients</span>
          <b>{n.wifiClients}</b>
        </div>
      )}
      <div className="r">
        <span className="muted">Click for details</span>
      </div>
    </div>
  );
}
