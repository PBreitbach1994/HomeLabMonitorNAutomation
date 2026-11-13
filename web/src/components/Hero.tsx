import { useEffect, useState } from 'react';
import type { Snapshot } from '../../../shared/model.ts';
import type { Medium } from '../../../shared/model.ts';
import { MEDIUM_COLOR } from '../lib/colors.ts';
import { LabLive, ProtocolLegend } from './LabLive.tsx';
import { NetworkMap } from './NetworkMap.tsx';

const SLIDES = [
  { id: 'map', title: 'Network map' },
  { id: 'lab', title: 'Lab · Live' },
] as const;

const WIRED: Medium[] = ['100G', '40G', '25G', '10G', '5G', '2.5G', '1G', '100M'];

export function Hero({ snap, kiosk, onSelect }: { snap: Snapshot; kiosk: boolean; onSelect: (id: string) => void }) {
  const [idx, setIdx] = useState(() => {
    try {
      return Number(localStorage.getItem('hero') ?? 0) % SLIDES.length;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('hero', String(idx));
    } catch {
      /* storage unavailable */
    }
  }, [idx]);
  useEffect(() => {
    if (!kiosk) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % SLIDES.length), 30_000);
    return () => clearInterval(t);
  }, [kiosk]);
  const slide = SLIDES[idx];
  const sub =
    slide.id === 'map'
      ? `Every device and cable${snap.lab.topologySource === 'netbox' ? ' from NetBox' : ''}, with traffic measured at the switch ports`
      : 'Hosts and their services — particle density follows measured throughput';
  const media = WIRED.filter((m) => snap.links.some((l) => l.medium === m));
  const hasVpn = snap.vpn.up != null || snap.services.some((s) => s.vpn);

  return (
    <section className="panel hero">
      <div className="hero-head">
        <h2 className="panel-title" style={{ margin: 0 }}>{slide.title}</h2>
        <div className="hero-dots" role="tablist" aria-label="Hero views">
          {SLIDES.map((s, i) => (
            <button key={s.id} role="tab" aria-selected={i === idx} aria-label={s.title} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>
              <span />
            </button>
          ))}
        </div>
        <span className="hero-sub">{sub}</span>
      </div>
      {slide.id === 'map' && (
        <div className="legend">
          {media.map((m) => (
            <span className="k" key={m}><i className="line" style={{ background: MEDIUM_COLOR[m] }} />{m === '100M' ? '≤100M' : m}</span>
          ))}
          {snap.links.some((l) => l.bonded) && <span className="k"><i className="line bond" style={{ color: MEDIUM_COLOR['2.5G'] }} />bonded</span>}
          {snap.links.some((l) => l.medium === 'wifi') && <span className="k"><i className="line dotted" style={{ color: MEDIUM_COLOR.wifi }} />Wi-Fi</span>}
          {hasVpn && <span className="k"><i className="line dashed" style={{ color: MEDIUM_COLOR.vpn }} />VPN tunnel</span>}
          <ProtocolLegend snap={snap} />
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        {slide.id === 'map' ? <NetworkMap snap={snap} onSelect={onSelect} /> : <LabLive snap={snap} />}
      </div>
    </section>
  );
}
