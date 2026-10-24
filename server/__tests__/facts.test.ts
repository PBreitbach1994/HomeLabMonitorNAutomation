import { describe, expect, it } from 'vitest';
import { FactStore } from '../facts.ts';

describe('FactStore.setIface', () => {
  it('derives bits/s from octet deltas', () => {
    const f = new FactStore();
    f.setIface('sw/1', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('sw/1', { inOctets: 125_000_000, outOctets: 12_500_000 }, 1000); // 1 Gb/s in, 100 Mb/s out
    expect(f.ifaces.get('sw/1')!.inBps).toBeCloseTo(1e9);
    expect(f.ifaces.get('sw/1')!.outBps).toBeCloseTo(1e8);
  });

  it('smooths with an EWMA', () => {
    const f = new FactStore();
    f.setIface('k', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('k', { inOctets: 125_000_000, outOctets: 0 }, 1000); // 1 Gb/s
    f.setIface('k', { inOctets: 125_000_000, outOctets: 0 }, 2000); // 0 Gb/s
    expect(f.ifaces.get('k')!.inBps).toBeCloseTo(0.5e9);
  });

  it('drops the interval when a counter goes backwards (reset / wrap)', () => {
    const f = new FactStore();
    f.setIface('k', { inOctets: 5e9, outOctets: 5e9 }, 0);
    f.setIface('k', { inOctets: 10, outOctets: 10 }, 1000);
    expect(f.ifaces.get('k')!.inBps).toBeNull();
    f.setIface('k', { inOctets: 125_000_010, outOctets: 10 }, 2000);
    expect(f.ifaces.get('k')!.inBps).toBeCloseTo(1e9);
  });

  it('ignores samples that arrive too close together', () => {
    const f = new FactStore();
    f.setIface('k', { inOctets: 0, outOctets: 0 }, 0);
    f.setIface('k', { inOctets: 100, outOctets: 0 }, 50);
    expect(f.ifaces.get('k')!.at).toBe(0);
  });
});
