// Shapes the server streams to the UI. Every live metric is `number | null`:
// null means "no evidence", and the UI renders it as an em dash.

export type Health = 'ok' | 'warn' | 'crit' | 'unknown' | 'off';
export type Medium = '10G' | '2.5G' | '1G' | '100M' | 'wifi' | 'vpn' | 'logical';
export type NodeKind =
  | 'internet' | 'router' | 'switch' | 'mesh' | 'host' | 'nas'
  | 'device' | 'laptop' | 'printer' | 'dock' | 'hub';
export type Protocol = 'usenet' | 'torrent' | 'soulseek' | 'plex' | 'other';

export const PROTOCOLS: Protocol[] = ['usenet', 'torrent', 'soulseek', 'plex', 'other'];
export const PROTOCOL_LABEL: Record<Protocol, string> = {
  usenet: 'Usenet',
  torrent: 'Torrent',
  soulseek: 'Soulseek',
  plex: 'Plex',
  other: 'Other',
};

export interface TopoNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: NodeKind;
  parent?: string;
  linkId?: string;
  health: Health;
  ip?: string;
  model?: string;
  location?: string;
  wifiClients?: number | null;
  tag?: string; // e.g. VOL / APP badge on the Network page
}

export interface TopoLink {
  id: string;
  from: string; // upstream node
  to: string; // downstream node
  medium: Medium;
  bonded?: boolean;
  speedBps: number;
  measured: boolean;
  approx?: boolean;
  downBps: number | null; // toward `to`
  upBps: number | null; // toward `from`
  util: number | null; // 0..1
  mix: Partial<Record<Protocol, number>>; // bps by protocol, both directions
  history: number[]; // total bps, 10s steps, oldest first
  port?: string;
}

export interface InternetState {
  provider: string;
  health: Health;
  downBps: number | null;
  upBps: number | null;
  avgDownBps: number | null;
  avgUpBps: number | null;
  rttMs: number | null;
  routerRttMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  rttHistory: number[];
  downHistory: number[];
  upHistory: number[];
  todayDownBytes: number | null;
  todayUpBytes: number | null;
}

export interface HostState {
  id: string;
  label: string;
  role?: string;
  health: Health;
  cpuPct: number | null;
  memPct: number | null;
  tempC: number | null;
  uptimeS: number | null;
  cpuHistory: number[];
}

export type ServiceRunState = 'running' | 'stopped' | 'paused' | 'manual' | 'degraded' | 'unknown';

export interface ServiceState {
  id: string;
  label: string;
  host: string;
  health: Health;
  state: ServiceRunState;
  vpn: boolean;
  note?: string;
  url?: string;
}

export interface DiskState {
  id: string;
  slot: string;
  model: string;
  health: Health;
  tempC: number | null;
  ssd?: boolean;
}

export interface VolumeState {
  id: string;
  label: string;
  host: string;
  enclosure?: string;
  usedBytes: number | null;
  totalBytes: number | null;
  health: Health;
  note?: string;
  disks: DiskState[];
}

export type StageKey = 'requested' | 'grabbed' | 'downloading' | 'downloaded' | 'imported' | 'available';
export const STAGES: StageKey[] = ['requested', 'grabbed', 'downloading', 'downloaded', 'imported', 'available'];
export const STAGE_LABEL: Record<StageKey, string> = {
  requested: 'Requested',
  grabbed: 'Grabbed',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  imported: 'Imported',
  available: 'In Plex',
};
export type Evidence = 'verified' | 'inferred' | 'none' | 'active' | 'failed' | 'blocked';

export interface PipelineItem {
  id: string; // downloadId
  title: string;
  mediaKey?: string;
  kind: 'tv' | 'movie' | 'music' | 'book' | 'other';
  client: string;
  status: string; // human status, e.g. "Downloading", "Downloading failed"
  progress: number | null; // 0..1 while downloading
  updatedAt: number;
  current: StageKey;
  stages: Record<StageKey, Evidence>;
}

export type Severity = 'info' | 'warning' | 'critical';

export interface Incident {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  source: string;
  openedAt: number;
  resolvedAt: number | null;
  state: 'open' | 'recovered';
}

export interface CameraEvent {
  id: string;
  camera: string;
  kind: 'motion' | 'person' | 'vehicle' | 'pet' | 'doorbell';
  ts: number;
}

export interface VpnState {
  health: Health;
  up: boolean | null;
  provider: string | null;
  publicIp: string | null;
  country: string | null;
  host: string | null;
  throughputBps: number | null;
  services: string[]; // service ids routed through the tunnel
}

export interface WifiState {
  nodesOnline: number | null;
  nodesTotal: number;
  devices: number | null;
  wired: number | null;
  updateAvailable: boolean;
}

export interface PlexSession {
  id: string;
  title: string;
  user: string;
  player: string;
  bandwidthBps: number;
  local: boolean;
}

export interface BusyFlow {
  node: string; // node id
  protocol: Protocol;
  bps: number;
}

export interface TrafficState {
  lanBps: number | null; // total switched throughput through the core
  lanDownBps: number | null;
  lanUpBps: number | null;
  lanHistory: number[];
  activeDevices: number | null;
  wifiGroups: number;
  topProtocol: Protocol | null;
  topProtocolShare: number | null;
  byProtocol: Record<Protocol, number[]>; // 30s steps, last hour
  protocolNow: Record<Protocol, number>;
  busiest: BusyFlow[];
}

export interface SourceState {
  id: string;
  kind: string;
  ok: boolean;
  lastOk: number | null;
  error?: string;
}

export interface Snapshot {
  rev: number;
  ts: number;
  mode: 'demo' | 'live' | 'mixed';
  lab: { name: string };
  attention: number;
  nodes: TopoNode[];
  links: TopoLink[];
  internet: InternetState;
  hosts: HostState[];
  services: ServiceState[];
  storage: VolumeState[];
  pipeline: PipelineItem[];
  pipelineTracked: number;
  incidents: Incident[];
  cameras: CameraEvent[];
  vpn: VpnState;
  tailscale: { up: boolean | null; peersOnline: number | null };
  wifi: WifiState;
  plex: { sessions: PlexSession[] };
  traffic: TrafficState;
  sources: SourceState[];
}

export interface HistoryResponse {
  key: string;
  stepMs: number;
  end: number;
  points: (number | null)[];
}
