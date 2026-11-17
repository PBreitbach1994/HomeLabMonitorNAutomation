// Loads an inventory (see inventory.ts) into NetBox. Converges rather than replaces: it creates
// what's missing and fixes simple drift (role, model, tags, interface type/LAG), but never deletes,
// and never re-cables a port that NetBox already shows connected somewhere else — that's a warning.

import { NetBoxError, type NetBoxClient } from './client.ts';
import { TAGS, ensureSchema } from './bootstrap.ts';
import { slugify, type InvEnd, type Inventory } from './inventory.ts';

type Obj = { id: number; [k: string]: unknown };
type Ref = { id: number; name?: string; slug?: string; device?: { name?: string } } | null | undefined;

export interface ImportReport {
  created: string[];
  updated: string[];
  unchanged: number;
  warnings: string[];
}

const ROLE_COLORS: Record<string, string> = {
  router: 'f44336', switch: '2196f3', 'access-point': '00bcd4', server: '4caf50', nas: '9c27b0',
  workstation: '607d8b', printer: '795548', 'patch-panel': '9e9e9e',
};
// Short words read as acronyms (nas → NAS, ups → UPS); longer ones are capitalised.
const titleCase = (slug: string) => slug.split('-').map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
const sameIds = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export async function applyInventory(
  nb: NetBoxClient,
  inv: Inventory,
  opts: { dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<ImportReport> {
  const dry = !!opts.dryRun;
  const log = opts.log ?? (() => {});
  const report: ImportReport = { created: [], updated: [], unchanged: 0, warnings: [] };
  let fakeId = 0;
  const fake = () => --fakeId; // placeholder ids for objects a dry run would create
  const isFake = (id: number) => id < 0;

  const create = async (path: string, body: Record<string, unknown>, label: string): Promise<Obj> => {
    report.created.push(label);
    log(`${dry ? 'would create' : 'created'} ${label}`);
    if (dry) return { id: fake(), ...body };
    return nb.post<Obj>(`${path}/`, body);
  };
  const update = async (path: string, obj: Obj, body: Record<string, unknown>, label: string): Promise<void> => {
    report.updated.push(label);
    log(`${dry ? 'would update' : 'updated'} ${label}: ${Object.keys(body).join(', ')}`);
    if (!dry && !isFake(obj.id)) Object.assign(obj, await nb.patch<Obj>(`${path}/${obj.id}/`, body));
  };
  const find = async (path: string, filter: Record<string, string | number>): Promise<Obj | undefined> => {
    if (Object.values(filter).some((v) => typeof v === 'number' && isFake(v))) return undefined;
    return (await nb.list<Obj>(path, filter))[0];
  };
  const ensure = async (path: string, filter: Record<string, string | number>, body: Record<string, unknown>, label: string) => {
    const found = await find(path, filter);
    if (found) {
      report.unchanged++;
      return found;
    }
    return create(path, body, label);
  };

  // --- schema and tags ----------------------------------------------------------
  if (!dry) await ensureSchema(nb, (m) => report.created.push(m));
  const tagIds = new Map<string, number>();
  const wantedTags = new Set([...TAGS.map((t) => t.slug), ...inv.devices.flatMap((d) => d.tags)]);
  for (const slug of wantedTags) {
    const schemaTag = TAGS.find((t) => t.slug === slug);
    const tag = await ensure('extras/tags', { slug }, schemaTag ?? { name: slug, slug, color: '9e9e9e' }, `tag ${slug}`);
    tagIds.set(slug, tag.id);
  }

  // --- site, roles, types -------------------------------------------------------
  const site = await ensure('dcim/sites', { slug: inv.site.slug }, { name: inv.site.name, slug: inv.site.slug, status: 'active' }, `site ${inv.site.name}`);
  const roles = new Map<string, Obj>();
  for (const slug of new Set(inv.devices.map((d) => d.role))) {
    roles.set(slug, await ensure('dcim/device-roles', { slug }, { name: titleCase(slug), slug, color: ROLE_COLORS[slug] ?? '9e9e9e' }, `role ${slug}`));
  }
  const mfrs = new Map<string, Obj>();
  for (const name of new Set(inv.devices.map((d) => d.manufacturer))) {
    mfrs.set(name, await ensure('dcim/manufacturers', { slug: slugify(name) }, { name, slug: slugify(name) }, `manufacturer ${name}`));
  }
  const types = new Map<string, Obj>();
  for (const d of inv.devices) {
    const key = `${d.manufacturer}|${d.model}`;
    if (types.has(key)) continue;
    const mfr = mfrs.get(d.manufacturer)!;
    types.set(key, await ensure('dcim/device-types', { manufacturer_id: mfr.id, slug: slugify(d.model) }, { manufacturer: mfr.id, model: d.model, slug: slugify(d.model) }, `device type ${d.model}`));
  }

  // --- devices and their ports --------------------------------------------------
  const devices = new Map<string, Obj>();
  const ports = new Map<string, Obj & { _kind: string }>(); // "device/port" → interface / front / rear port
  const portKey = (e: InvEnd) => `${e.device}/${e.port}`;
  for (const d of inv.devices) {
    const body = {
      name: d.name,
      role: roles.get(d.role)!.id,
      device_type: types.get(`${d.manufacturer}|${d.model}`)!.id,
      site: site.id,
      status: d.status,
      tags: d.tags.map((t) => tagIds.get(t)!),
    };
    let dev = await find('dcim/devices', { site_id: site.id, name: d.name });
    if (!dev) dev = await create('dcim/devices', body, `device ${d.name}`);
    else {
      const drift: Record<string, unknown> = {};
      if ((dev.role as Ref)?.id !== body.role) drift.role = body.role;
      if ((dev.device_type as Ref)?.id !== body.device_type) drift.device_type = body.device_type;
      if ((dev.status as { value?: string })?.value !== d.status) drift.status = d.status;
      const have = ((dev.tags as Ref[]) ?? []).map((t) => t!.id);
      const merged = [...new Set([...have, ...body.tags])];
      if (!sameIds(have, merged)) drift.tags = merged; // add tags, never remove ones set in NetBox
      if (Object.keys(drift).length) await update('dcim/devices', dev, drift, `device ${d.name}`);
      else report.unchanged++;
    }
    devices.set(d.name, dev);

    const existing = new Map((isFake(dev.id) ? [] : await nb.list<Obj>('dcim/interfaces', { device_id: dev.id })).map((i) => [i.name as string, i]));
    // LAGs first so members can point at them.
    for (const i of [...d.interfaces].sort((a, b) => Number(b.type === 'lag') - Number(a.type === 'lag'))) {
      const lagId = i.lag ? ports.get(`${d.name}/${i.lag}`)?.id : undefined;
      const body: Record<string, unknown> = { device: dev.id, name: i.name, type: i.type };
      if (lagId != null) body.lag = lagId;
      if (i.mgmtOnly) body.mgmt_only = true;
      if (i.speedKbps) body.speed = i.speedKbps;
      let obj = existing.get(i.name);
      if (!obj) obj = await create('dcim/interfaces', body, `interface ${d.name}/${i.name}`);
      else {
        const drift: Record<string, unknown> = {};
        if ((obj.type as { value?: string })?.value !== i.type) drift.type = i.type;
        if (lagId != null && (obj.lag as Ref)?.id !== lagId) drift.lag = lagId;
        if (Object.keys(drift).length) await update('dcim/interfaces', obj, drift, `interface ${d.name}/${i.name}`);
        else report.unchanged++;
      }
      ports.set(`${d.name}/${i.name}`, { ...obj, _kind: 'dcim.interface' });
    }

    if (d.passThroughPorts > 0) {
      const rears = new Map((isFake(dev.id) ? [] : await nb.list<Obj>('dcim/rear-ports', { device_id: dev.id })).map((p) => [p.name as string, p]));
      const fronts = new Map((isFake(dev.id) ? [] : await nb.list<Obj>('dcim/front-ports', { device_id: dev.id })).map((p) => [p.name as string, p]));
      for (let n = 1; n <= d.passThroughPorts; n++) {
        let rear = rears.get(`R${n}`);
        if (!rear) rear = await create('dcim/rear-ports', { device: dev.id, name: `R${n}`, type: '8p8c', positions: 1 }, `rear port ${d.name}/R${n}`);
        else report.unchanged++;
        let front = fronts.get(`F${n}`);
        if (!front) {
          const label = `front port ${d.name}/F${n}`;
          front = dry
            ? await create('dcim/front-ports', {}, label)
            : await create('dcim/front-ports', { device: dev.id, name: `F${n}`, type: '8p8c', rear_ports: [{ position: 1, rear_port: rear.id, rear_port_position: 1 }] }, label).catch(
                // Before NetBox 4.7 a front port maps to one rear port directly.
                (err) => {
                  if (!(err instanceof NetBoxError) || err.status !== 400) throw err;
                  return nb.post<Obj>('dcim/front-ports/', { device: dev.id, name: `F${n}`, type: '8p8c', rear_port: rear.id, rear_port_position: 1 });
                },
              );
        } else report.unchanged++;
        ports.set(`${d.name}/R${n}`, { ...rear, _kind: 'dcim.rearport' });
        ports.set(`${d.name}/F${n}`, { ...front, _kind: 'dcim.frontport' });
      }
    }

    // Primary IP on its interface.
    if (d.ip) {
      const iface = ports.get(`${d.name}/${d.ip.iface}`)!;
      let ip = await find('ipam/ip-addresses', { address: d.ip.address });
      const assignedTo = (ip?.assigned_object_id as number | null) ?? null;
      if (!ip) {
        ip = await create('ipam/ip-addresses', { address: d.ip.address, status: 'active', assigned_object_type: 'dcim.interface', assigned_object_id: iface.id }, `IP ${d.ip.address} on ${d.name}/${d.ip.iface}`);
      } else if (assignedTo !== iface.id) {
        if (assignedTo == null) await update('ipam/ip-addresses', ip, { assigned_object_type: 'dcim.interface', assigned_object_id: iface.id }, `IP ${d.ip.address}`);
        else report.warnings.push(`${d.ip.address} is already assigned to something else in NetBox; ${d.name}'s primary IP left as is.`);
      } else report.unchanged++;
      const field = d.ip.address.includes(':') ? 'primary_ip6' : 'primary_ip4';
      if (ip && (ip.assigned_object_id === iface.id || isFake(ip.id) || dry) && (dev[field] as Ref)?.id !== ip.id) {
        await update('dcim/devices', dev, { [field]: ip.id }, `device ${d.name} primary IP`);
      }
    }
  }

  // --- cabling ---------------------------------------------------------------------
  const peerName = (p: Obj): string | undefined => {
    const peers = (p.link_peers as Ref[] | undefined) ?? [];
    const peer = peers[0];
    return peer ? `${peer.device?.name ?? '?'}/${peer.name ?? '?'}` : undefined;
  };
  const cable = async (aType: string, aId: number, bType: string, bId: number, label: string) => {
    await create('dcim/cables', {
      a_terminations: [{ object_type: aType, object_id: aId }],
      b_terminations: [{ object_type: bType, object_id: bId }],
      status: 'connected',
    }, `cable ${label}`);
  };

  if (inv.internet) {
    const n = inv.internet;
    const provider = await ensure('circuits/providers', { slug: slugify(n.provider) }, { name: n.provider, slug: slugify(n.provider) }, `provider ${n.provider}`);
    const ctype = await ensure('circuits/circuit-types', { slug: 'internet' }, { name: 'Internet', slug: 'internet' }, 'circuit type Internet');
    const circuit = await ensure('circuits/circuits', { provider_id: provider.id, cid: n.cid }, {
      cid: n.cid, provider: provider.id, type: ctype.id, status: 'active', commit_rate: n.downloadKbps,
    }, `circuit ${n.cid}`);
    let term = await find('circuits/circuit-terminations', { circuit_id: circuit.id, term_side: 'A' });
    if (!term) {
      term = await create('circuits/circuit-terminations', {
        circuit: circuit.id, term_side: 'A', termination_type: 'dcim.site', termination_id: site.id,
        port_speed: n.downloadKbps, upstream_speed: n.uploadKbps,
      }, `circuit termination ${n.cid} A`);
    } else if ((term.port_speed ?? null) !== (n.downloadKbps ?? null) || (term.upstream_speed ?? null) !== (n.uploadKbps ?? null)) {
      await update('circuits/circuit-terminations', term, { port_speed: n.downloadKbps ?? null, upstream_speed: n.uploadKbps ?? null }, `circuit termination ${n.cid} A`);
    } else report.unchanged++;
    const wan = ports.get(portKey(n.connect))!;
    if (wan.cable) {
      if (wan.link_peers_type === 'circuits.circuittermination') report.unchanged++;
      else report.warnings.push(`${portKey(n.connect)} is cabled to ${peerName(wan)} in NetBox, not the ISP circuit — left as is.`);
    } else if (term.cable) {
      report.warnings.push(`Circuit ${n.cid} is already cabled elsewhere in NetBox — left as is.`);
    } else {
      await cable('circuits.circuittermination', term.id, 'dcim.interface', wan.id, `${n.cid} → ${portKey(n.connect)}`);
    }
  }

  for (const [a, b] of inv.cables) {
    const pa = ports.get(portKey(a))!;
    const pb = ports.get(portKey(b))!;
    if (pa.cable || pb.cable) {
      const already = peerName(pa) === portKey(b) || peerName(pb) === portKey(a);
      if (already) report.unchanged++;
      else {
        const [busy, other] = pa.cable ? [a, pa] : [b, pb];
        report.warnings.push(`${portKey(busy)} is cabled to ${peerName(other) ?? 'something else'} in NetBox; skipped ${portKey(a)} -- ${portKey(b)}.`);
      }
      continue;
    }
    await cable(pa._kind, pa.id, pb._kind, pb.id, `${portKey(a)} -- ${portKey(b)}`);
  }

  for (const w of inv.wireless) {
    const pa = ports.get(portKey(w.a))!;
    const pb = ports.get(portKey(w.b))!;
    if (pa.wireless_link || pb.wireless_link) {
      report.unchanged++;
      continue;
    }
    await create('wireless/wireless-links', { interface_a: pa.id, interface_b: pb.id, ssid: w.ssid ?? '', status: 'connected' }, `wireless link ${portKey(w.a)} ~ ${portKey(w.b)}`);
  }

  // --- service tiles ---------------------------------------------------------------
  const cf = (s: Inventory['services'][number]) =>
    Object.fromEntries(
      Object.entries({ dashboard_app: s.app, dashboard_container: s.container, dashboard_expect: s.expect, dashboard_health_url: s.healthUrl }).filter(([, v]) => v != null),
    );
  const svcTags = (s: Inventory['services'][number]) => [tagIds.get('dashboard')!, ...(s.vpn ? [tagIds.get('vpn')!] : [])];

  const containers = inv.services.filter((s) => s.kind === 'container');
  if (containers.length) {
    const ctype = await ensure('virtualization/cluster-types', { slug: 'docker' }, { name: 'Docker', slug: 'docker' }, 'cluster type Docker');
    const clusters = new Map<string, number>();
    for (const host of new Set(containers.map((s) => s.host))) {
      const dev = devices.get(host)!;
      const current = dev.cluster as Ref;
      if (current?.id) {
        clusters.set(host, current.id); // already in a cluster (e.g. Proxmox): use it
        continue;
      }
      const cluster = await ensure('virtualization/clusters', { name: `docker@${host}` }, {
        name: `docker@${host}`, type: ctype.id, status: 'active', scope_type: 'dcim.site', scope_id: site.id,
      }, `cluster docker@${host}`);
      await update('dcim/devices', dev, { cluster: cluster.id }, `device ${host} cluster`);
      clusters.set(host, cluster.id);
    }
    for (const s of containers) {
      const clusterId = clusters.get(s.host)!;
      const vm = await find('virtualization/virtual-machines', { cluster_id: clusterId, name: s.name });
      const body = { name: s.name, cluster: clusterId, device: devices.get(s.host)!.id, status: 'active', tags: svcTags(s), custom_fields: cf(s) };
      if (!vm) await create('virtualization/virtual-machines', body, `container ${s.name} on ${s.host}`);
      else await reconcileTile('virtualization/virtual-machines', vm, body, `container ${s.name}`);
    }
  }

  for (const s of inv.services.filter((x) => x.kind === 'service')) {
    const dev = devices.get(s.host)!;
    const existing = isFake(dev.id) ? [] : (await nb.list<Obj>('ipam/services', { name: s.name })).filter(
      (x) => ((x.parent as Ref)?.id ?? (x.device as Ref)?.id) === dev.id,
    );
    const body = { name: s.name, protocol: s.protocol, ports: s.ports, tags: svcTags(s), custom_fields: cf(s) };
    if (existing[0]) {
      await reconcileTile('ipam/services', existing[0], body, `service ${s.name}`);
      continue;
    }
    const label = `service ${s.name} on ${s.host}`;
    if (dry) {
      await create('ipam/services', body, label);
      continue;
    }
    // NetBox 4.3+ attaches services through parent_object_*; older versions take `device`.
    await create('ipam/services', { ...body, parent_object_type: 'dcim.device', parent_object_id: dev.id }, label).catch((err) => {
      if (!(err instanceof NetBoxError) || err.status !== 400) throw err;
      return nb.post('ipam/services/', { ...body, device: dev.id });
    });
  }

  return report;

  async function reconcileTile(path: string, obj: Obj, body: { tags: number[]; custom_fields: Record<string, unknown> }, label: string) {
    const drift: Record<string, unknown> = {};
    const have = ((obj.tags as Ref[]) ?? []).map((t) => t!.id);
    const merged = [...new Set([...have, ...body.tags])];
    if (!sameIds(have, merged)) drift.tags = merged;
    const cur = (obj.custom_fields as Record<string, unknown>) ?? {};
    const val = (v: unknown) => (v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v);
    const cfDrift = Object.fromEntries(Object.entries(body.custom_fields).filter(([k, v]) => val(cur[k]) !== v));
    if (Object.keys(cfDrift).length) drift.custom_fields = cfDrift;
    if (Object.keys(drift).length) await update(path, obj, drift, label);
    else report.unchanged++;
  }
}
