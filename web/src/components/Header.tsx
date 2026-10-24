import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../shared/model.ts';
import { HEALTH_COLOR } from '../lib/colors.ts';
import type { ConnStatus } from '../lib/data.ts';
import { fmtAgo, fmtBps } from '../lib/format.ts';

export function Header({
  snap,
  status,
  lastAt,
  now,
  route,
  go,
  kiosk,
  setKiosk,
  sourceKind,
}: {
  snap: Snapshot;
  status: ConnStatus;
  lastAt: number | null;
  now: number;
  route: string;
  go: (r: string) => void;
  kiosk: boolean;
  setKiosk: (v: boolean) => void;
  sourceKind: 'server' | 'browser-demo';
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menu.current && !menu.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const d = new Date(now);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const [hm, ampm] = time.split(' ');
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const stale = lastAt != null && now - lastAt > 10_000;
  const liveColor = status === 'live' && !stale ? '#4ade80' : status === 'offline' ? '#f87171' : '#fab219';
  const liveText = status === 'live' && !stale ? `Live · ${fmtAgo(lastAt, now)}` : status === 'offline' ? 'Offline' : `Reconnecting · ${fmtAgo(lastAt, now)}`;
  const failing = snap.sources.filter((s) => !s.ok);

  return (
    <>
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden />
          <span className="brand-name">{snap.lab.name.toUpperCase()}</span>
        </div>
        {snap.attention > 0 ? (
          <button className="pill attention" onClick={() => go('overview')} title="Open incidents that need you">
            {snap.attention} attention
          </button>
        ) : (
          <span className="pill clear">All clear</span>
        )}
        {snap.mode !== 'live' && (
          <span className="pill demo" title={sourceKind === 'browser-demo' ? 'Simulated in your browser' : 'Simulator is feeding some or all panels'}>
            {snap.mode === 'demo' ? 'DEMO DATA' : 'PARTLY SIMULATED'}
          </span>
        )}
        <div className="live">
          <span>
            <i className="dot" style={{ background: liveColor, boxShadow: `0 0 6px ${liveColor}` }} />
            {liveText}
          </span>
          <span>{date}</span>
        </div>
        <div className="clock" aria-label="Current time">
          {hm}
          {ampm && <small>{ampm}</small>}
        </div>
        <div className="header-spacer" />
        <nav className="nav" aria-label="Views">
          <button className={route === 'overview' ? 'on' : ''} onClick={() => go('overview')}>Overview</button>
          <button className={route === 'network' ? 'on' : ''} onClick={() => go('network')}>Network</button>
        </nav>
        <div className="menu" ref={menu}>
          <button className="menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
          {open && (
            <div className="menu-list" role="menu">
              <button role="menuitem" onClick={() => { setKiosk(!kiosk); setOpen(false); }}>
                Kiosk mode <span className="muted">{kiosk ? 'on' : 'off'}</span>
              </button>
              <button role="menuitem" onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}>Full screen</button>
              <div className="sep" />
              <div className="muted" style={{ padding: '4px 10px' }}>Sources</div>
              {snap.sources.map((s) => (
                <div key={s.id} className="muted" style={{ padding: '3px 10px', display: 'flex', gap: 8, alignItems: 'center' }} title={s.error}>
                  <i className="sdot" style={{ background: s.ok ? HEALTH_COLOR.ok : HEALTH_COLOR.crit }} />
                  <span style={{ color: 'var(--text-1)' }}>{s.id}</span>
                  <span style={{ marginLeft: 'auto' }}>{s.ok ? fmtAgo(s.lastOk, now) : 'failing'}</span>
                </div>
              ))}
              {failing.length > 0 && <div className="muted" style={{ padding: '4px 10px' }}>{failing.length} failing — hover for the error</div>}
            </div>
          )}
        </div>
      </header>
      <div className="strip">
        {snap.hosts.map((h) => (
          <span className="host" key={h.id}>
            <i className="sdot glow" style={{ background: HEALTH_COLOR[h.health], color: HEALTH_COLOR[h.health] }} />
            {h.label}
          </span>
        ))}
        <span className={`chip ${snap.vpn.up == null ? 'unknown' : snap.vpn.up ? 'ok' : 'bad'}`}>
          {snap.vpn.up == null ? '? VPN' : snap.vpn.up ? '✓ VPN up' : '✕ VPN down'}
        </span>
        <span className="muted num">
          LAN ↓ {fmtBps(snap.traffic.lanDownBps)} ↑ {fmtBps(snap.traffic.lanUpBps)}
        </span>
      </div>
    </>
  );
}
