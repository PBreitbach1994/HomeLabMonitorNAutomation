import { describe, expect, it } from 'vitest';
import { FactStore } from '../facts.ts';
import { SnapshotBuilder } from '../snapshot.ts';
import { Simulator } from '../collectors/simulator.ts';
import { PROTOCOLS } from '../../shared/model.ts';
import { exampleConfig } from './helpers.ts';

/** Runs the demo pipeline end to end: simulator → facts → derivations → snapshot. */
function run(seed: number, minutes = 60) {
  const lab = exampleConfig();
  const facts = new FactStore();
  const builder = new SnapshotBuilder(lab, facts);
  const quiet = { info() {}, warn() {}, error() {} };
  const sim = new Simulator('sim', { lab, facts, log: quiet, covered: new Set() }, { seed });
  const t0 = Date.UTC(2026, 9, 23, 18, 0, 0);
  let snap = builder.build(t0);
  for (let t = t0; t <= t0 + minutes * 60_000; t += 10_000) {
    sim.tick(t);
    snap = builder.build(t);
  }
  return snap;
}

describe('simulator end to end', () => {
  for (const seed of [1, 2, 3]) {
    it(`produces a consistent snapshot (seed ${seed})`, () => {
      const s = run(seed);
      // every link measured, and its protocol split adds back up to its traffic
      for (const l of s.links) {
        expect(l.measured).toBe(true);
        const total = (l.downBps ?? 0) + (l.upBps ?? 0);
        const mix = PROTOCOLS.reduce((a, p) => a + (l.mix[p] ?? 0), 0);
        expect(Math.abs(mix - total)).toBeLessThanOrEqual(Math.max(1, total * 0.01));
        expect(l.util ?? 0).toBeLessThanOrEqual(1);
      }
      // the internet plan caps WAN download (EWMA can overshoot a touch)
      expect(s.internet.downBps!).toBeLessThan(940e6 * 1.1);
      expect(s.hosts).toHaveLength(3);
      expect(s.services).toHaveLength(18);
      expect(s.pipelineTracked).toBeGreaterThan(2);
      expect(s.incidents.some((i) => i.title.startsWith('Expansion 33-3') && i.state === 'open')).toBe(true);
      expect(s.incidents.some((i) => i.title.includes('stuck in Radarr'))).toBe(true);
      expect(s.attention).toBeGreaterThanOrEqual(2);
      expect(s.internet.rttHistory.length).toBeGreaterThan(100);
    });
  }

  it('fails the third grab and recovers it with a replacement', () => {
    const s = run(7, 120);
    const failed = s.incidents.filter((i) => i.title === 'Download not completed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((i) => i.state === 'recovered')).toBe(true);
  });
});
