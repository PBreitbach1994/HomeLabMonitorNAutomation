import { parse } from 'yaml';
import type { Medium, NodeKind } from '../shared/model.ts';

export interface LinkConfig {
  medium: Medium;
  speed?: number | string; // overrides the medium default, e.g. "2.5G"; a bond's total
  /**
   * Port(s) that measure this link, as "device/ifName" (e.g. "sw-core/sfp2"). A bond lists one
   * port per member cable; their rates are summed.
   */
  measure?: string | string[];
  /** The ports at the other end of the same cables, read when `measure` has no data. */
  alt?: string | string[];
  /** Which end of the link the measuring port sits on. Inferred when the device is `from` or `to`. */
  side?: 'upstream' | 'downstream';
  bonded?: boolean;
  approx?: boolean;
  port?: string; // human label, e.g. "sw-rack · port3"
}

export interface NodeConfig {
  id: string;
  label: string;
  sublabel?: string;
  kind: NodeKind;
  parent?: string;
  link?: LinkConfig;
  ip?: string;
  model?: string;
  location?: string;
  tag?: string;
  role?: string;
  /** Link to this device's page in the source of truth (NetBox). */
  href?: string;
}

export interface ServiceConfig {
  id: string;
  label: string;
  host: string; // node id
  container?: string; // defaults to id
  url?: string; // optional HTTP health check
  vpn?: boolean; // traffic leaves through the VPN tunnel
  expect?: 'running' | 'manual' | 'paused';
  app?: string; // sabnzbd | qbittorrent | slskd | plex | sonarr | radarr | ...
}

export interface CollectorConfig {
  id: string;
  kind: string;
  enabled?: boolean;
  interval?: number; // seconds
  [key: string]: unknown;
}

export interface NetboxConfig {
  url: string;
  token: string;
  /** Only this site's devices (slug). Omit to read every site. */
  site?: string;
  /** Seconds between topology refreshes (default 300). */
  refresh?: number;
  /** Services and VMs with this tag become service tiles (default "dashboard"). */
  tag?: string;
  /** Device statuses to include (default active, offline, failed, staged). */
  statuses?: string[];
  /** Device role slug → node kind, on top of the built-in guesses. */
  roles?: Record<string, NodeKind>;
  /** Where the last good topology is kept for when NetBox is unreachable. */
  cache?: string;
  /** Collectors created from NetBox tags and primary IPs; `false` turns one off. */
  collectors?: {
    snmp?: Record<string, unknown> | false; // devices tagged "snmp"; these fields are passed through (version, user, keys…)
    glances?: { port?: number } | false; // devices tagged "glances"
    ping?: { internet?: string } | false; // the gateway's primary IP + an internet target
  };
}

export interface LabConfig {
  lab: { name: string; provider?: string; timezone?: string };
  mode: 'demo' | 'live' | 'mixed';
  server: { port: number; host: string; token?: string };
  /** When set, devices, cabling and services come from NetBox; `topology`/`services` only override. */
  netbox?: NetboxConfig;
  topology: { nodes: NodeConfig[] };
  services: ServiceConfig[];
  collectors: CollectorConfig[];
}

export const MEDIUM_SPEED: Record<Medium, number> = {
  '100G': 100e9,
  '40G': 40e9,
  '25G': 25e9,
  '10G': 10e9,
  '5G': 5e9,
  '2.5G': 2.5e9,
  '1G': 1e9,
  '100M': 100e6,
  wifi: 2.4e9,
  vpn: 1e9,
  logical: 10e9,
};

export function parseSpeed(v: number | string | undefined, medium: Medium): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = /^([\d.]+)\s*([kMG]?)/i.exec(v.trim());
    if (m) {
      const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
      return Number(m[1]) * mult;
    }
  }
  return MEDIUM_SPEED[medium];
}

/** Replaces ${VAR} / ${VAR:-default} in every string value with environment variables. */
export function interpolateEnv<T>(value: T, env: Record<string, string | undefined>): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name: string, def?: string) => env[name] ?? def ?? '') as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)])) as T;
  }
  return value;
}

/**
 * Checks the topology hangs together. With NetBox configured, the YAML `topology`/`services` are
 * only overrides, so cross-references are checked after the NetBox data is merged in.
 */
export function validateConfig(cfg: LabConfig, opts: { merged?: boolean } = {}): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of cfg.topology.nodes) {
    if (!n.id) errors.push(`node without id: ${JSON.stringify(n)}`);
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  if (cfg.netbox && !opts.merged) {
    if (!cfg.netbox.url) errors.push('netbox.url is required');
    return errors;
  }
  for (const n of cfg.topology.nodes) {
    if (n.parent && !ids.has(n.parent)) errors.push(`node "${n.id}" has unknown parent "${n.parent}"`);
    if (n.parent && !n.link) errors.push(`node "${n.id}" has a parent but no link`);
  }
  if (cfg.topology.nodes.filter((n) => n.kind === 'internet').length !== 1) {
    errors.push('topology needs exactly one node of kind "internet"');
  }
  for (const s of cfg.services) {
    if (!ids.has(s.host)) errors.push(`service "${s.id}" runs on unknown host "${s.host}"`);
  }
  return errors;
}

export function normalizeConfig(raw: Partial<LabConfig>): LabConfig {
  return {
    lab: { name: 'Home Lab Control', ...raw.lab },
    mode: raw.mode ?? 'demo',
    server: { port: 8787, host: '0.0.0.0', ...raw.server },
    netbox: raw.netbox,
    topology: { nodes: raw.topology?.nodes ?? [] },
    services: raw.services ?? [],
    collectors: raw.collectors ?? [],
  };
}

/** Parses YAML text into a validated config (no filesystem access, so the browser demo can use it too). */
export function parseConfig(text: string, env: Record<string, string | undefined> = {}): LabConfig {
  const config = normalizeConfig(interpolateEnv(parse(text) as Partial<LabConfig>, env));
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid config:\n  - ${errors.join('\n  - ')}`);
  return config;
}
