import { loadConfig } from './config-file.ts';
import { FactStore } from './facts.ts';
import { SnapshotBuilder } from './snapshot.ts';
import { startCollectors } from './collectors/runner.ts';
import { Simulator } from './collectors/simulator.ts';
import { startHttp } from './http.ts';
import { NetboxSource } from './netbox/source.ts';
import type { Logger } from './collectors/types.ts';
import type { Snapshot } from '../shared/model.ts';

const TICK_MS = 2000;
const WARMUP_MS = 3600_000;

const stamp = () => new Date().toISOString().slice(11, 19);
const log: Logger = {
  info: (m) => console.log(`${stamp()} ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

const { config, path } = loadConfig();
log.info(`config ${path} · mode ${config.mode}${config.netbox ? ` · topology from NetBox ${config.netbox.url}` : ''}`);

const facts = new FactStore();
let sim: Simulator | undefined;
let builder: SnapshotBuilder | undefined;

// NetBox first: it supplies the devices, cabling, services and the collectors to start.
const netbox = config.netbox
  ? new NetboxSource(config, facts, log, () => {
      builder?.reloadTopology();
      sim?.reloadTopology();
    })
  : undefined;
await netbox?.start();

builder = new SnapshotBuilder(config, facts);
const snapshots = builder;
let latest: Snapshot | null = null;

const running = startCollectors(config, facts, log, (collectors) => {
  sim = collectors.find((c): c is Simulator => c instanceof Simulator);
  // Fast-forward the simulator through the last hour so charts start full.
  if (!sim || config.mode !== 'demo') return;
  const t0 = Date.now();
  const end = t0 - TICK_MS;
  for (let t = end - WARMUP_MS; t <= end; t += 10_000) {
    sim.tick(t);
    snapshots.build(t);
  }
  log.info(`simulator warmed up 1h of history in ${Date.now() - t0} ms`);
});

const api = startHttp({
  port: config.server.port,
  host: config.server.host,
  token: config.server.token,
  staticDir: process.env.STATIC_DIR ?? 'dist/web',
  latest: () => latest,
  history: snapshots.history,
  log: log.info,
});

const tick = () => {
  try {
    latest = snapshots.build(Date.now());
    api.broadcast(latest);
  } catch (err) {
    log.error(`snapshot failed: ${(err as Error).stack ?? err}`);
  }
};
setTimeout(tick, 300);
const timer = setInterval(tick, TICK_MS);

const shutdown = () => {
  clearInterval(timer);
  netbox?.stop();
  running.stop();
  api.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
