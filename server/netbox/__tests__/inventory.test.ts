import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expandRange, parseInventory, rateKbps } from '../inventory.ts';

const demo = () => readFileSync(new URL('../../../examples/demo-lab.inventory.yaml', import.meta.url), 'utf8');
const lab = (devices: string, rest = '') => `site: Home\ndevices:\n${devices}\n${rest}`;

describe('parseInventory', () => {
  it('reads the example inventory', () => {
    const inv = parseInventory(demo());
    expect(inv.site).toEqual({ name: 'Demo Lab', slug: 'demo-lab' });
    expect(inv.devices.map((d) => d.name)).toContain('pp-01');
    expect(inv.devices.find((d) => d.name === 'sw-rack')!.interfaces.map((i) => i.name)).toEqual([
      'port1', 'port2', 'port3', 'port4', 'port5', 'port6', 'port7', 'port8', 'sfp1',
    ]);
    expect(inv.devices.find((d) => d.name === 'srv-01')!.interfaces.find((i) => i.name === 'eth1')).toMatchObject({ type: '2.5gbase-t', lag: 'bond0' });
    expect(inv.devices.find((d) => d.name === 'sw-core')!.ip).toEqual({ address: '10.20.0.11/24', iface: 'mgmt' });
    expect(inv.internet).toMatchObject({ provider: 'Example ISP', cid: 'EX-1000', downloadKbps: 1_000_000, uploadKbps: 50_000, connect: { device: 'gw-01', port: 'wan0' } });
    expect(inv.cables).toHaveLength(11);
    expect(inv.cables[8]).toEqual([{ device: 'sw-desk', port: 'port2' }, { device: 'pp-01', port: 'F1' }]);
    expect(inv.wireless[0]).toMatchObject({ ssid: 'demo-backhaul' });
    const tiles = Object.fromEntries(inv.services.map((s) => [s.name, s]));
    expect(tiles['Home Assistant']).toMatchObject({ kind: 'container', host: 'srv-01', container: 'homeassistant' });
    expect(tiles['SMB shares']).toMatchObject({ kind: 'service', ports: [445], protocol: 'tcp' });
    expect(tiles['qBittorrent'].vpn).toBe(true);
    expect(tiles['Backups'].expect).toBe('paused');
  });

  it('defaults the model and manufacturer, and slugs roles', () => {
    const inv = parseInventory(lab('  box:\n    role: Edge Firewall\n'));
    expect(inv.devices[0]).toMatchObject({ role: 'edge-firewall', model: 'Generic Edge Firewall', manufacturer: 'Generic', status: 'active' });
  });

  it('explains mistakes with the path to the problem', () => {
    expect(() => parseInventory(lab('  sw:\n    model: x\n'))).toThrow('devices.sw: role is required');
    expect(() => parseInventory(lab('  sw:\n    role: switch\n    ip: 10.0.0.2 on eth0\n    interfaces: { eth0: 1000base-t }\n'))).toThrow(/prefix length, e\.g\. 10\.0\.0\.2\/24/);
    expect(() => parseInventory(lab('  sw:\n    role: switch\n    ip: 10.0.0.2/24 on eth9\n    interfaces: { eth0: 1000base-t }\n'))).toThrow('sw has no interface "eth9"');
    expect(() => parseInventory(lab('  a:\n    role: switch\n    interfaces: { p1: 1000base-t }\n', 'cables:\n  - a/p1 -- b/p1\n'))).toThrow('unknown device "b"');
    expect(() => parseInventory(lab('  a:\n    role: switch\n    interfaces: { p1: 1000base-t }\n', 'cables:\n  - a/p2 -- a/p1\n'))).toThrow('a has no port "p2"');
    expect(() => parseInventory(lab('  a:\n    role: s\n    interfaces: { eth0: { type: 1000base-t, lag: bond0 } }\n'))).toThrow(/lag "bond0" isn't an interface of type lag/);
    expect(() =>
      parseInventory(lab('  a:\n    role: s\n    interfaces: { "p[1-3]": 1000base-t }\n', 'cables:\n  - a/p1 -- a/p2\n  - a/p2 -- a/p3\n')),
    ).toThrow('a/p2 is already cabled in cables[0]');
    expect(() => parseInventory(lab('  a:\n    role: s\n', 'cables:\n  - a-p1 to b\n'))).toThrow(/devA\/port -- devB\/port/);
    expect(() => parseInventory(lab('  a:\n    role: s\n', 'services:\n  - { name: X, on: nope }\n'))).toThrow('services[0] (X): unknown device "nope"');
  });

  it('only allows patch panel ports that exist', () => {
    const base = lab('  pp:\n    role: patch-panel\n    ports: 2\n  a:\n    role: s\n    interfaces: { p1: 1000base-t }\n');
    expect(parseInventory(`${base}cables:\n  - a/p1 -- pp/F2\n`).cables).toHaveLength(1);
    expect(() => parseInventory(`${base}cables:\n  - a/p1 -- pp/F3\n`)).toThrow('pp has no port "F3"');
  });

  it('accepts cables as pairs too', () => {
    const inv = parseInventory(lab('  a:\n    role: s\n    interfaces: { "p[1-2]": 1000base-t }\n', 'cables:\n  - [a/p1, a/p2]\n'));
    expect(inv.cables[0]).toEqual([{ device: 'a', port: 'p1' }, { device: 'a', port: 'p2' }]);
  });
});

describe('helpers', () => {
  it('expands interface ranges, including inside names', () => {
    expect(expandRange('eth0')).toEqual(['eth0']);
    expect(expandRange('Gi1/0/[1-3]')).toEqual(['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3']);
    expect(expandRange('ether[1-2]-lan')).toEqual(['ether1-lan', 'ether2-lan']);
    expect(() => expandRange('p[5-1]')).toThrow(/backwards/);
  });

  it('reads rates in kbps, the unit NetBox uses', () => {
    expect(rateKbps('1G', 'x')).toBe(1_000_000);
    expect(rateKbps('2.5 Gbps', 'x')).toBe(2_500_000);
    expect(rateKbps('50M', 'x')).toBe(50_000);
    expect(rateKbps(300, 'x')).toBe(300);
    expect(rateKbps(undefined, 'x')).toBeUndefined();
    expect(() => rateKbps('fast', 'internet.download')).toThrow('internet.download: "fast"');
  });
});
