// Topology-aware simulator. It never writes UI values: it runs synthetic app activity
// (Usenet grabs, imports, Plex streams, background traffic), routes the resulting flows
// over the configured topology, and increments port counters — the same facts SNMP,
// SABnzbd, Sonarr, Plex… would produce. Everything downstream is the real derivation code.

import type { CollectorConfig, LabConfig, NodeConfig } from '../config.ts';
import type {
  ArrEventFact, ArrQueueFact, DiskFact, Domain, DownloadItemFact, FactStore, PlexSessionFact,
} from '../facts.ts';
import { buildTopology, pathBetween, simKeyFor, type Topology } from '../derive/topology.ts';
import type { Collector, CollectorContext } from './types.ts';

const MBPS = 1e6;
const GB = 1e9;

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean-reverting random walks so signals wander smoothly instead of jumping. */
class Walks {
  private x = new Map<string, number>();
  constructor(private rnd: () => number) {}
  gauss(): number {
    const u = 1 - this.rnd();
    const v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  walk(name: string, mean: number, sd: number, dt: number, theta = 0.15, min = 0, max = Infinity): number {
    const cur = this.x.get(name) ?? mean;
    const next = cur + theta * (mean - cur) * dt + sd * Math.sqrt(Math.max(dt, 0.01)) * this.gauss();
    const clamped = Math.min(max, Math.max(min, next));
    this.x.set(name, clamped);
    return clamped;
  }
}

type JobState = 'queued' | 'downloading' | 'extracting' | 'completed' | 'failed' | 'imported' | 'available';

interface Job {
  id: string;
  title: string;
  kind: 'tv' | 'movie';
  mediaKey: string;
  client: 'sabnzbd' | 'qbittorrent';
  arr: 'sonarr' | 'radarr';
  size: number;
  done: number;
  state: JobState;
  failAt: number | null; // fraction of size at which it fails
  stuck: boolean; // completes but import is blocked
  grabbedAt: number;
  updatedAt: number;
  nextAt: number; // time of the next timed transition
}

interface Media {
  key: string;
  name: string;
  kind: 'tv' | 'movie';
  requested: boolean;
}

const SHOWS = [
  { name: 'Harbor.Lights', tvdb: 412001 },
  { name: 'The.Quiet.Orbit', tvdb: 412002 },
  { name: 'Copper.Valley', tvdb: 412003 },
  { name: 'Night.Shift.Diner', tvdb: 412004 },
  { name: 'Signal.and.Noise', tvdb: 412005 },
  { name: 'Paper.Moons', tvdb: 412006 },
  { name: 'Glass.Atlas', tvdb: 412007 },
  { name: 'The.Long.Field', tvdb: 412008 },
];
const MOVIES = [
  { name: 'Northbound.2024', tmdb: 900101 },
  { name: 'The.Cartographer.2023', tmdb: 900102 },
  { name: 'Low.Tide.2025', tmdb: 900103 },
  { name: 'Eleven.Bridges.2022', tmdb: 900104 },
  { name: 'Saltwater.Static.2024', tmdb: 900105 },
];
const GROUPS = ['NOVA', 'KESTREL', 'LUMEN', 'TIDE', 'ORBIT', 'FERN'];
const TV_FORMATS = ['1080p.WEB-DL.DDP5.1.H.264', '1080p.WEBRip.10bit.DDP5.1.x265', '2160p.WEB-DL.DV.HDR.DDP5.1.H.265'];
const MOVIE_FORMATS = ['1080p.BluRay.DDP5.1.x265', '2160p.UHD.BluRay.REMUX.DV.HDR.TrueHD.7.1', '1080p.WEB-DL.DDP5.1.H.264'];
const CAMERAS = ['Front Door', 'Driveway', 'Back Yard', 'Garage'];

export interface SimOptions {
  seed?: number;
}

export class Simulator implements Collector {
  readonly kind = 'simulator';
  readonly intervalMs: number;
  readonly domains: Domain[] = [
    'ifaces', 'hosts', 'containers', 'downloads', 'arr', 'requests', 'plex', 'vpn', 'tailscale',
    'ping', 'storage', 'wifi', 'cameras',
  ];

  private rnd: () => number;
  private w: Walks;
  private topo: Topology;
  private facts: FactStore;
  private lab: LabConfig;
  private skip: Set<Domain>;
  private last = 0;
  private started = 0;
  private counters = new Map<string, { down: number; up: number }>();
  private jobs: Job[] = [];
  private media: Media[] = [];
  private arrEvents: Record<'sonarr' | 'radarr', ArrEventFact[]> = { sonarr: [], radarr: [] };
  private nextGrabAt = 0;
  private regrabs: { mediaKey: string; at: number }[] = [];
  private spawned = 0;
  private sessions: (PlexSessionFact & { endsAt: number })[] = [];
  private nextSessionAt = 0;
  private outage: { service: string; until: number } | null = null;
  private nextOutageAt = 0;
  private nextCameraAt = 0;
  private burst = new Map<string, { until: number; bps: number }>();
  private dataUsed = 0;
  private bootAt: Record<string, number> = {};

  // Where things run, resolved from config (null when the lab has no such app).
  private sabHost: string | null;
  private qbitHost: string | null;
  private slskdHost: string | null;
  private plexHost: string | null;
  private nasHost: string | null;
  private hasRadarr: boolean;
  private wanDownBps: number;
  private wanUpBps: number;
  private wanScale = 1;

  constructor(
    readonly id: string,
    ctx: CollectorContext,
    opts: SimOptions & { intervalMs?: number; wanDownMbps?: number; wanUpMbps?: number } = {},
  ) {
    this.wanDownBps = (opts.wanDownMbps ?? 940) * MBPS;
    this.wanUpBps = (opts.wanUpMbps ?? 35) * MBPS;
    this.lab = ctx.lab;
    this.facts = ctx.facts;
    this.skip = new Set(ctx.covered);
    this.intervalMs = opts.intervalMs ?? 1000;
    this.rnd = mulberry32(opts.seed ?? Date.now());
    this.w = new Walks(this.rnd);
    this.topo = buildTopology(ctx.lab);
    const hostOf = (app: string) => this.lab.services.find((s) => s.app === app || s.id === app)?.host ?? null;
    this.sabHost = hostOf('sabnzbd');
    this.qbitHost = hostOf('qbittorrent');
    this.slskdHost = hostOf('slskd');
    this.plexHost = hostOf('plex');
    this.nasHost = this.lab.topology.nodes.find((n) => n.kind === 'nas')?.id ?? this.plexHost;
    this.hasRadarr = this.lab.services.some((s) => s.app === 'radarr' || s.id === 'radarr');
  }

  private chance(perSecond: number, dt: number): boolean {
    return this.rnd() < 1 - Math.exp(-perSecond * dt);
  }
  private between(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }
  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rnd() * xs.length)];
  }
  private hex(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(this.rnd() * 16).toString(16);
    return s;
  }
  private on(d: Domain): boolean {
    return !this.skip.has(d);
  }

  async poll(now: number): Promise<void> {
    this.tick(now);
  }

  tick(now: number): void {
    if (!this.started) this.init(now);
    const dt = this.last ? Math.min(15, Math.max(0, (now - this.last) / 1000)) : 1;
    this.last = now;

    this.stepJobs(now);
    this.stepSessions(now);
    this.stepOutage(now);

    const sabActive = this.jobs.some((j) => j.client === 'sabnzbd' && j.state === 'downloading');
    const extracting = this.jobs.some((j) => j.state === 'extracting');
    const sabBps = sabActive ? this.w.walk('sab', 835 * MBPS, 35 * MBPS, dt, 0.3, 600 * MBPS, 900 * MBPS) : 0;
    const torrentActive = this.jobs.some((j) => j.client === 'qbittorrent' && j.state === 'downloading');
    const qbitDown = this.qbitHost ? (torrentActive ? this.w.walk('qbit-dn', 28 * MBPS, 8 * MBPS, dt, 0.2, 2 * MBPS) : this.w.walk('qbit-idle', 0.3 * MBPS, 0.2 * MBPS, dt, 0.3, 0)) : 0;
    const qbitUp = this.qbitHost ? this.w.walk('qbit-up', 3 * MBPS, 1.5 * MBPS, dt, 0.2, 0.2 * MBPS) : 0;
    const slskDown = this.slskdHost ? this.w.walk('slsk-dn', 0.4 * MBPS, 0.25 * MBPS, dt, 0.3, 0) : 0;
    const slskUp = this.slskdHost ? this.w.walk('slsk-up', 0.6 * MBPS, 0.3 * MBPS, dt, 0.3, 0.05 * MBPS) : 0;

    if (this.on('ifaces')) this.writeTraffic(now, dt, { sabBps, extracting, qbitDown, qbitUp, slskDown, slskUp });
    this.advanceDownloads(now, dt, sabBps * this.wanScale, qbitDown * this.wanScale);

    const k = this.wanScale;
    if (this.on('downloads')) this.writeDownloads(now, { sabBps: sabBps * k, qbitDown: qbitDown * k, qbitUp, slskDown: slskDown * k, slskUp });
    if (this.on('arr')) this.writeArr(now);
    if (this.on('requests')) this.writeRequests();
    if (this.on('plex')) this.writePlex(now);
    if (this.on('hosts')) this.writeHosts(now, dt, sabBps, extracting);
    if (this.on('containers')) this.writeContainers(now);
    if (this.on('ping')) this.writePing(now, dt);
    if (this.on('storage')) this.writeStorage(now);
    if (this.on('wifi')) this.writeWifi(now, dt);
    if (this.on('vpn')) this.facts.vpn = { up: true, host: this.sabHost ?? undefined, provider: 'WireGuard', publicIp: '203.0.113.42', country: 'Switzerland', at: now };
    if (this.on('tailscale')) this.facts.tailscale = { up: true, peersOnline: 6, at: now };
    if (this.on('cameras')) this.stepCameras(now);
  }

  // ---------------------------------------------------------------- setup

  private init(now: number) {
    this.started = now;
    this.nextGrabAt = now + 2_000;
    this.nextSessionAt = now + this.between(60_000, 600_000);
    this.nextOutageAt = now + this.between(8, 20) * 60_000;
    this.nextCameraAt = now + this.between(3, 9) * 60_000;
    for (const s of SHOWS) {
      this.media.push({ key: `tv:tvdb:${s.tvdb}`, name: s.name, kind: 'tv', requested: this.rnd() < 0.4 });
    }
    for (const m of MOVIES) {
      this.media.push({ key: `movie:tmdb:${m.tmdb}`, name: m.name, kind: 'movie', requested: this.rnd() < 0.7 });
    }
    for (const n of this.lab.topology.nodes) {
      if (n.kind === 'host' || n.kind === 'nas') this.bootAt[n.id] = now - this.between(9, 15) * 86400_000;
    }
    // A movie that finished but can't be imported automatically, like a real Radarr queue.
    if (this.hasRadarr && this.sabHost) {
      const m = this.media.find((x) => x.kind === 'movie')!;
      const job = this.newJob(now - 50 * 60_000, m, 'sabnzbd');
      job.state = 'completed';
      job.done = job.size;
      job.stuck = true;
      this.jobs.push(job);
    }
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const frac = (now - dayStart.getTime()) / 86400_000;
    this.facts.wanToday = { downBytes: frac * 2.4e12, upBytes: frac * 1.1e11, at: now };
    if (this.on('cameras')) {
      this.facts.addCameraEvent({ id: 'cam-seed-1', camera: 'Driveway', kind: 'vehicle', ts: now - 42 * 60_000 });
    }
  }

  private newJob(now: number, m: Media, client: Job['client']): Job {
    const group = this.pick(GROUPS);
    let title: string;
    let size: number;
    let mediaKey = m.key;
    if (m.kind === 'tv') {
      const season = 1 + Math.floor(this.rnd() * 3);
      const pack = this.rnd() < 0.45;
      const ep = 1 + Math.floor(this.rnd() * 10);
      const se = pack ? `S0${season}` : `S0${season}E${String(ep).padStart(2, '0')}`;
      title = `${m.name}.${se}${pack ? '.Complete' : ''}.${this.pick(TV_FORMATS)}-${group}`;
      size = pack ? this.between(22, 55) * GB : this.between(2.5, 8) * GB;
      mediaKey = `${m.key}:${se.toLowerCase()}`;
    } else {
      title = `${m.name}.${this.pick(MOVIE_FORMATS)}-${group}`;
      size = title.includes('REMUX') ? this.between(45, 75) * GB : this.between(10, 28) * GB;
    }
    if (client === 'qbittorrent') size = Math.min(size, 6 * GB);
    return {
      id: client === 'sabnzbd' ? `SABnzbd_nzo_${this.hex(8)}` : this.hex(40).toUpperCase(),
      title,
      kind: m.kind,
      mediaKey,
      client,
      arr: m.kind === 'tv' ? 'sonarr' : 'radarr',
      size,
      done: 0,
      state: 'queued',
      failAt: null,
      stuck: false,
      grabbedAt: now,
      updatedAt: now,
      nextAt: 0,
    };
  }

  // ---------------------------------------------------------------- media pipeline

  private grab(now: number, job: Job) {
    if (job.arr === 'radarr' && !this.hasRadarr) job.arr = 'sonarr';
    this.jobs.push(job);
    this.arrEvents[job.arr].unshift({
      downloadId: job.id, eventType: 'grabbed', title: job.title, mediaKey: job.mediaKey, kind: job.kind, date: now,
    });
    this.spawned++;
  }

  private stepJobs(now: number) {
    if (!this.sabHost && !this.qbitHost) return;
    const active = this.jobs.filter((j) => j.state === 'queued' || j.state === 'downloading' || j.state === 'extracting');

    const due = this.regrabs.filter((r) => r.at <= now);
    this.regrabs = this.regrabs.filter((r) => r.at > now);
    for (const r of due) {
      const m = this.media.find((x) => r.mediaKey.startsWith(x.key));
      if (!m || !this.sabHost) continue;
      const job = this.newJob(now, m, 'sabnzbd');
      job.mediaKey = r.mediaKey;
      job.title = job.title.replace(/\.S0\d(E\d\d)?(\.Complete)?\./, `.${r.mediaKey.split(':').pop()!.toUpperCase()}.`);
      this.grab(now, job);
    }

    if (active.length < 2 && now >= this.nextGrabAt) {
      const useTorrent = this.qbitHost && (!this.sabHost || this.rnd() < 0.12);
      const job = this.newJob(now, this.pick(this.media), useTorrent ? 'qbittorrent' : 'sabnzbd');
      // The third grab always fails (so the demo shows the failure → recovery path), others rarely.
      if (this.spawned === 2 || this.rnd() < 0.06) job.failAt = this.between(0.35, 0.8);
      this.grab(now, job);
      this.nextGrabAt = now + (this.rnd() < 0.6 ? this.between(30, 150) : this.between(240, 600)) * 1000;
    }

    for (const j of this.jobs) {
      if (j.nextAt && now < j.nextAt) continue;
      if (j.state === 'extracting') {
        j.state = 'completed';
        j.updatedAt = now;
        j.nextAt = now + this.between(6, 15) * 1000;
      } else if (j.state === 'completed' && !j.stuck) {
        j.state = 'imported';
        j.updatedAt = now;
        j.nextAt = now + this.between(20, 50) * 1000;
        this.dataUsed += j.size;
        this.arrEvents[j.arr].unshift({ downloadId: j.id, eventType: 'imported', title: j.title, mediaKey: j.mediaKey, kind: j.kind, date: now });
      } else if (j.state === 'imported') {
        j.state = 'available';
        j.updatedAt = now;
        j.nextAt = 0;
      }
    }
    // Keep a day of history at most.
    this.jobs = this.jobs.filter((j) => now - j.updatedAt < 24 * 3600_000 || j.stuck).slice(-40);
    for (const k of ['sonarr', 'radarr'] as const) this.arrEvents[k] = this.arrEvents[k].slice(0, 80);
  }

  private advanceDownloads(now: number, dt: number, sabBps: number, qbitBps: number) {
    const advance = (client: Job['client'], bps: number) => {
      let j = this.jobs.find((x) => x.client === client && x.state === 'downloading');
      if (!j) {
        j = this.jobs.find((x) => x.client === client && x.state === 'queued');
        if (j) {
          j.state = 'downloading';
          j.updatedAt = now;
        }
        return;
      }
      j.done = Math.min(j.size, j.done + (bps / 8) * dt);
      if (j.failAt != null && j.done >= j.failAt * j.size) {
        j.state = 'failed';
        j.updatedAt = now;
        this.arrEvents[j.arr].unshift({
          downloadId: j.id, eventType: 'failed', title: j.title, mediaKey: j.mediaKey, kind: j.kind, date: now,
          message: 'Aborted, cannot be completed',
        });
        this.regrabs.push({ mediaKey: j.mediaKey, at: now + this.between(40, 90) * 1000 });
      } else if (j.done >= j.size) {
        j.state = client === 'sabnzbd' ? 'extracting' : 'completed';
        j.updatedAt = now;
        j.nextAt = now + (client === 'sabnzbd' ? this.between(12, 30) : this.between(6, 12)) * 1000;
      }
    };
    if (this.sabHost) advance('sabnzbd', sabBps);
    if (this.qbitHost) advance('qbittorrent', qbitBps);
  }

  private stepSessions(now: number) {
    if (!this.plexHost) return;
    this.sessions = this.sessions.filter((s) => s.endsAt > now);
    if (now >= this.nextSessionAt && this.sessions.length < 3) {
      const mesh = this.lab.topology.nodes.filter((n) => n.kind === 'mesh');
      const remote = this.rnd() < 0.25 || !mesh.length;
      const node = remote ? undefined : this.pick(mesh);
      const show = this.pick(this.media);
      this.sessions.push({
        id: `sess-${this.hex(6)}`,
        title: show.name.replace(/\.(\d{4})$/, ' ($1)').replace(/\./g, ' '),
        user: remote ? 'Remote friend' : 'Household',
        player: remote ? 'Roku Ultra' : node!.label.includes('Living') ? 'Living Room TV' : `${node!.label} iPad`,
        bandwidthBps: (remote ? this.between(6, 10) : this.between(12, 24)) * MBPS,
        local: !remote,
        nodeId: remote ? this.topo.internetId : node!.id,
        endsAt: now + this.between(8, 40) * 60_000,
      });
      this.nextSessionAt = now + this.between(5, 30) * 60_000;
    }
  }

  private stepOutage(now: number) {
    if (this.outage && now > this.outage.until) this.outage = null;
    if (!this.outage && now >= this.nextOutageAt) {
      const candidates = this.lab.services.filter((s) => !s.expect && s.app !== 'plex' && s.app !== 'sabnzbd');
      const svc = candidates.find((s) => s.id === 'tdarr') ?? candidates[candidates.length - 1];
      if (svc) this.outage = { service: svc.id, until: now + this.between(45, 120) * 1000 };
      this.nextOutageAt = now + this.between(15, 35) * 60_000;
    }
  }

  private stepCameras(now: number) {
    if (now < this.nextCameraAt) return;
    const kinds = ['motion', 'person', 'vehicle', 'pet'] as const;
    this.facts.addCameraEvent({ id: `cam-${this.hex(8)}`, camera: this.pick(CAMERAS), kind: this.pick([...kinds]), ts: now });
    this.nextCameraAt = now + this.between(4, 14) * 60_000;
  }

  // ---------------------------------------------------------------- traffic

  private writeTraffic(
    now: number,
    dt: number,
    a: { sabBps: number; extracting: boolean; qbitDown: number; qbitUp: number; slskDown: number; slskUp: number },
  ) {
    const net = this.topo.internetId;
    const flows: { from: string; to: string; bps: number }[] = [];
    const add = (from: string | null, to: string | null, bps: number) => {
      if (from && to && bps > 0 && from !== to) flows.push({ from, to, bps });
    };

    // App traffic.
    add(net, this.sabHost, a.sabBps * 1.03); // NNTP overhead on the wire
    add(net, this.qbitHost, a.qbitDown);
    add(this.qbitHost, net, a.qbitUp);
    add(net, this.slskdHost, a.slskDown);
    add(this.slskdHost, net, a.slskUp);
    // Downloads land on the NAS over NFS; unpacking reads and rewrites them.
    if (this.sabHost && this.nasHost) {
      const unpack = a.extracting ? this.w.walk('unpack', 0.75e9, 0.12e9, dt, 0.4, 0.4e9, 1.2e9) : 0;
      add(this.sabHost, this.nasHost, a.sabBps + unpack);
      add(this.nasHost, this.sabHost, unpack * 0.6);
      const tdarr = this.outage?.service === 'tdarr' ? 0 : this.w.walk('tdarr', 120 * MBPS, 40 * MBPS, dt, 0.1, 0);
      add(this.nasHost, this.sabHost, tdarr);
      add(this.sabHost, this.nasHost, tdarr * 0.55);
    }
    for (const s of this.sessions) add(this.plexHost, s.nodeId ?? net, s.bandwidthBps * this.w.walk(`sess-${s.id}`, 1, 0.15, dt, 0.5, 0.3, 1.6));

    // Background traffic by device kind.
    for (const n of this.lab.topology.nodes) {
      if (!n.parent) continue;
      const bg = this.background(n, now, dt);
      add(net, n.id, bg.down);
      add(n.id, net, bg.up);
    }
    if (this.nasHost) {
      for (const n of this.lab.topology.nodes.filter((x) => x.kind === 'host' || x.kind === 'laptop')) {
        add(this.nasHost, n.id, this.w.walk(`nas-${n.id}`, 1.5 * MBPS, 1 * MBPS, dt, 0.2, 0));
      }
    }

    // The internet plan is the real ceiling: scale WAN flows to fit it.
    const wanIn = flows.filter((f) => f.from === net).reduce((s, f) => s + f.bps, 0);
    const wanOut = flows.filter((f) => f.to === net).reduce((s, f) => s + f.bps, 0);
    const kIn = Math.min(1, this.wanDownBps / Math.max(1, wanIn));
    const kOut = Math.min(1, this.wanUpBps / Math.max(1, wanOut));
    for (const f of flows) {
      if (f.from === net) f.bps *= kIn;
      else if (f.to === net) f.bps *= kOut;
    }
    this.wanScale = kIn;

    // LACP: hash a share of each bonded host's flows onto its member port.
    for (const n of this.lab.topology.nodes) {
      if (!n.bondOf) continue;
      for (const f of [...flows]) {
        if (f.to !== n.bondOf && f.from !== n.bondOf) continue;
        const share = f.bps * 0.3;
        f.bps -= share;
        flows.push({ from: f.from === n.bondOf ? n.id : f.from, to: f.to === n.bondOf ? n.id : f.to, bps: share });
      }
    }

    // Route flows and accumulate per-link rates.
    const linkRates = new Map<string, { down: number; up: number }>();
    for (const f of flows) {
      for (const hop of pathBetween(this.topo, f.from, f.to)) {
        const r = linkRates.get(hop.linkId) ?? { down: 0, up: 0 };
        r[hop.dir] += f.bps;
        linkRates.set(hop.linkId, r);
      }
    }
    for (const def of this.topo.links.values()) {
      const r = linkRates.get(def.id) ?? { down: 0, up: 0 };
      // Links can't carry more than their speed; real switches drop, so do we.
      const down = Math.min(r.down, def.speedBps * 0.97);
      const up = Math.min(r.up, def.speedBps * 0.97);
      const c = this.counters.get(def.id) ?? { down: this.rnd() * 1e12, up: this.rnd() * 1e11 };
      c.down += (down / 8) * dt;
      c.up += (up / 8) * dt;
      this.counters.set(def.id, c);
      this.facts.setIface(simKeyFor(def.id), { inOctets: c.down, outOctets: c.up, speedBps: def.speedBps, up: true }, now);
    }
  }

  private background(n: NodeConfig, now: number, dt: number): { down: number; up: number } {
    const walk = (k: string, mean: number, sd: number) => this.w.walk(`${n.id}-${k}`, mean, sd, dt, 0.15, 0);
    const bursty = (base: number, rate: number, lo: number, hi: number) => {
      const b = this.burst.get(n.id);
      if (b && b.until > now) return base + b.bps;
      if (this.chance(rate, dt)) this.burst.set(n.id, { until: now + this.between(4, 25) * 1000, bps: this.between(lo, hi) });
      return base;
    };
    switch (n.kind) {
      case 'host':
        return { down: walk('dn', 4 * MBPS, 2 * MBPS), up: walk('up', 1.2 * MBPS, 0.6 * MBPS) };
      case 'nas':
        return { down: walk('dn', 0.6 * MBPS, 0.3 * MBPS), up: walk('up', 0.4 * MBPS, 0.2 * MBPS) };
      case 'laptop':
        return { down: bursty(walk('dn', 2 * MBPS, 1.5 * MBPS), 0.01, 40 * MBPS, 400 * MBPS), up: walk('up', 0.8 * MBPS, 0.5 * MBPS) };
      case 'dock':
        return { down: walk('dn', 0.5 * MBPS, 0.3 * MBPS), up: walk('up', 0.15 * MBPS, 0.1 * MBPS) };
      case 'printer':
        return { down: walk('dn', 0.02 * MBPS, 0.01 * MBPS), up: walk('up', 0.015 * MBPS, 0.008 * MBPS) };
      case 'hub':
        return { down: walk('dn', 0.01 * MBPS, 0.005 * MBPS), up: walk('up', 0.04 * MBPS, 0.02 * MBPS) };
      case 'device':
        return { down: walk('dn', 0.02 * MBPS, 0.01 * MBPS), up: walk('up', 0.01 * MBPS, 0.005 * MBPS) };
      case 'mesh': {
        const clients = this.facts.mesh.get(n.id)?.clients ?? 3;
        return {
          down: bursty(walk('dn', clients * 0.8 * MBPS, clients * 0.6 * MBPS), 0.006, 20 * MBPS, 180 * MBPS),
          up: walk('up', clients * 0.12 * MBPS, clients * 0.08 * MBPS),
        };
      }
      default:
        return { down: 0, up: 0 };
    }
  }

  // ---------------------------------------------------------------- facts

  private writeDownloads(now: number, a: { sabBps: number; qbitDown: number; qbitUp: number; slskDown: number; slskUp: number }) {
    const item = (j: Job): DownloadItemFact => ({
      id: j.id,
      name: j.title,
      status:
        j.state === 'downloading' ? 'downloading'
        : j.state === 'queued' ? 'queued'
        : j.state === 'extracting' ? 'extracting'
        : j.state === 'failed' ? 'failed'
        : 'completed',
      progress: j.size ? j.done / j.size : null,
      sizeBytes: j.size,
      category: j.kind === 'tv' ? 'tv' : 'movies',
      updatedAt: j.updatedAt,
      message: j.state === 'failed' ? 'Aborted, cannot be completed' : undefined,
    });
    const split = (client: Job['client']) => {
      const mine = this.jobs.filter((j) => j.client === client);
      return {
        queue: mine.filter((j) => j.state === 'queued' || j.state === 'downloading' || j.state === 'extracting').map(item),
        history: mine.filter((j) => j.state !== 'queued' && j.state !== 'downloading' && j.state !== 'extracting').map(item).reverse().slice(0, 30),
      };
    };
    if (this.sabHost) {
      this.facts.downloads.set('sabnzbd', { client: 'sabnzbd', protocol: 'usenet', host: this.sabHost, downBps: a.sabBps, upBps: 0, ...split('sabnzbd'), at: now });
    }
    if (this.qbitHost) {
      this.facts.downloads.set('qbittorrent', { client: 'qbittorrent', protocol: 'torrent', host: this.qbitHost, downBps: a.qbitDown, upBps: a.qbitUp, ...split('qbittorrent'), at: now });
    }
    if (this.slskdHost) {
      this.facts.downloads.set('slskd', { client: 'slskd', protocol: 'soulseek', host: this.slskdHost, downBps: a.slskDown, upBps: a.slskUp, queue: [], history: [], at: now });
    }
  }

  private writeArr(now: number) {
    const queueFor = (arr: Job['arr']): ArrQueueFact[] =>
      this.jobs
        .filter((j) => j.arr === arr && (j.state === 'queued' || j.state === 'downloading' || j.state === 'extracting' || j.state === 'completed'))
        .map((j) => ({
          downloadId: j.id,
          title: j.title,
          mediaKey: j.mediaKey,
          kind: j.kind,
          status: j.state === 'completed' ? 'completed' : j.state,
          trackedState: j.stuck ? 'importBlocked' : j.state === 'completed' ? 'importPending' : 'downloading',
          trackedStatus: j.stuck ? 'warning' : 'ok',
          messages: j.stuck ? ["Release name didn't match the expected movie", 'Manual Import required'] : [],
        }));
    const apps: { id: Job['arr']; label: string }[] = [{ id: 'sonarr', label: 'Sonarr' }];
    if (this.hasRadarr) apps.push({ id: 'radarr', label: 'Radarr' });
    for (const app of apps) {
      if (!this.lab.services.some((s) => s.app === app.id || s.id === app.id)) continue;
      this.facts.arr.set(app.id, {
        app: app.id,
        label: app.label,
        queue: queueFor(app.id),
        history: this.arrEvents[app.id],
        health: [],
        at: now,
      });
    }
  }

  private writeRequests() {
    if (!this.lab.services.some((s) => s.app === 'seerr')) return;
    this.facts.requests = this.jobs
      .filter((j) => this.media.find((m) => j.mediaKey.startsWith(m.key))?.requested)
      .map((j) => ({ mediaKey: j.mediaKey, title: j.title, requestedAt: j.grabbedAt - 60_000, status: 'approved' }));
  }

  private writePlex(now: number) {
    if (!this.plexHost) return;
    this.facts.plex = {
      host: this.plexHost,
      sessions: this.sessions.map(({ endsAt: _e, ...s }) => s),
      recentlyAdded: this.jobs
        .filter((j) => j.state === 'available')
        .map((j) => ({ mediaKey: j.mediaKey, title: j.title, addedAt: j.updatedAt })),
      at: now,
    };
  }

  private writeHosts(now: number, dt: number, sabBps: number, extracting: boolean) {
    for (const n of this.lab.topology.nodes) {
      if (n.kind !== 'host' && n.kind !== 'nas') continue;
      const isSab = n.id === this.sabHost;
      const isPlex = n.id === this.plexHost;
      const load = isSab ? (sabBps / 1e9) * 14 + (extracting ? 32 : 0) : isPlex ? this.sessions.length * 6 : 0;
      const base = n.kind === 'nas' ? 14 : isSab ? 9 : 4;
      const cpu = this.w.walk(`cpu-${n.id}`, base + load, 3, dt, 0.35, 0.5, 100);
      const mem = this.w.walk(`mem-${n.id}`, n.kind === 'nas' ? 7 : isSab ? 41 : 23, 0.6, dt, 0.05, 1, 99);
      // Some hosts expose no temperature sensor; the UI should show a dash, not a fake number.
      const tempC = n.kind === 'nas' ? 36 + cpu * 0.08 : isSab ? 44 + cpu * 0.25 : null;
      this.facts.hosts.set(n.id, {
        cpuPct: cpu,
        memPct: mem,
        tempC,
        uptimeS: (now - this.bootAt[n.id]) / 1000,
        at: now,
      });
    }
  }

  private writeContainers(now: number) {
    for (const s of this.lab.services) {
      const name = s.container ?? s.id;
      let state: 'running' | 'paused' | 'exited' = s.expect === 'paused' ? 'paused' : 'running';
      if (this.outage?.service === s.id) state = 'exited';
      this.facts.containers.set(name, { name, host: s.host, state, health: null, at: now });
    }
  }

  private writePing(now: number, dt: number) {
    const spike = this.chance(1 / 900, dt) ? this.between(15, 40) : 0;
    const rtt = this.w.walk('rtt', 7.6, 0.9, dt, 0.4, 5.5, 30) + spike;
    this.facts.ping.set('internet', { target: '1.1.1.1', rttMs: rtt, jitterMs: this.w.walk('jit', 1.2, 0.3, dt, 0.3, 0.2, 5), lossPct: 0, at: now });
    this.facts.ping.set('router', { target: 'router', rttMs: this.w.walk('rtt-r', 0.9, 0.12, dt, 0.5, 0.4, 3), jitterMs: 0.1, lossPct: 0, at: now });
  }

  private writeStorage(now: number) {
    if (!this.nasHost) return;
    const hdd = (prefix: string, n: number, model: string): DiskFact[] =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, slot: `${i + 1}`, model, health: 'ok', tempC: 34 + i }));
    const vols = [
      { id: 'data-volume', label: 'Data-Volume', total: 72.4e12, used: 0.478, disks: hdd('bay', 6, 'WD Red Pro 18TB') },
      {
        id: 'easystore', label: 'easystore', total: 17.8e12, used: 0.77, enclosure: 'expansion-33-3',
        disks: [{ id: 'exp-1', slot: 'E1', model: 'WD easystore 264D (NL-SAS)', health: 'warn' as const, tempC: 41 }],
      },
      {
        id: 'wdssd-vol', label: 'WDSSD-Vol', total: 0.705e12, used: 0.142,
        disks: [1, 2].map((i) => ({ id: `ssd-${i}`, slot: `M.2-${i}`, model: 'WD Red SN700 1TB', health: 'ok' as const, tempC: 39, ssd: true })),
      },
    ];
    for (const v of vols) {
      const extra = v.id === 'data-volume' ? this.dataUsed : 0;
      this.facts.volumes.set(v.id, {
        id: v.id,
        label: v.label,
        host: this.nasHost,
        enclosure: v.enclosure,
        usedBytes: v.total * v.used + extra,
        totalBytes: v.total,
        health: 'ok',
        disks: v.disks,
        at: now,
      });
    }
    this.facts.enclosures.set('expansion-33-3', { id: 'expansion-33-3', label: 'Expansion 33-3', health: 'warn', note: 'Abnormal', at: now });
  }

  private writeWifi(now: number, dt: number) {
    const mesh = this.lab.topology.nodes.filter((n) => n.kind === 'mesh');
    const preset = [1, 5, 12, 9];
    let total = 0;
    mesh.forEach((n, i) => {
      const cur = this.facts.mesh.get(n.id)?.clients ?? preset[i] ?? 3;
      const next = this.chance(1 / 300, dt) ? Math.max(0, cur + (this.rnd() < 0.5 ? -1 : 1)) : cur;
      total += next;
      this.facts.mesh.set(n.id, { nodeId: n.id, online: true, clients: next, at: now });
    });
    const routerClients = 4;
    const wired = this.topo.leaves.size - mesh.length;
    this.facts.wifi = { devices: total + routerClients + wired, wired, updateAvailable: true, routerClients, at: now };
  }
}

export function createSimulator(cfg: CollectorConfig, ctx: CollectorContext): Simulator {
  return new Simulator(cfg.id, ctx, {
    seed: typeof cfg.seed === 'number' ? cfg.seed : undefined,
    intervalMs: cfg.interval ? Number(cfg.interval) * 1000 : 1000,
    wanDownMbps: typeof cfg.wanDownMbps === 'number' ? cfg.wanDownMbps : undefined,
    wanUpMbps: typeof cfg.wanUpMbps === 'number' ? cfg.wanUpMbps : undefined,
  });
}
