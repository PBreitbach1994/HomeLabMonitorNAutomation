import type { ReactNode } from 'react';
import type { Snapshot } from '../../../shared/model.ts';
import { Hero } from '../components/Hero.tsx';
import { Cameras, Hosts, Incidents, MediaPipeline, NetworkSummary, Services, Storage } from '../components/panels.tsx';

const MEDIA_SOURCES = new Set(['sabnzbd', 'qbittorrent', 'slskd', 'sonarr', 'radarr', 'lidarr', 'seerr', 'plex']);

export function Overview({ snap, now, kiosk, onSelect }: { snap: Snapshot; now: number; kiosk: boolean; onSelect: (id: string) => void }) {
  // Only panels something real (or the simulator) feeds; an empty storage or camera panel is noise.
  const panels: [string, ReactNode][] = [
    ['incidents', <Incidents snap={snap} now={now} />],
    ...(snap.hosts.length ? [['hosts', <Hosts snap={snap} />] as [string, ReactNode]] : []),
    ...(snap.services.length ? [['services', <Services snap={snap} />] as [string, ReactNode]] : []),
    ...(snap.storage.length ? [['storage', <Storage snap={snap} />] as [string, ReactNode]] : []),
    ...(snap.pipeline.length || snap.sources.some((s) => MEDIA_SOURCES.has(s.kind))
      ? [['pipeline', <MediaPipeline snap={snap} now={now} />] as [string, ReactNode]]
      : []),
    ...(snap.cameras.length ? [['cameras', <Cameras snap={snap} now={now} />] as [string, ReactNode]] : []),
  ];
  return (
    <div className="grid" style={{ gap: 'var(--gap)' }}>
      <Hero snap={snap} kiosk={kiosk} onSelect={onSelect} />
      <div className="grid two">
        {panels.map(([key, panel], i) => (
          // An odd one out takes the full row rather than leaving a hole.
          <div key={key} className={panels.length % 2 && i === panels.length - 1 ? 'span-2' : undefined} style={{ display: 'grid' }}>
            {panel}
          </div>
        ))}
        <div className="span-2">
          <NetworkSummary snap={snap} />
        </div>
      </div>
    </div>
  );
}
