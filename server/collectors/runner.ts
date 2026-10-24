import type { CollectorConfig, LabConfig } from '../config.ts';
import type { Domain, FactStore } from '../facts.ts';
import { FACTORIES } from './index.ts';
import type { Collector, CollectorContext, Logger } from './types.ts';

export interface RunningCollectors {
  collectors: Collector[];
  stop(): void;
}

function enabledConfigs(lab: LabConfig): CollectorConfig[] {
  return lab.collectors.filter((c) => {
    if (c.enabled === false) return false;
    if (lab.mode === 'demo') return c.kind === 'simulator';
    if (lab.mode === 'live') return c.kind !== 'simulator';
    return true;
  });
}

export function startCollectors(
  lab: LabConfig,
  facts: FactStore,
  log: Logger,
  beforeStart?: (collectors: Collector[]) => void,
): RunningCollectors {
  const configs = enabledConfigs(lab);
  if (lab.mode !== 'live' && !configs.some((c) => c.kind === 'simulator')) {
    configs.unshift({ id: 'sim', kind: 'simulator' });
  }
  const covered = new Set<Domain>();
  const ctx: CollectorContext = { lab, facts, log, covered };

  // Build real collectors first so the simulator knows which domains to leave alone.
  const ordered = [...configs].sort((a, b) => Number(a.kind === 'simulator') - Number(b.kind === 'simulator'));
  const collectors: Collector[] = [];
  for (const cfg of ordered) {
    const factory = FACTORIES[cfg.kind];
    if (!factory) {
      log.warn(`collector "${cfg.id}": unknown kind "${cfg.kind}" — skipped`);
      continue;
    }
    try {
      const c = factory(cfg, ctx);
      if (cfg.kind !== 'simulator') c.domains.forEach((d) => covered.add(d));
      facts.registerSource(c.id, c.kind, c.domains);
      collectors.push(c);
    } catch (err) {
      log.error(`collector "${cfg.id}": ${(err as Error).message}`);
    }
  }

  beforeStart?.(collectors);
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;
  for (const c of collectors) {
    const loop = async () => {
      if (stopped) return;
      const started = Date.now();
      try {
        await c.poll(started);
        facts.sourceOk(c.id);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        const src = facts.sources.get(c.id);
        if (src?.lastError !== msg) log.warn(`collector "${c.id}" failed: ${msg}`);
        facts.sourceError(c.id, msg);
      }
      if (!stopped) timers.set(c.id, setTimeout(loop, Math.max(250, c.intervalMs - (Date.now() - started))));
    };
    void loop();
  }
  log.info(`collectors: ${collectors.map((c) => `${c.id}(${c.kind})`).join(', ') || 'none'}`);

  return {
    collectors,
    stop() {
      stopped = true;
      timers.forEach((t) => clearTimeout(t));
      collectors.forEach((c) => c.stop?.());
    },
  };
}
