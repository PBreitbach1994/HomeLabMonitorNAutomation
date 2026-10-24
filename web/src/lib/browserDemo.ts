// The full server pipeline (simulator → facts → derivations → snapshot) running in the page.
import exampleYaml from '../../../config/lab.example.yaml?raw';
import { parseConfig } from '../../../server/config.ts';
import { FactStore } from '../../../server/facts.ts';
import { SnapshotBuilder } from '../../../server/snapshot.ts';
import { Simulator } from '../../../server/collectors/simulator.ts';
import type { HistoryResponse, Snapshot } from '../../../shared/model.ts';

export function createBrowserDemo() {
  const lab = parseConfig(exampleYaml);
  lab.mode = 'demo';
  const facts = new FactStore();
  const builder = new SnapshotBuilder(lab, facts);
  const quiet = { info() {}, warn() {}, error() {} };
  const sim = new Simulator('sim', { lab, facts, log: quiet, covered: new Set() });
  facts.registerSource(sim.id, sim.kind, sim.domains);

  const end = Date.now() - 2000;
  for (let t = end - 3600_000; t <= end; t += 10_000) {
    sim.tick(t);
    builder.build(t);
  }
  facts.sourceOk(sim.id);

  const listeners = new Set<(s: Snapshot) => void>();
  let latest = builder.build(Date.now());
  setInterval(() => {
    sim.tick(Date.now());
    facts.sourceOk(sim.id);
  }, 1000);
  setInterval(() => {
    latest = builder.build(Date.now());
    listeners.forEach((l) => l(latest));
  }, 2000);

  return {
    subscribe(cb: (s: Snapshot) => void) {
      listeners.add(cb);
      cb(latest);
      return () => listeners.delete(cb);
    },
    async history(key: string, n = 360): Promise<HistoryResponse> {
      return { key, stepMs: builder.history.stepMs, end: builder.history.lastSampleAt, points: builder.history.get(key, n) };
    },
  };
}
