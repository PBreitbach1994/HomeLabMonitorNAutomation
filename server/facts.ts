// Facts are what collectors observe, kept close to the source's own shape.
// Collectors (and the simulator) only ever write here; derivations in ./derive turn
// facts into the Snapshot the UI renders.

import type { CameraEvent, Health, PlexSession, Protocol } from '../shared/model.ts';

export type Domain =
  | 'ifaces' | 'hosts' | 'containers' | 'http' | 'downloads' | 'arr' | 'requests'
  | 'plex' | 'vpn' | 'tailscale' | 'ping' | 'storage' | 'wifi' | 'cameras';

export interface IfaceSample {
  inOctets: number;
  outOctets: number;
  speedBps?: number;
  up?: boolean;
}

export interface IfaceFact extends IfaceSample {
  at: number;
  inBps: number | null;
  outBps: number | null;
}

export interface HostFact {
  cpuPct: number | null;
  memPct: number | null;
  tempC: number | null;
  uptimeS: number | null;
  at: number;
}

export type ContainerState = 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | 'unknown';

export interface ContainerFact {
  name: string;
  host?: string;
  state: ContainerState;
  health?: 'healthy' | 'unhealthy' | 'starting' | null;
  at: number;
}

export interface HttpCheckFact {
  up: boolean;
  status?: number;
  latencyMs?: number;
  at: number;
}

export type DownloadStatus =
  | 'queued' | 'downloading' | 'paused' | 'verifying' | 'extracting' | 'completed' | 'failed';

export interface DownloadItemFact {
  id: string; // SABnzbd nzo_id / qBittorrent hash (upper-case) / slskd id — the *arr `downloadId`
  name: string;
  status: DownloadStatus;
  progress: number | null; // 0..1
  sizeBytes?: number;
  speedBps?: number;
  category?: string;
  updatedAt: number;
  message?: string;
}

export interface DownloadClientFact {
  client: string; // sabnzbd | qbittorrent | slskd
  protocol: Protocol;
  host?: string; // node id the client runs on (for attribution)
  downBps: number;
  upBps: number;
  paused?: boolean;
  queue: DownloadItemFact[];
  history: DownloadItemFact[];
  at: number;
}

export type MediaKind = 'tv' | 'movie' | 'music' | 'book' | 'other';

export interface ArrEventFact {
  downloadId: string;
  eventType: 'grabbed' | 'imported' | 'failed' | 'deleted' | 'ignored';
  title: string; // release / source title
  mediaKey?: string; // tv:tvdb:<id>:s01e02 | movie:tmdb:<id> | music:mb:<id>
  kind: MediaKind;
  date: number;
  message?: string;
}

export interface ArrQueueFact {
  downloadId: string;
  title: string;
  mediaKey?: string;
  kind: MediaKind;
  status: string; // queued | downloading | completed | ...
  trackedState?: string; // downloading | importPending | importBlocked | importing | failedPending
  trackedStatus?: string; // ok | warning | error
  messages: string[];
}

export interface ArrHealthFact {
  type: 'ok' | 'notice' | 'warning' | 'error';
  message: string;
  source?: string;
}

export interface ArrFact {
  app: string; // sonarr | radarr | lidarr
  label: string;
  queue: ArrQueueFact[];
  history: ArrEventFact[];
  health: ArrHealthFact[];
  at: number;
}

export interface RequestFact {
  mediaKey: string;
  title: string;
  requestedAt: number;
  status: string;
}

export interface PlexSessionFact extends PlexSession {
  nodeId?: string; // topology node the player sits behind ('internet' for remote)
}

export interface PlexFact {
  host?: string;
  sessions: PlexSessionFact[];
  recentlyAdded: { mediaKey: string; title: string; addedAt: number }[];
  at: number;
}

export interface VpnFact {
  up: boolean;
  host?: string;
  provider?: string;
  publicIp?: string;
  country?: string;
  at: number;
}

export interface PingFact {
  target: string;
  rttMs: number | null;
  jitterMs: number | null;
  lossPct: number;
  at: number;
}

export interface DiskFact {
  id: string;
  slot: string;
  model: string;
  health: Health;
  tempC: number | null;
  ssd?: boolean;
  note?: string;
}

export interface VolumeFact {
  id: string;
  label: string;
  host: string;
  enclosure?: string;
  usedBytes: number;
  totalBytes: number;
  health: Health;
  disks: DiskFact[];
  at: number;
}

export interface EnclosureFact {
  id: string;
  label: string;
  health: Health;
  note?: string;
  at: number;
}

export interface MeshNodeFact {
  nodeId: string;
  online: boolean;
  clients: number;
  at: number;
}

export interface WifiFact {
  devices: number | null;
  wired: number | null;
  updateAvailable: boolean;
  routerClients: number | null;
  at: number;
}

export interface TailscaleFact {
  up: boolean;
  peersOnline: number;
  at: number;
}

export interface SourceFact {
  id: string;
  kind: string;
  ok: boolean;
  lastOk: number | null;
  lastError?: string;
  domains: Domain[];
}

const EWMA_ALPHA = 0.5;

export class FactStore {
  ifaces = new Map<string, IfaceFact>();
  hosts = new Map<string, HostFact>();
  containers = new Map<string, ContainerFact>(); // key: container name
  http = new Map<string, HttpCheckFact>(); // key: service id
  downloads = new Map<string, DownloadClientFact>(); // key: client id
  arr = new Map<string, ArrFact>(); // key: collector id
  requests: RequestFact[] = [];
  plex: PlexFact | null = null;
  vpn: VpnFact | null = null;
  tailscale: TailscaleFact | null = null;
  ping = new Map<string, PingFact>(); // key: 'internet' | 'router' | ...
  volumes = new Map<string, VolumeFact>();
  enclosures = new Map<string, EnclosureFact>();
  mesh = new Map<string, MeshNodeFact>();
  wifi: WifiFact | null = null;
  cameras: CameraEvent[] = [];
  sources = new Map<string, SourceFact>();
  /** Seed for today's WAN byte totals (e.g. from eero usage or the simulator). */
  wanToday: { downBytes: number; upBytes: number; at: number } | null = null;

  /**
   * Records an interface counter sample and derives rates from the previous one.
   * Negative deltas (counter reset / 32-bit wrap) drop that interval rather than spiking.
   */
  setIface(key: string, sample: IfaceSample, at = Date.now()): void {
    const prev = this.ifaces.get(key);
    let inBps = prev?.inBps ?? null;
    let outBps = prev?.outBps ?? null;
    if (prev) {
      const dt = (at - prev.at) / 1000;
      if (dt < 0.2) return;
      const dIn = sample.inOctets - prev.inOctets;
      const dOut = sample.outOctets - prev.outOctets;
      if (dIn >= 0 && dOut >= 0) {
        const rIn = (dIn * 8) / dt;
        const rOut = (dOut * 8) / dt;
        inBps = inBps == null ? rIn : inBps + EWMA_ALPHA * (rIn - inBps);
        outBps = outBps == null ? rOut : outBps + EWMA_ALPHA * (rOut - outBps);
      } else {
        inBps = null;
        outBps = null;
      }
    }
    this.ifaces.set(key, { ...sample, at, inBps, outBps });
  }

  registerSource(id: string, kind: string, domains: Domain[]): void {
    this.sources.set(id, { id, kind, ok: false, lastOk: null, domains });
  }

  sourceOk(id: string, at = Date.now()): void {
    const s = this.sources.get(id);
    if (s) Object.assign(s, { ok: true, lastOk: at, lastError: undefined });
  }

  sourceError(id: string, error: string): void {
    const s = this.sources.get(id);
    if (s) Object.assign(s, { ok: false, lastError: error });
  }

  addCameraEvent(e: CameraEvent): void {
    this.cameras = [e, ...this.cameras.filter((c) => c.id !== e.id)].slice(0, 50);
  }
}
