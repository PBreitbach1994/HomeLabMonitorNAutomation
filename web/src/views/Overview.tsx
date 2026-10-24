import type { Snapshot } from '../../../shared/model.ts';
import { Hero } from '../components/Hero.tsx';
import { Cameras, Hosts, Incidents, MediaPipeline, NetworkSummary, Services, Storage } from '../components/panels.tsx';

export function Overview({ snap, now, kiosk, onSelect }: { snap: Snapshot; now: number; kiosk: boolean; onSelect: (id: string) => void }) {
  return (
    <div className="grid" style={{ gap: 'var(--gap)' }}>
      <Hero snap={snap} kiosk={kiosk} onSelect={onSelect} />
      <div className="grid two">
        <MediaPipeline snap={snap} now={now} />
        <Hosts snap={snap} />
        <Services snap={snap} />
        <Storage snap={snap} />
        <Incidents snap={snap} now={now} />
        <Cameras snap={snap} now={now} />
        <div className="span-2">
          <NetworkSummary snap={snap} />
        </div>
      </div>
    </div>
  );
}
