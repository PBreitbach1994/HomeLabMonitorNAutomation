import { useEffect, useState } from 'react';
import type { Snapshot } from '../../../shared/model.ts';
import { MEDIUM_COLOR, PROTOCOL_COLOR } from '../lib/colors.ts';
import { LabLive } from './LabLive.tsx';
import { NetworkMap } from './NetworkMap.tsx';

const SLIDES = [
  { id: 'map', title: 'Network map', sub: 'Every cable, port and Wi-Fi client, with live traffic measured at the switch ports' },
  { id: 'lab', title: 'Lab · Live', sub: 'Schematic with measured traffic — particle density follows real throughput' },
] as const;

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
        <span className="hero-sub">{slide.sub}</span>
      </div>
      {slide.id === 'map' && (
        <div className="legend">
          {(['10G', '2.5G', '1G'] as const).map((m) => (
            <span className="k" key={m}><i className="line" style={{ background: MEDIUM_COLOR[m] }} />{m}</span>
          ))}
          <span className="k"><i className="line dashed" style={{ color: PROTOCOL_COLOR.soulseek }} />bonded</span>
          <span className="k"><i className="line dotted" style={{ color: MEDIUM_COLOR.wifi }} />Wi-Fi</span>
          <span className="k"><i className="line dashed" style={{ color: MEDIUM_COLOR.vpn }} />VPN tunnel</span>
          <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.usenet }} />Usenet</span>
          <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.torrent }} />Torrent</span>
          <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.soulseek }} />Soulseek</span>
          <span className="k"><i className="sw" style={{ background: PROTOCOL_COLOR.plex }} />Plex</span>
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        {slide.id === 'map' ? <NetworkMap snap={snap} onSelect={onSelect} /> : <LabLive snap={snap} />}
      </div>
    </section>
  );
}
