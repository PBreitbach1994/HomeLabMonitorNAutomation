import { describe, expect, it } from 'vitest';
import { FactStore } from '../facts.ts';
import { attribute, buildTopology, measureLink, pathBetween, simKeyFor } from '../derive/topology.ts';
import { exampleConfig } from './helpers.ts';

const topo = buildTopology(exampleConfig());

describe('topology', () => {
  it('finds the internet node and leaves', () => {
    expect(topo.internetId).toBe('internet');
    expect(topo.leaves.has('srv-02')).toBe(true);
    expect(topo.leaves.has('sw-rack')).toBe(false);
    expect(topo.leaves.has('ap-garage')).toBe(true);
  });

  it('routes internet → host down the tree', () => {
    expect(pathBetween(topo, 'internet', 'srv-02')).toEqual([
      { linkId: 'gw-01-up', dir: 'down' },
      { linkId: 'sw-core-up', dir: 'down' },
      { linkId: 'sw-rack-up', dir: 'down' },
      { linkId: 'srv-02-up', dir: 'down' },
    ]);
  });

  it('routes host → host through their common switch only', () => {
    expect(pathBetween(topo, 'srv-02', 'nas-01')).toEqual([
      { linkId: 'srv-02-up', dir: 'up' },
      { linkId: 'nas-01-up', dir: 'down' },
    ]);
  });

  it('infers which side of the link each port is on', () => {
    // sw-rack/port4 sits on the upstream switch; nas-01/eth0 is the far end on the NAS.
    expect(topo.links.get('nas-01-up')!.members).toEqual([
      { measure: { key: 'sw-rack/port4', side: 'upstream' }, alt: { key: 'nas-01/eth0', side: 'downstream' } },
    ]);
    // The router's WAN port is on the downstream device of the internet → gw-01 link.
    expect(topo.links.get('gw-01-up')!.members[0].measure).toEqual({ key: 'gw-01/wan0', side: 'downstream' });
  });

  it('reads rates in the right direction, falling back to the far end, then the simulator', () => {
    const f = new FactStore();
    f.setIface('sw-rack/port4', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('sw-rack/port4', { inOctets: 12_500_000, outOctets: 250_000_000 }, 1000);
    const r = measureLink(topo.links.get('nas-01-up')!, f, 1000);
    expect(r.downBps).toBeCloseTo(2e9); // switch out → NAS
    expect(r.upBps).toBeCloseTo(1e8);

    // Only the device end reports (e.g. a host agent): its in-counter is the download.
    f.setIface('srv-02/eth0', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('srv-02/eth0', { inOctets: 1_250_000, outOctets: 125_000 }, 1000);
    expect(measureLink(topo.links.get('srv-02-up')!, f, 1000)).toMatchObject({ downBps: 1e7, upBps: 1e6, measured: true });

    f.setIface(simKeyFor('ws-01-up'), { inOctets: 0, outOctets: 0 }, 0);
    f.setIface(simKeyFor('ws-01-up'), { inOctets: 1_250_000, outOctets: 0 }, 1000);
    expect(measureLink(topo.links.get('ws-01-up')!, f, 1000).downBps).toBeCloseTo(1e7);
    expect(measureLink(topo.links.get('printer-01-up')!, f, 1000).measured).toBe(false);
  });

  it('sums the member ports of a bond', () => {
    const bond = topo.links.get('srv-01-up')!;
    expect(bond.bonded).toBe(true);
    expect(bond.speedBps).toBe(5e9);
    const f = new FactStore();
    for (const p of ['sw-rack/port1', 'sw-rack/port2']) f.setIface(p, { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('sw-rack/port1', { inOctets: 0, outOctets: 125_000_000 }, 1000); // 1 Gb/s down
    f.setIface('sw-rack/port2', { inOctets: 0, outOctets: 62_500_000 }, 1000); // 0.5 Gb/s down
    expect(measureLink(bond, f, 1000).downBps).toBeCloseTo(1.5e9);
  });

  it('treats stale counters as missing', () => {
    const f = new FactStore();
    f.setIface('sw-rack/port4', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('sw-rack/port4', { inOctets: 1000, outOctets: 1000 }, 1000);
    expect(measureLink(topo.links.get('nas-01-up')!, f, 120_000).measured).toBe(false);
  });

  it('attributes app flows along their path and caps them at what the link carried', () => {
    const rates = new Map([...topo.links.keys()].map((id) => [id, { downBps: 0, upBps: 0, measured: false }]));
    rates.set('srv-01-up', { downBps: 900e6, upBps: 100e6, measured: true });
    rates.set('sw-rack-up', { downBps: 500e6, upBps: 0, measured: true }); // less than the app claims
    const mix = attribute(topo, rates, [{ protocol: 'torrent', from: 'internet', to: 'srv-01', bps: 800e6, owner: 'srv-01' }]);
    expect(mix.get('srv-01-up')).toEqual({ torrent: 800e6, other: 200e6 });
    expect(mix.get('sw-rack-up')!.torrent).toBeCloseTo(500e6);
    expect(mix.get('sw-rack-up')!.other).toBe(0);
    expect(mix.get('nas-01-up')).toBeUndefined();
  });
});
