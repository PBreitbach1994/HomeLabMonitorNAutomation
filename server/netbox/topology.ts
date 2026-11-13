// Turns a NetBox inventory into the dashboard's topology, services and collector targets.
//
// - Devices become nodes; the role slug decides the kind (router, switch, AP…).
// - Cabling comes from each interface's traced `connected_endpoints`, so patch panels and
//   wireless links are followed for free. Several cables between the same two devices that
//   belong to one LAG become a single bonded link.
// - The tree is rooted at the internet circuit (a circuit termination cabled to a device), and
//   grown outward preferring wired paths over wireless ones.
// - Services and VMs carrying the dashboard tag become service tiles.

import type { CollectorConfig, LinkConfig, NetboxConfig, NodeConfig, ServiceConfig } from '../config.ts';
import type { Medium, NodeKind } from '../../shared/model.ts';
import type { Inventory, NbDevice, NbInterface, NbService, NbTag, NbVirtualMachine } from './types.ts';

export const INTERNET_ID = 'internet';
export const DEFAULT_STATUSES = ['active', 'offline', 'failed', 'staged'];

export interface NetboxLab {
  nodes: NodeConfig[];
  services: ServiceConfig[];
  collectors: CollectorConfig[];
  provider?: string;
  warnings: string[];
}

const KIND_BY_ROLE: Record<string, NodeKind> = {
  router: 'router', gateway: 'router', firewall: 'router',
  switch: 'switch', 'core-switch': 'switch', 'access-switch': 'switch',
  'access-point': 'mesh', ap: 'mesh', 'wireless-ap': 'mesh', mesh: 'mesh',
  server: 'host', host: 'host', hypervisor: 'host', 'docker-host': 'host',
  nas: 'nas', storage: 'nas', 'file-server': 'nas',
  workstation: 'laptop', desktop: 'laptop', laptop: 'laptop',
  printer: 'printer', dock: 'dock', hub: 'hub', iot: 'hub', camera: 'hub', nvr: 'hub',
};

/** Role slug → kind: explicit config, then the built-in table, then a guess from the words in the slug. */
export function kindForRole(slug: string | undefined, overrides: Record<string, NodeKind> = {}): NodeKind {
  if (!slug) return 'device';
  if (overrides[slug]) return overrides[slug];
  if (KIND_BY_ROLE[slug]) return KIND_BY_ROLE[slug];
  if (/router|gateway|firewall|\bfw\b/.test(slug)) return 'router';
  if (/switch/.test(slug)) return 'switch';
  if (/(^|-)ap(-|$)|access-point|wifi|wireless|mesh/.test(slug)) return 'mesh';
  if (/nas|storage|san\b/.test(slug)) return 'nas';
  if (/server|host|hypervisor|compute|node/.test(slug)) return 'host';
  if (/laptop|workstation|desktop|pc\b/.test(slug)) return 'laptop';
  if (/printer/.test(slug)) return 'printer';
  return 'device';
}

const isWireless = (i: NbInterface) => !!i.wireless_link || i.type.value.startsWith('ieee802.11');

/** Interface speed in bits/s: the configured speed, else what the interface type implies. */
export function ifaceSpeed(i: NbInterface): number | null {
  if (i.speed) return i.speed * 1000;
  const m = /^(\d+(?:\.\d+)?)(g?)base/i.exec(i.type.value);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1e9 : 1e6);
}

export function mediumForSpeed(bps: number | null, wireless = false): Medium {
  if (wireless) return 'wifi';
  if (bps == null) return '1G';
  if (bps >= 100e9) return '100G';
  if (bps >= 40e9) return '40G';
  if (bps >= 25e9) return '25G';
  if (bps >= 10e9) return '10G';
  if (bps >= 5e9) return '5G';
  if (bps >= 2.5e9) return '2.5G';
  if (bps >= 1e9) return '1G';
  return '100M';
}

const hasTag = (tags: NbTag[] | undefined, slug: string) => !!tags?.some((t) => t.slug === slug);
const roleOf = (d: NbDevice) => d.role ?? d.device_role;
const ipOf = (d: { primary_ip?: { address: string } | null }) => d.primary_ip?.address.split('/')[0];

/** Custom field value as a string — select fields arrive as {value, label}. */
function cf(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const v = fields?.[name];
  if (v == null || v === '') return undefined;
  if (typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value);
  return String(v);
}

interface Edge {
  a: string; // device name
  b: string;
  aIf: NbInterface;
  bIf: NbInterface;
  wireless: boolean;
}

export function buildFromInventory(inv: Inventory, cfg: Pick<NetboxConfig, 'roles' | 'statuses' | 'tag' | 'collectors'> = {}): NetboxLab {
  const warnings: string[] = [];
  const statuses = new Set(cfg.statuses ?? DEFAULT_STATUSES);
  const devices = new Map<string, NbDevice>();
  for (const d of inv.devices) {
    if (!d.name) continue; // unnamed devices can't be addressed by collectors
    if (d.status && !statuses.has(d.status.value)) continue;
    devices.set(d.name, d);
  }
  const ifaceById = new Map(inv.interfaces.map((i) => [i.id, i]));
  const ifacesOf = new Map<string, NbInterface[]>();
  for (const i of inv.interfaces) {
    const dev = i.device.name;
    if (dev) ifacesOf.set(dev, [...(ifacesOf.get(dev) ?? []), i]);
  }

  // --- edges from traced cable paths --------------------------------------------
  const edges: Edge[] = [];
  const seenPairs = new Set<string>();
  for (const i of inv.interfaces) {
    if (i.enabled === false || i.connected_endpoints_type !== 'dcim.interface' || !i.connected_endpoints_reachable) continue;
    const a = i.device.name;
    for (const ep of i.connected_endpoints ?? []) {
      const b = ep.device?.name;
      if (!a || !b || a === b || !devices.has(a) || !devices.has(b)) continue;
      const key = [i.id, ep.id].sort((x, y) => x - y).join('-');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const peer = ifaceById.get(ep.id) ?? ({ id: ep.id, name: ep.name, device: ep.device!, type: { value: 'other' } } as NbInterface);
      if (peer.enabled === false) continue;
      edges.push({ a, b, aIf: i, bIf: peer, wireless: isWireless(i) || isWireless(peer) });
    }
  }

  // --- root: the internet circuit -------------------------------------------------
  const wanIf = inv.interfaces.find((i) => i.link_peers_type === 'circuits.circuittermination' && i.device.name && devices.has(i.device.name));
  let routerName = wanIf?.device.name ?? undefined;
  let provider: string | undefined;
  let circuitLabel: string | undefined;
  let wanSpeed: number | undefined;
  if (wanIf) {
    const peer = wanIf.link_peers?.[0];
    const circuit = inv.circuits.find((c) => c.id === peer?.circuit?.id);
    provider = circuit?.provider.name ?? peer?.circuit?.provider?.name;
    circuitLabel = circuit?.cid ?? peer?.circuit?.cid;
    const term = circuit?.termination_a?.id === peer?.id ? circuit?.termination_a : circuit?.termination_z ?? circuit?.termination_a;
    const kbps = term?.port_speed ?? circuit?.commit_rate ?? undefined;
    if (kbps) wanSpeed = kbps * 1000;
    if (inv.interfaces.filter((i) => i.link_peers_type === 'circuits.circuittermination').length > 1) {
      warnings.push(`More than one interface is cabled to a circuit; using ${routerName}/${wanIf.name} as the internet uplink.`);
    }
  } else {
    routerName = [...devices.values()].find((d) => kindForRole(roleOf(d)?.slug, cfg.roles) === 'router')?.name ?? undefined;
    warnings.push(
      routerName
        ? `No circuit is cabled to a device, so internet traffic can't be measured. Add your ISP circuit and cable its termination to ${routerName}'s WAN port.`
        : 'No circuit and no router-role device found — nothing to root the network map at.',
    );
  }

  const nodes: NodeConfig[] = [{ id: INTERNET_ID, label: 'Internet', sublabel: provider ?? 'Internet', kind: 'internet' }];
  if (!routerName) return { nodes, services: [], collectors: [], provider, warnings };

  // --- grow the tree: cheapest path from the router, wired before wireless ---------
  const adj = new Map<string, Edge[]>();
  for (const e of edges) {
    adj.set(e.a, [...(adj.get(e.a) ?? []), e]);
    adj.set(e.b, [...(adj.get(e.b) ?? []), e]);
  }
  const cost = new Map<string, number>([[routerName, 0]]);
  const parent = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let cur: string | undefined;
    for (const [n, c] of cost) if (!done.has(n) && (cur === undefined || c < cost.get(cur)!)) cur = n;
    if (cur === undefined) break;
    done.add(cur);
    for (const e of adj.get(cur) ?? []) {
      const next = e.a === cur ? e.b : e.a;
      const c = cost.get(cur)! + (e.wireless ? 10 : 1);
      if (!done.has(next) && c < (cost.get(next) ?? Infinity)) {
        cost.set(next, c);
        parent.set(next, cur);
      }
    }
  }

  const deviceNode = (d: NbDevice): NodeConfig => ({
    id: d.name!,
    label: d.name!,
    sublabel: d.device_type.model,
    kind: kindForRole(roleOf(d)?.slug, cfg.roles),
    role: roleOf(d)?.name,
    model: [d.device_type.manufacturer?.name, d.device_type.model].filter(Boolean).join(' '),
    ip: ipOf(d),
    href: d.display_url,
  });

  const router = devices.get(routerName)!;
  const routerMedium = mediumForSpeed(wanIf ? ifaceSpeed(wanIf) : null);
  nodes.push({
    ...deviceNode(router),
    parent: INTERNET_ID,
    link: {
      medium: routerMedium,
      speed: wanSpeed,
      measure: wanIf ? `${routerName}/${wanIf.name}` : undefined,
      port: wanIf ? `${routerName} · ${wanIf.name}${circuitLabel ? ` (${circuitLabel})` : ''}` : undefined,
    },
  });

  // Order children the way they hang off their parent's ports, so the map reads like the switch.
  const portOf = (child: string) => {
    const par = parent.get(child)!;
    const names = (adj.get(child) ?? [])
      .filter((e) => (e.a === par && e.b === child) || (e.b === par && e.a === child))
      .map((e) => (e.a === par ? e.aIf.name : e.bIf.name));
    return names.sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))[0] ?? '';
  };
  const order = [...parent.keys()].sort(
    (x, y) => cost.get(x)! - cost.get(y)! || portOf(x).localeCompare(portOf(y), undefined, { numeric: true }) || x.localeCompare(y),
  );
  for (const child of order) {
    const par = parent.get(child)!;
    const between = (adj.get(child) ?? []).filter((e) => (e.a === par && e.b === child) || (e.b === par && e.a === child));
    const wired = between.filter((e) => !e.wireless);
    const pool = wired.length ? wired : between;
    // Parallel cables form one link only when the child's ends share a LAG; otherwise keep the fastest.
    const childEnd = (e: Edge) => (e.a === child ? e.aIf : e.bIf);
    const parentEnd = (e: Edge) => (e.a === par ? e.aIf : e.bIf);
    const lagIds = new Set(pool.map((e) => childEnd(e).lag?.id).filter((x) => x != null));
    let members = pool;
    if (pool.length > 1 && !(lagIds.size === 1 && pool.every((e) => childEnd(e).lag))) {
      const data = pool.filter((e) => !childEnd(e).mgmt_only && !parentEnd(e).mgmt_only);
      const candidates = data.length ? data : pool;
      members = [candidates.reduce((best, e) => ((ifaceSpeed(childEnd(e)) ?? 0) > (ifaceSpeed(childEnd(best)) ?? 0) ? e : best))];
    }
    members.sort((x, y) => parentEnd(x).name.localeCompare(parentEnd(y).name, undefined, { numeric: true }));
    const wireless = members.every((e) => e.wireless);
    const speeds = members.map((e) => Math.min(...[ifaceSpeed(e.aIf), ifaceSpeed(e.bIf)].filter((s): s is number => s != null)));
    const perCable = speeds.filter(Number.isFinite);
    const link: LinkConfig = {
      medium: mediumForSpeed(perCable.length ? Math.min(...perCable) : null, wireless),
      speed: !wireless && perCable.length === members.length ? perCable.reduce((a, b) => a + b, 0) : undefined,
      bonded: members.length > 1 || undefined,
      measure: members.map((e) => `${par}/${parentEnd(e).name}`),
      alt: members.map((e) => `${child}/${childEnd(e).name}`),
      port: `${par} · ${members.map((e) => parentEnd(e).name).join(' + ')}`,
    };
    if (members.length === 1) {
      link.measure = (link.measure as string[])[0];
      link.alt = (link.alt as string[])[0];
    }
    nodes.push({ ...deviceNode(devices.get(child)!), parent: par, link });
  }

  const placed = new Set(nodes.map((n) => n.id));
  const orphans = [...devices.keys()].filter((n) => !placed.has(n) && (ifacesOf.get(n)?.length ?? 0) > 0);
  if (orphans.length) {
    warnings.push(`Not connected to the network in NetBox (no traced cable path), so not on the map: ${orphans.join(', ')}.`);
  }

  // --- service tiles ------------------------------------------------------------
  const tag = cfg.tag ?? 'dashboard';
  const services: ServiceConfig[] = [];
  const usedIds = new Set<string>();
  const uniqueId = (base: string) => {
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'service';
  const clusterHost = (clusterId?: number) => {
    const hosts = [...devices.values()].filter((d) => d.cluster?.id === clusterId);
    return hosts.length === 1 ? hosts[0].name! : undefined;
  };
  const vmHost = (vm: Pick<NbVirtualMachine, 'device' | 'cluster'>) => vm.device?.name ?? (vm.cluster ? clusterHost(vm.cluster.id) : undefined);
  const vmById = new Map(inv.vms.map((v) => [v.id, v]));
  const tile = (name: string, host: string | undefined, fields: Record<string, unknown> | undefined, tags: NbTag[] | undefined, what: string) => {
    if (!host || !placed.has(host)) {
      warnings.push(`${what} "${name}" isn't on a device that's on the map, so it has no tile.`);
      return;
    }
    const expect = cf(fields, 'dashboard_expect');
    services.push({
      id: uniqueId(slug(name)),
      label: name,
      host,
      app: cf(fields, 'dashboard_app'),
      container: cf(fields, 'dashboard_container') ?? name,
      url: cf(fields, 'dashboard_health_url'),
      vpn: hasTag(tags, 'vpn') || undefined,
      expect: expect === 'manual' || expect === 'paused' || expect === 'running' ? expect : undefined,
    });
  };
  for (const vm of inv.vms) {
    if (!hasTag(vm.tags, tag)) continue;
    tile(vm.name, vmHost(vm), vm.custom_fields, vm.tags, 'VM');
  }
  for (const s of inv.services as NbService[]) {
    if (!hasTag(s.tags, tag)) continue;
    const type = s.parent_object_type ?? (s.virtual_machine ? 'virtualization.virtualmachine' : 'dcim.device');
    const ref = s.parent ?? s.device ?? s.virtual_machine;
    let host: string | undefined;
    if (type === 'dcim.device') host = ref?.name;
    else if (type === 'virtualization.virtualmachine') {
      const vm = ref ? vmById.get(ref.id) : undefined;
      host = vm ? vmHost(vm) : undefined;
    }
    tile(s.name, host, s.custom_fields, s.tags, 'Service');
  }

  // --- collector targets ----------------------------------------------------------
  const collectors: CollectorConfig[] = [];
  const c = cfg.collectors ?? {};
  for (const d of devices.values()) {
    const ip = ipOf(d);
    if (!ip || !placed.has(d.name!)) continue;
    if (c.snmp !== false && hasTag(d.tags, 'snmp')) {
      collectors.push({ ...(c.snmp ?? {}), id: `snmp-${d.name}`, kind: 'snmp', device: d.name, host: ip });
    }
    if (c.glances !== false && hasTag(d.tags, 'glances')) {
      collectors.push({ id: `glances-${d.name}`, kind: 'glances', host: d.name, url: `http://${ip}:${c.glances?.port ?? 61208}` });
    }
  }
  const routerIp = ipOf(router);
  if (c.ping !== false) {
    collectors.push({
      id: 'ping',
      kind: 'ping',
      targets: { internet: c.ping?.internet ?? '1.1.1.1', ...(routerIp ? { router: routerIp } : {}) },
    });
  }

  return { nodes, services, collectors, provider, warnings };
}
