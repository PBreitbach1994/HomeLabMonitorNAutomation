import { describe, expect, it } from 'vitest';
import { FactStore } from '../facts.ts';
import { SnapshotBuilder } from '../snapshot.ts';
import { Simulator, createSimulator } from '../collectors/simulator.ts';
import { PROTOCOLS } from '../../shared/model.ts';
import { exampleConfig } from './helpers.ts';

/** Runs the demo pipeline end to end: simulator → facts → derivations → snapshot. */
function run(seed: number, minutes = 60) {
  const lab = exampleConfig();
  const facts = new FactStore();
  const builder = new SnapshotBuilder(lab, facts);
  const quiet = { info() {}, warn() {}, error() {} };
  // Built the way the server builds it, from the demo config's simulator entry.
  const cfg = lab.collectors.find((c) => c.kind === 'simulator')!;
  const sim = createSimulator({ ...cfg, seed }, { lab, facts, log: quiet, covered: new Set() });
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
      // the circuit's 1 Gb/s plan caps WAN download (EWMA can overshoot a touch)
      expect(s.internet.downBps!).toBeLessThan(1e9 * 1.1);
      expect(s.hosts).toHaveLength(3);
      expect(s.services).toHaveLength(9);
      // only qBittorrent is configured, so only torrents show up in the pipeline
      expect(s.pipeline.every((p) => p.client === 'qbittorrent')).toBe(true);
      // …and with no *arr, Seerr or Plex there is nothing to evidence those stages
      expect(s.pipelineStages).toEqual(['downloading', 'downloaded']);
      expect(s.pipeline.some((p) => p.status === 'Waiting for import')).toBe(false);
      expect(s.incidents.some((i) => i.title === 'Disk 3 degraded' && i.state === 'open')).toBe(true);
      expect(s.attention).toBeGreaterThanOrEqual(1);
      expect(s.internet.rttHistory.length).toBeGreaterThan(100);
    });
  }

  it('simulates nothing the config does not declare', () => {
    const lab = exampleConfig();
    lab.services = lab.services.filter((x) => x.app !== 'qbittorrent');
    lab.collectors = [{ id: 'sim', kind: 'simulator' }];
    const facts = new FactStore();
    const sim = new Simulator('sim', { lab, facts, log: { info() {}, warn() {}, error() {} }, covered: new Set() }, { seed: 3 });
    for (let t = 0; t < 600_000; t += 10_000) sim.tick(t);
    expect(facts.downloads.size).toBe(0);
    expect(facts.volumes.size).toBe(0); // storage is opt-in
    expect(facts.cameras).toHaveLength(0); // cameras are opt-in
    expect(facts.tailscale).toBeNull();
    expect(facts.vpn).toBeNull(); // no service is marked as using the VPN any more
  });
});
