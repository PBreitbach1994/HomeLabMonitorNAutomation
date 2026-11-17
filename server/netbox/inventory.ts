// A compact way to describe a lab, loaded into NetBox by scripts/netbox-import.ts.
// See examples/demo-lab.inventory.yaml for the full format. This file only parses and validates;
// it never talks to NetBox.

import { parse } from 'yaml';

export interface InvInterface {
  name: string;
  type: string;
  lag?: string;
  mgmtOnly?: boolean;
  speedKbps?: number;
}

export interface InvDevice {
  name: string;
  role: string; // slug
  model: string;
  manufacturer: string;
  status: string;
  tags: string[];
  interfaces: InvInterface[];
  /** Patch panels: front/rear port pairs F1..Fn / R1..Rn. */
  passThroughPorts: number;
  ip?: { address: string; iface: string };
}

export interface InvEnd {
  device: string;
  port: string; // interface, or F<n>/R<n> on a patch panel
}

export interface InvService {
  name: string;
  host: string;
  kind: 'container' | 'service';
  ports: number[];
  protocol: 'tcp' | 'udp';
  app?: string;
  container?: string;
  expect?: 'running' | 'manual' | 'paused';
  healthUrl?: string;
  vpn: boolean;
}

export interface Inventory {
  site: { name: string; slug: string };
  internet?: { provider: string; cid: string; downloadKbps?: number; uploadKbps?: number; connect: InvEnd };
  devices: InvDevice[];
  cables: [InvEnd, InvEnd][];
  wireless: { a: InvEnd; b: InvEnd; ssid?: string }[];
  services: InvService[];
}

export class InventoryError extends Error {}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "1G" → 1_000_000 kbps, "50M" → 50_000, "2.5G" → 2_500_000. */
export function rateKbps(v: unknown, what: string): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  const m = /^\s*([\d.]+)\s*([kmg])?(?:b(?:it)?(?:ps|\/s)?)?\s*$/i.exec(String(v));
  if (!m) throw new InventoryError(`${what}: "${v}" isn't a rate like 1G or 500M`);
  const mult = { k: 1, m: 1e3, g: 1e6 }[(m[2] ?? 'k').toLowerCase() as 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * mult);
}

/** "port[1-8]" → port1…port8; "Gi1/0/[1-24]" → Gi1/0/1…Gi1/0/24; anything else is itself. */
export function expandRange(name: string): string[] {
  const m = /^(.*)\[(\d+)-(\d+)\](.*)$/.exec(name);
  if (!m) return [name];
  const [from, to] = [Number(m[2]), Number(m[3])];
  if (to < from || to - from > 512) throw new InventoryError(`interface range "${name}" is backwards or too long`);
  return Array.from({ length: to - from + 1 }, (_, i) => `${m[1]}${from + i}${m[4]}`);
}

export function parseEnd(s: unknown, where: string): InvEnd {
  const str = String(s ?? '').trim();
  const i = str.indexOf('/');
  if (i <= 0 || i === str.length - 1) throw new InventoryError(`${where}: "${str}" should look like device/port`);
  return { device: str.slice(0, i), port: str.slice(i + 1) };
}

function parseLink(v: unknown, where: string): [InvEnd, InvEnd] {
  if (Array.isArray(v) && v.length === 2) return [parseEnd(v[0], where), parseEnd(v[1], where)];
  const parts = String(v ?? '').split(/\s+--\s+|\s*<->\s*/);
  if (parts.length !== 2) throw new InventoryError(`${where}: "${v}" should be "devA/port -- devB/port"`);
  return [parseEnd(parts[0], where), parseEnd(parts[1], where)];
}

const asObj = (v: unknown, where: string): Record<string, unknown> => {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new InventoryError(`${where} should be a mapping`);
  return v as Record<string, unknown>;
};
const strList = (v: unknown) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export function parseInventory(text: string): Inventory {
  const raw = asObj(parse(text), 'the file');
  const siteRaw = typeof raw.site === 'string' ? { name: raw.site } : asObj(raw.site, 'site');
  if (!siteRaw.name) throw new InventoryError('site.name is required');
  const site = { name: String(siteRaw.name), slug: String(siteRaw.slug ?? slugify(String(siteRaw.name))) };
  const defaults = asObj(raw.defaults, 'defaults');

  const devices: InvDevice[] = [];
  for (const [name, dv] of Object.entries(asObj(raw.devices, 'devices'))) {
    const d = asObj(dv, `devices.${name}`);
    if (!d.role) throw new InventoryError(`devices.${name}: role is required`);
    const interfaces: InvInterface[] = [];
    for (const [ifName, iv] of Object.entries(asObj(d.interfaces, `devices.${name}.interfaces`))) {
      const spec = typeof iv === 'string' ? { type: iv } : asObj(iv, `devices.${name}.interfaces.${ifName}`);
      if (!spec.type) throw new InventoryError(`devices.${name}.interfaces.${ifName}: type is required (e.g. 1000base-t)`);
      for (const n of expandRange(ifName)) {
        interfaces.push({
          name: n,
          type: String(spec.type),
          lag: spec.lag ? String(spec.lag) : undefined,
          mgmtOnly: spec.mgmt === true || spec.mgmt_only === true || undefined,
          speedKbps: rateKbps(spec.speed, `devices.${name}.interfaces.${ifName}.speed`),
        });
      }
    }
    const names = new Set(interfaces.map((i) => i.name));
    for (const i of interfaces) {
      if (i.lag && !interfaces.some((l) => l.name === i.lag && l.type === 'lag')) {
        throw new InventoryError(`devices.${name}.interfaces.${i.name}: lag "${i.lag}" isn't an interface of type lag on ${name}`);
      }
    }
    let ip: InvDevice['ip'];
    if (d.ip) {
      const m = /^\s*(\S+)\s+on\s+(\S+)\s*$/.exec(String(d.ip));
      if (!m) throw new InventoryError(`devices.${name}.ip: write it as "10.0.0.5/24 on eth0"`);
      if (!m[1].includes('/')) throw new InventoryError(`devices.${name}.ip: include the prefix length, e.g. ${m[1]}/24`);
      if (!names.has(m[2])) throw new InventoryError(`devices.${name}.ip: ${name} has no interface "${m[2]}"`);
      ip = { address: m[1], iface: m[2] };
    }
    devices.push({
      name,
      role: slugify(String(d.role)),
      model: String(d.model ?? defaults.model ?? `Generic ${d.role}`),
      manufacturer: String(d.manufacturer ?? defaults.manufacturer ?? 'Generic'),
      status: String(d.status ?? 'active'),
      tags: strList(d.tags),
      interfaces,
      passThroughPorts: Number(d.ports ?? 0),
      ip,
    });
  }

  const byName = new Map(devices.map((d) => [d.name, d]));
  const checkEnd = (e: InvEnd, where: string, opts: { passThrough?: boolean } = {}) => {
    const d = byName.get(e.device);
    if (!d) throw new InventoryError(`${where}: unknown device "${e.device}"`);
    if (d.interfaces.some((i) => i.name === e.port)) return;
    const pt = /^([FR])(\d+)$/.exec(e.port);
    if (opts.passThrough !== false && pt && Number(pt[2]) >= 1 && Number(pt[2]) <= d.passThroughPorts) return;
    throw new InventoryError(`${where}: ${e.device} has no port "${e.port}"`);
  };

  const cables = (Array.isArray(raw.cables) ? raw.cables : []).map((c, i) => {
    const link = parseLink(c, `cables[${i}]`);
    link.forEach((e) => checkEnd(e, `cables[${i}]`));
    return link;
  });
  const used = new Map<string, number>();
  cables.forEach((link, i) =>
    link.forEach((e) => {
      const k = `${e.device}/${e.port}`;
      if (used.has(k)) throw new InventoryError(`cables[${i}]: ${k} is already cabled in cables[${used.get(k)}]`);
      used.set(k, i);
    }),
  );

  const wireless = (Array.isArray(raw.wireless) ? raw.wireless : []).map((w, i) => {
    const o = typeof w === 'string' || Array.isArray(w) ? { link: w } : asObj(w, `wireless[${i}]`);
    const [a, b] = parseLink(o.link, `wireless[${i}]`);
    [a, b].forEach((e) => checkEnd(e, `wireless[${i}]`, { passThrough: false }));
    return { a, b, ssid: o.ssid ? String(o.ssid) : undefined };
  });

  let internet: Inventory['internet'];
  if (raw.internet) {
    const n = asObj(raw.internet, 'internet');
    if (!n.provider || !n.connect) throw new InventoryError('internet needs provider and connect (the router port the ISP plugs into)');
    const connect = parseEnd(n.connect, 'internet.connect');
    checkEnd(connect, 'internet.connect', { passThrough: false });
    if (used.has(`${connect.device}/${connect.port}`)) throw new InventoryError(`internet.connect: ${connect.device}/${connect.port} is also in cables`);
    internet = {
      provider: String(n.provider),
      cid: String(n.cid ?? `${slugify(String(n.provider))}-internet`),
      downloadKbps: rateKbps(n.download, 'internet.download'),
      uploadKbps: rateKbps(n.upload, 'internet.upload'),
      connect,
    };
  }

  const services = (Array.isArray(raw.services) ? raw.services : []).map((sv, i): InvService => {
    const s = asObj(sv, `services[${i}]`);
    const where = `services[${i}]${s.name ? ` (${s.name})` : ''}`;
    if (!s.name || !s.on) throw new InventoryError(`${where}: name and on (the device it runs on) are required`);
    if (!byName.has(String(s.on))) throw new InventoryError(`${where}: unknown device "${s.on}"`);
    const expect = s.expect == null ? undefined : String(s.expect);
    if (expect && !['running', 'manual', 'paused'].includes(expect)) throw new InventoryError(`${where}: expect must be running, manual or paused`);
    const ports = (Array.isArray(s.ports) ? s.ports : s.ports == null ? [] : [s.ports]).map(Number);
    return {
      name: String(s.name),
      host: String(s.on),
      // A listening port makes it an IPAM service on the device; otherwise it's a container (a VM in NetBox).
      kind: s.kind === 'service' || (s.kind !== 'container' && ports.length > 0) ? 'service' : 'container',
      ports,
      protocol: s.protocol === 'udp' ? 'udp' : 'tcp',
      app: s.app ? String(s.app) : undefined,
      container: s.container ? String(s.container) : undefined,
      expect: expect as InvService['expect'],
      healthUrl: s.health_url ? String(s.health_url) : undefined,
      vpn: s.vpn === true,
    };
  });

  return { site, internet, devices, cables, wireless, services };
}
