// Seeds a fictional "Demo Lab" site into a NetBox you use for testing.
//   NETBOX_URL=http://localhost:8000 NETBOX_TOKEN=… npx tsx scripts/netbox-seed-demo.ts --confirm
// It exercises every modelling case the dashboard reads: an internet circuit, a LAG bond,
// a patch panel, a wireless mesh link, containers as VMs, and IPAM services.

import { NetBoxClient } from '../server/netbox/client.ts';
import { ensureSchema } from '../server/netbox/bootstrap.ts';

if (!process.argv.includes('--confirm')) {
  console.error('This creates a fictional "Demo Lab" site and its devices. Re-run with --confirm on a test NetBox.');
  process.exit(1);
}

const nb = new NetBoxClient({ url: process.env.NETBOX_URL ?? 'http://localhost:8000', token: process.env.NETBOX_TOKEN ?? '' });
type Obj = { id: number; [k: string]: unknown };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function ensure(path: string, lookup: Record<string, string>, body: Record<string, unknown>): Promise<Obj> {
  const found = await nb.list<Obj>(path, lookup);
  if (found[0]) return found[0];
  return nb.post<Obj>(`${path}/`, body);
}

async function main() {
  await ensureSchema(nb, (m) => console.log(`  ${m}`));
  const tag = async (s: string) => (await nb.list<Obj>('extras/tags', { slug: s }))[0].id;
  const tags = { dashboard: await tag('dashboard'), vpn: await tag('vpn'), snmp: await tag('snmp'), glances: await tag('glances') };

  if ((await nb.list<Obj>('dcim/sites', { slug: 'demo-lab' })).length) {
    console.log('Demo Lab already exists — nothing to do.');
    return;
  }
  const site = await nb.post<Obj>('dcim/sites/', { name: 'Demo Lab', slug: 'demo-lab', status: 'active' });

  const roles: Record<string, Obj> = {};
  for (const [name, color] of [
    ['Router', 'f44336'], ['Switch', '2196f3'], ['Access Point', '00bcd4'], ['Server', '4caf50'],
    ['NAS', '9c27b0'], ['Workstation', '607d8b'], ['Printer', '795548'], ['Patch Panel', '9e9e9e'],
  ]) {
    roles[name] = await ensure('dcim/device-roles', { slug: slug(name) }, { name, slug: slug(name), color });
  }
  const mfr = await ensure('dcim/manufacturers', { slug: 'generic' }, { name: 'Generic', slug: 'generic' });
  const types: Record<string, Obj> = {};
  for (const model of ['Router 10G', 'Switch 4x10G', 'Switch 8x2.5G', 'Switch 8x1G', 'Wi-Fi 7 AP', 'Mini Server', 'NAS 6-bay', 'Desktop', 'Laser Printer', '12-port Patch Panel']) {
    types[model] = await ensure('dcim/device-types', { slug: slug(model) }, { manufacturer: mfr.id, model, slug: slug(model) });
  }

  const devices: Record<string, Obj> = {};
  const device = async (name: string, role: string, type: string, extra: Record<string, unknown> = {}) => {
    devices[name] = await nb.post<Obj>('dcim/devices/', { name, role: roles[role].id, device_type: types[type].id, site: site.id, status: 'active', ...extra });
    return devices[name];
  };
  const ifaces: Record<string, Obj> = {};
  const iface = async (dev: string, name: string, type: string, extra: Record<string, unknown> = {}) => {
    ifaces[`${dev}/${name}`] = await nb.post<Obj>('dcim/interfaces/', { device: devices[dev].id, name, type, ...extra });
    return ifaces[`${dev}/${name}`];
  };
  const cable = (a: [string, number], b: [string, number]) =>
    nb.post('dcim/cables/', {
      a_terminations: [{ object_type: a[0], object_id: a[1] }],
      b_terminations: [{ object_type: b[0], object_id: b[1] }],
      status: 'connected',
    });
  const link = (a: string, b: string) => cable(['dcim.interface', ifaces[a].id], ['dcim.interface', ifaces[b].id]);
  let host = 10;
  const ip = async (dev: string, ifName: string) => {
    const addr = await nb.post<Obj>('ipam/ip-addresses/', {
      address: `10.20.0.${host++}/24`, status: 'active', assigned_object_type: 'dcim.interface', assigned_object_id: ifaces[`${dev}/${ifName}`].id,
    });
    await nb.patch(`dcim/devices/${devices[dev].id}/`, { primary_ip4: addr.id });
  };

  // --- devices ------------------------------------------------------------
  await device('gw-01', 'Router', 'Router 10G');
  await iface('gw-01', 'wan0', '10gbase-t');
  await iface('gw-01', 'lan0', '10gbase-x-sfpp');
  await iface('gw-01', 'wlan0', 'ieee802.11be');
  await ip('gw-01', 'lan0');

  await device('sw-core', 'Switch', 'Switch 4x10G', { tags: [tags.snmp] });
  for (const p of ['sfp1', 'sfp2', 'sfp3', 'sfp4']) await iface('sw-core', p, '10gbase-x-sfpp');
  await iface('sw-core', 'mgmt', '1000base-t', { mgmt_only: true });
  await ip('sw-core', 'mgmt');

  await device('sw-rack', 'Switch', 'Switch 8x2.5G', { tags: [tags.snmp] });
  for (let i = 1; i <= 8; i++) await iface('sw-rack', `port${i}`, '2.5gbase-t');
  await iface('sw-rack', 'sfp1', '10gbase-x-sfpp');
  await ip('sw-rack', 'port8');

  await device('sw-desk', 'Switch', 'Switch 8x1G', { tags: [tags.snmp] });
  for (let i = 1; i <= 8; i++) await iface('sw-desk', `port${i}`, '1000base-t');
  await iface('sw-desk', 'sfp1', '10gbase-x-sfpp');
  await ip('sw-desk', 'port8');

  await device('ap-hall', 'Access Point', 'Wi-Fi 7 AP');
  await iface('ap-hall', 'eth0', '2.5gbase-t');
  await iface('ap-hall', 'wlan0', 'ieee802.11be');
  await device('ap-garage', 'Access Point', 'Wi-Fi 7 AP');
  await iface('ap-garage', 'wlan0', 'ieee802.11be');

  await device('srv-01', 'Server', 'Mini Server', { tags: [tags.glances] });
  const bond = await iface('srv-01', 'bond0', 'lag');
  await iface('srv-01', 'eth0', '2.5gbase-t', { lag: bond.id });
  await iface('srv-01', 'eth1', '2.5gbase-t', { lag: bond.id });
  await ip('srv-01', 'bond0');

  await device('srv-02', 'Server', 'Mini Server', { tags: [tags.glances] });
  await iface('srv-02', 'eth0', '2.5gbase-t');
  await ip('srv-02', 'eth0');

  await device('nas-01', 'NAS', 'NAS 6-bay');
  await iface('nas-01', 'eth0', '2.5gbase-t');
  await ip('nas-01', 'eth0');

  await device('ws-01', 'Workstation', 'Desktop');
  await iface('ws-01', 'eth0', '1000base-t');

  await device('printer-01', 'Printer', 'Laser Printer');
  await iface('printer-01', 'eth0', '1000base-t');

  // A patch panel between the desk switch and the printer: the dashboard must trace through it.
  await device('pp-01', 'Patch Panel', '12-port Patch Panel');
  const rear = await nb.post<Obj>('dcim/rear-ports/', { device: devices['pp-01'].id, name: 'R1', type: '8p8c', positions: 1 });
  // NetBox 4.7 maps front→rear through a `rear_ports` list; older versions take `rear_port` directly.
  // Try the new shape first: older servers reject it, while 4.7 would silently ignore the old one.
  const front = await nb
    .post<Obj>('dcim/front-ports/', {
      device: devices['pp-01'].id, name: 'F1', type: '8p8c', rear_ports: [{ position: 1, rear_port: rear.id, rear_port_position: 1 }],
    })
    .catch(() =>
      nb.post<Obj>('dcim/front-ports/', { device: devices['pp-01'].id, name: 'F1', type: '8p8c', rear_port: rear.id, rear_port_position: 1 }),
    );

  // --- cables ---------------------------------------------------------------
  const provider = await ensure('circuits/providers', { slug: 'example-isp' }, { name: 'Example ISP', slug: 'example-isp' });
  const ctype = await ensure('circuits/circuit-types', { slug: 'internet' }, { name: 'Internet', slug: 'internet' });
  const circuit = await nb.post<Obj>('circuits/circuits/', { cid: 'EX-1000', provider: provider.id, type: ctype.id, status: 'active', commit_rate: 1_000_000 });
  const term = await nb.post<Obj>('circuits/circuit-terminations/', {
    circuit: circuit.id, term_side: 'A', termination_type: 'dcim.site', termination_id: site.id, port_speed: 1_000_000, upstream_speed: 50_000,
  });
  await cable(['circuits.circuittermination', term.id], ['dcim.interface', ifaces['gw-01/wan0'].id]);

  await link('gw-01/lan0', 'sw-core/sfp1');
  await link('sw-core/sfp2', 'sw-rack/sfp1');
  await link('sw-core/sfp3', 'sw-desk/sfp1');
  await link('sw-rack/port1', 'srv-01/eth0');
  await link('sw-rack/port2', 'srv-01/eth1');
  await link('sw-rack/port3', 'srv-02/eth0');
  await link('sw-rack/port4', 'nas-01/eth0');
  await link('sw-desk/port1', 'ws-01/eth0');
  await cable(['dcim.interface', ifaces['sw-desk/port2'].id], ['dcim.frontport', front.id]);
  await cable(['dcim.rearport', rear.id], ['dcim.interface', ifaces['printer-01/eth0'].id]);
  await link('sw-desk/port7', 'ap-hall/eth0');
  await nb.post('wireless/wireless-links/', {
    interface_a: ifaces['ap-hall/wlan0'].id, interface_b: ifaces['ap-garage/wlan0'].id, ssid: 'demo-backhaul', status: 'connected',
  });

  // --- containers (as VMs) and services --------------------------------------
  const clusterType = await ensure('virtualization/cluster-types', { slug: 'docker' }, { name: 'Docker', slug: 'docker' });
  const cluster = await nb.post<Obj>('virtualization/clusters/', {
    name: 'docker@srv-01', type: clusterType.id, status: 'active', scope_type: 'dcim.site', scope_id: site.id,
  });
  await nb.patch(`dcim/devices/${devices['srv-01'].id}/`, { cluster: cluster.id });
  const vm = (name: string, cf: Record<string, string>, extraTags: number[] = []) =>
    nb.post('virtualization/virtual-machines/', {
      name, cluster: cluster.id, device: devices['srv-01'].id, status: 'active', tags: [tags.dashboard, ...extraTags], custom_fields: cf,
    });
  await vm('Home Assistant', { dashboard_app: 'home-assistant', dashboard_container: 'homeassistant' });
  await vm('Grafana', { dashboard_app: 'grafana' });
  await vm('Pi-hole', { dashboard_app: 'pihole' });
  await vm('Jellyfin', { dashboard_app: 'jellyfin' });
  await vm('Nextcloud', { dashboard_app: 'nextcloud' });
  await vm('qBittorrent', { dashboard_app: 'qbittorrent' }, [tags.vpn]);
  await vm('Uptime Kuma', { dashboard_app: 'uptime-kuma', dashboard_expect: 'manual' });
  await nb.post('virtualization/virtual-machines/', { name: 'scratch', cluster: cluster.id, device: devices['srv-01'].id, status: 'active' }); // untagged: not a tile

  const service = (dev: string, name: string, protocol: string, ports: number[], cf: Record<string, string> = {}) =>
    nb.post('ipam/services/', {
      parent_object_type: 'dcim.device', parent_object_id: devices[dev].id, name, protocol, ports, tags: [tags.dashboard], custom_fields: cf,
    });
  await service('nas-01', 'SMB shares', 'tcp', [445], { dashboard_app: 'smb' });
  await service('srv-02', 'Backups', 'tcp', [8200], { dashboard_app: 'duplicati', dashboard_expect: 'paused' });
  await nb.post('ipam/services/', { parent_object_type: 'dcim.device', parent_object_id: devices['srv-02'].id, name: 'SSH', protocol: 'tcp', ports: [22] }); // untagged

  console.log(`Seeded Demo Lab: ${Object.keys(devices).length} devices, ${Object.keys(ifaces).length} interfaces.`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
