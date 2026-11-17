import { describe, expect, it } from 'vitest';
import { buildFromInventory, ifaceSpeed, kindForRole, mediumForSpeed } from '../topology.ts';
import type { NbInterface } from '../types.ts';
import { inventory } from './fixture.ts';

const nodeOf = (lab: ReturnType<typeof buildFromInventory>, id: string) => lab.nodes.find((n) => n.id === id)!;

describe('buildFromInventory (recorded NetBox 4.7 data)', () => {
  const lab = buildFromInventory(inventory());

  it('roots the tree at the internet circuit, with the plan speed from the circuit', () => {
    expect(nodeOf(lab, 'internet')).toMatchObject({ kind: 'internet', sublabel: 'Example ISP' });
    expect(nodeOf(lab, 'gw-01')).toMatchObject({
      kind: 'router',
      parent: 'internet',
      link: { medium: '10G', speed: 1e9, measure: 'gw-01/wan0', port: 'gw-01 · wan0 (EX-1000)' },
    });
    expect(lab.provider).toBe('Example ISP');
  });

  it('builds the tree from traced cable paths', () => {
    const parents = Object.fromEntries(lab.nodes.map((n) => [n.id, n.parent]));
    expect(parents).toEqual({
      internet: undefined,
      'gw-01': 'internet',
      'sw-core': 'gw-01',
      'sw-rack': 'sw-core',
      'sw-desk': 'sw-core',
      'srv-01': 'sw-rack',
      'srv-02': 'sw-rack',
      'nas-01': 'sw-rack',
      'ws-01': 'sw-desk',
      'printer-01': 'sw-desk', // through the patch panel
      'ap-hall': 'sw-desk',
      'ap-garage': 'ap-hall', // over the wireless link
    });
    expect(lab.nodes.some((n) => n.id === 'pp-01')).toBe(false); // patch panels aren't nodes
  });

  it('measures each link at the parent port, with the far end as fallback', () => {
    expect(nodeOf(lab, 'printer-01').link).toMatchObject({ medium: '1G', measure: 'sw-desk/port2', alt: 'printer-01/eth0' });
    expect(nodeOf(lab, 'sw-rack').link).toMatchObject({ medium: '10G', speed: 10e9, measure: 'sw-core/sfp2', alt: 'sw-rack/sfp1' });
  });

  it('merges a LAG into one bonded link with every member port', () => {
    expect(nodeOf(lab, 'srv-01').link).toMatchObject({
      medium: '2.5G',
      bonded: true,
      speed: 5e9,
      measure: ['sw-rack/port1', 'sw-rack/port2'],
      alt: ['srv-01/eth0', 'srv-01/eth1'],
    });
  });

  it('marks wireless backhaul as Wi-Fi', () => {
    expect(nodeOf(lab, 'ap-garage')).toMatchObject({ kind: 'mesh', link: { medium: 'wifi', measure: 'ap-hall/wlan0' } });
  });

  it('maps roles, models, IPs and NetBox links onto nodes', () => {
    expect(nodeOf(lab, 'nas-01')).toMatchObject({ kind: 'nas', model: 'Generic NAS 6-bay', ip: '10.20.0.16', role: 'NAS' });
    expect(nodeOf(lab, 'ws-01').kind).toBe('laptop');
    expect(nodeOf(lab, 'srv-02').href).toMatch(/\/dcim\/devices\/\d+\/$/);
  });

  it('turns tagged VMs and services into tiles, honouring vpn and expected state', () => {
    const byLabel = Object.fromEntries(lab.services.map((s) => [s.label, s]));
    expect(Object.keys(byLabel).sort()).toEqual(
      ['Backups', 'Grafana', 'Home Assistant', 'Jellyfin', 'Nextcloud', 'Pi-hole', 'SMB shares', 'Uptime Kuma', 'qBittorrent'].sort(),
    );
    expect(byLabel['Home Assistant']).toMatchObject({ id: 'home-assistant', host: 'srv-01', app: 'home-assistant', container: 'homeassistant' });
    expect(byLabel['qBittorrent']).toMatchObject({ vpn: true, app: 'qbittorrent' });
    expect(byLabel['Uptime Kuma'].expect).toBe('manual'); // select field arrives as {value, label}
    expect(byLabel['Backups']).toMatchObject({ host: 'srv-02', expect: 'paused' });
    expect(byLabel['SMB shares'].host).toBe('nas-01');
  });

  it('derives collector targets from tags and primary IPs', () => {
    const cfgd = buildFromInventory(inventory(), { collectors: { snmp: { version: '3', user: 'mon' }, glances: { port: 9999 } } });
    const ids = cfgd.collectors.map((c) => c.id).sort();
    expect(ids).toEqual(['glances-srv-01', 'glances-srv-02', 'ping', 'snmp-sw-core', 'snmp-sw-desk', 'snmp-sw-rack']);
    expect(cfgd.collectors.find((c) => c.id === 'snmp-sw-core')).toEqual({ id: 'snmp-sw-core', kind: 'snmp', device: 'sw-core', host: '10.20.0.11', version: '3', user: 'mon' });
    expect(cfgd.collectors.find((c) => c.id === 'glances-srv-01')).toMatchObject({ host: 'srv-01', url: 'http://10.20.0.14:9999' });
    expect(cfgd.collectors.find((c) => c.id === 'ping')).toMatchObject({ targets: { internet: '1.1.1.1', router: '10.20.0.10' } });
    const none = buildFromInventory(inventory(), { collectors: { snmp: false, glances: false, ping: false } });
    expect(none.collectors).toEqual([]);
  });

  it('has nothing to warn about for a fully modelled lab', () => {
    expect(lab.warnings).toEqual([]);
  });
});

describe('buildFromInventory edge cases', () => {
  it('falls back to a router-role device and says how to add the circuit', () => {
    const inv = inventory();
    for (const i of inv.interfaces) {
      if (i.link_peers_type === 'circuits.circuittermination') {
        i.link_peers_type = null;
        i.link_peers = [];
      }
    }
    const lab = buildFromInventory(inv);
    expect(lab.nodes.find((n) => n.id === 'gw-01')).toMatchObject({ parent: 'internet', link: { measure: undefined } });
    expect(lab.warnings.join(' ')).toMatch(/No circuit is cabled.*gw-01's WAN port/);
  });

  it('lists devices that are not cabled to anything', () => {
    const inv = inventory();
    const ws = inv.interfaces.find((i) => i.device.name === 'ws-01')!;
    const sw = inv.interfaces.find((i) => i.device.name === 'sw-desk' && i.name === 'port1')!;
    for (const i of [ws, sw]) Object.assign(i, { connected_endpoints: [], connected_endpoints_type: null, connected_endpoints_reachable: false });
    const lab = buildFromInventory(inv);
    expect(lab.nodes.some((n) => n.id === 'ws-01')).toBe(false);
    expect(lab.warnings.join(' ')).toMatch(/not on the map: ws-01/);
  });

  it('keeps only the fastest of parallel cables that are not a LAG', () => {
    const inv = inventory();
    for (const i of inv.interfaces) if (i.device.name === 'srv-01' && i.lag) i.lag = null;
    const eth1 = inv.interfaces.find((i) => i.device.name === 'srv-01' && i.name === 'eth1')!;
    eth1.type = { value: '1000base-t' };
    const lab = buildFromInventory(inv);
    expect(lab.nodes.find((n) => n.id === 'srv-01')!.link).toMatchObject({ measure: 'sw-rack/port1', medium: '2.5G' });
    expect(lab.nodes.find((n) => n.id === 'srv-01')!.link!.bonded).toBeUndefined();
  });

  it('skips devices with an excluded status, and their links', () => {
    const inv = inventory();
    inv.devices.find((d) => d.name === 'printer-01')!.status = { value: 'planned' };
    const lab = buildFromInventory(inv);
    expect(lab.nodes.some((n) => n.id === 'printer-01')).toBe(false);
    expect(lab.warnings).toEqual([]);
  });

  it('ignores tagged VMs and services that belong to other sites', () => {
    const inv = inventory();
    inv.vms.push({ id: 9001, name: 'Elsewhere', device: { id: 777, name: 'branch-srv' }, tags: [{ slug: 'dashboard' }] });
    inv.services.push({ id: 9002, name: 'Other', parent_object_type: 'dcim.device', parent: { id: 778, name: 'branch-nas' }, tags: [{ slug: 'dashboard' }] });
    const lab = buildFromInventory(inv);
    expect(lab.services.some((s) => s.label === 'Elsewhere' || s.label === 'Other')).toBe(false);
    expect(lab.warnings).toEqual([]);
  });

  it('honours role overrides', () => {
    const lab = buildFromInventory(inventory(), { roles: { workstation: 'host' } });
    expect(lab.nodes.find((n) => n.id === 'ws-01')!.kind).toBe('host');
  });
});

describe('helpers', () => {
  it('guesses kinds from role slugs', () => {
    expect(kindForRole('core-switch')).toBe('switch');
    expect(kindForRole('edge-firewall')).toBe('router');
    expect(kindForRole('wifi-ap')).toBe('mesh');
    expect(kindForRole('proxmox-node')).toBe('host');
    expect(kindForRole('backup-storage')).toBe('nas');
    expect(kindForRole('kitchen-tablet')).toBe('device');
    expect(kindForRole(undefined)).toBe('device');
  });

  it('reads interface speed from the speed field or the type', () => {
    const i = (value: string, speed?: number) => ({ id: 1, name: 'x', device: { id: 1 }, type: { value }, speed }) as NbInterface;
    expect(ifaceSpeed(i('2.5gbase-t'))).toBe(2.5e9);
    expect(ifaceSpeed(i('1000base-x-sfp'))).toBe(1e9);
    expect(ifaceSpeed(i('100base-tx'))).toBe(100e6);
    expect(ifaceSpeed(i('25gbase-x-sfp28'))).toBe(25e9);
    expect(ifaceSpeed(i('virtual'))).toBeNull();
    expect(ifaceSpeed(i('1000base-t', 100_000))).toBe(100e6); // configured speed wins
    expect(mediumForSpeed(5e9)).toBe('5G');
    expect(mediumForSpeed(null)).toBe('1G');
  });
});
