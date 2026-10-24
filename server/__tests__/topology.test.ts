import { describe, expect, it } from 'vitest';
import { FactStore } from '../facts.ts';
import { attribute, buildTopology, measureLink, pathBetween, simKeyFor } from '../derive/topology.ts';
import { exampleConfig } from './helpers.ts';

const topo = buildTopology(exampleConfig());

describe('topology', () => {
  it('finds the internet node and leaves', () => {
    expect(topo.internetId).toBe('internet');
    expect(topo.leaves.has('switchyard')).toBe(true);
    expect(topo.leaves.has('flex-a')).toBe(false);
    expect(topo.leaves.has('garage')).toBe(true);
  });

  it('routes internet → host down the tree', () => {
    expect(pathBetween(topo, 'internet', 'switchyard')).toEqual([
      { linkId: 'office-up', dir: 'down' },
      { linkId: 'crs304-up', dir: 'down' },
      { linkId: 'flex-a-up', dir: 'down' },
      { linkId: 'switchyard-up', dir: 'down' },
    ]);
  });

  it('routes host → host through their common switch only', () => {
    expect(pathBetween(topo, 'switchyard', 'nichnas')).toEqual([
      { linkId: 'switchyard-up', dir: 'up' },
      { linkId: 'nichnas-up', dir: 'down' },
    ]);
  });

  it('infers which side of the link the measuring port is on', () => {
    // flex-a/1 sits on the upstream switch: port out = toward the NAS = down.
    expect(topo.links.get('nichnas-up')!.measure).toEqual({ key: 'flex-a/1', side: 'upstream' });
    // crs304/ether1 is on the downstream device of the office → crs304 link.
    expect(topo.links.get('crs304-up')!.measure).toEqual({ key: 'crs304/ether1', side: 'downstream' });
  });

  it('reads rates in the right direction, falling back to the simulator key', () => {
    const f = new FactStore();
    f.setIface('flex-a/1', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('flex-a/1', { inOctets: 12_500_000, outOctets: 250_000_000 }, 1000);
    const r = measureLink(topo.links.get('nichnas-up')!, f, 1000);
    expect(r.downBps).toBeCloseTo(2e9); // switch out → NAS
    expect(r.upBps).toBeCloseTo(1e8);

    f.setIface(simKeyFor('foundry-up'), { inOctets: 0, outOctets: 0 }, 0);
    f.setIface(simKeyFor('foundry-up'), { inOctets: 1_250_000, outOctets: 0 }, 1000);
    expect(measureLink(topo.links.get('foundry-up')!, f, 1000).downBps).toBeCloseTo(1e7);
    expect(measureLink(topo.links.get('printer-up')!, f, 1000).measured).toBe(false);
  });

  it('treats stale counters as missing', () => {
    const f = new FactStore();
    f.setIface('flex-a/1', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('flex-a/1', { inOctets: 1000, outOctets: 1000 }, 1000);
    expect(measureLink(topo.links.get('nichnas-up')!, f, 120_000).measured).toBe(false);
  });

  it('attributes app flows along their path and caps them at what the link carried', () => {
    const rates = new Map([...topo.links.keys()].map((id) => [id, { downBps: 0, upBps: 0, measured: false }]));
    rates.set('switchyard-up', { downBps: 900e6, upBps: 100e6, measured: true });
    rates.set('flex-a-up', { downBps: 500e6, upBps: 0, measured: true }); // less than the app claims
    const mix = attribute(topo, rates, [{ protocol: 'usenet', from: 'internet', to: 'switchyard', bps: 800e6, owner: 'switchyard' }]);
    expect(mix.get('switchyard-up')).toEqual({ usenet: 800e6, other: 200e6 });
    expect(mix.get('flex-a-up')!.usenet).toBeCloseTo(500e6);
    expect(mix.get('flex-a-up')!.other).toBe(0);
    expect(mix.get('nichnas-up')).toBeUndefined();
  });
});
