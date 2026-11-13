// Keeps the lab's topology, services and collector targets in step with NetBox.
// The YAML `topology.nodes` / `services` act as overrides by id; the last good result is cached
// so the dashboard still starts when NetBox is down.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateConfig, type CollectorConfig, type LabConfig, type NodeConfig, type ServiceConfig } from '../config.ts';
import type { FactStore } from '../facts.ts';
import type { Logger } from '../collectors/types.ts';
import { NetBoxClient } from './client.ts';
import { fetchInventory } from './fetch.ts';
import { INTERNET_ID, buildFromInventory, type NetboxLab } from './topology.ts';

export const SOURCE_ID = 'netbox';

interface Cached extends Omit<NetboxLab, 'warnings'> {
  fetchedAt: number;
}

/** Overlays YAML entries onto NetBox ones by id (fields win, `link` is merged); YAML-only entries are appended. */
export function mergeById<T extends { id: string; link?: object }>(base: T[], overrides: T[]): T[] {
  const byId = new Map(overrides.map((o) => [o.id, o]));
  const out = base.map((b) => {
    const o = byId.get(b.id);
    if (!o) return b;
    byId.delete(b.id);
    return { ...b, ...o, ...(b.link || o.link ? { link: { ...b.link, ...o.link } } : {}) } as T;
  });
  return [...out, ...byId.values()];
}

export class NetboxSource {
  private nb: NetBoxClient;
  private yamlNodes: NodeConfig[];
  private yamlServices: ServiceConfig[];
  private yamlCollectors: CollectorConfig[];
  private timer?: NodeJS.Timeout;
  private lastKey = '';
  private collectorKey = '';
  private stopped = false;

  constructor(
    private lab: LabConfig,
    private facts: FactStore,
    private log: Logger,
    private onChange: () => void = () => {},
  ) {
    const cfg = lab.netbox!;
    this.nb = new NetBoxClient({ url: cfg.url, token: cfg.token });
    this.yamlNodes = lab.topology.nodes;
    this.yamlServices = lab.services;
    this.yamlCollectors = lab.collectors;
    facts.registerSource(SOURCE_ID, 'netbox', []);
  }

  private get cachePath() {
    return this.lab.netbox!.cache ?? 'data/netbox-cache.json';
  }

  /** First load: NetBox, else the cache, else an empty map that fills in once NetBox answers. */
  async start(): Promise<void> {
    try {
      await this.refresh(true);
    } catch (err) {
      const msg = (err as Error).message;
      this.facts.sourceError(SOURCE_ID, msg);
      const cached = this.readCache();
      if (cached) {
        this.log.warn(`NetBox unavailable (${msg}); using the topology cached ${new Date(cached.fetchedAt).toISOString()}`);
        this.apply({ ...cached, warnings: [] }, true);
      } else {
        this.log.error(`NetBox unavailable (${msg}) and no cached topology yet; the map stays empty until it answers`);
        this.apply({ nodes: [], services: [], collectors: [], warnings: [] }, true);
      }
    }
    this.schedule();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule() {
    if (this.stopped) return;
    const ok = this.facts.sources.get(SOURCE_ID)?.ok;
    const every = (this.lab.netbox!.refresh ?? 300) * 1000;
    this.timer = setTimeout(async () => {
      try {
        await this.refresh(false);
      } catch (err) {
        this.facts.sourceError(SOURCE_ID, (err as Error).message);
      }
      this.schedule();
    }, ok ? every : Math.min(every, 30_000));
  }

  async refresh(first: boolean): Promise<void> {
    const cfg = this.lab.netbox!;
    const warnings: string[] = [];
    const inv = await fetchInventory(this.nb, cfg, (w) => warnings.push(w));
    const built = buildFromInventory(inv, cfg);
    built.warnings.unshift(...warnings);
    this.apply(built, first);
    this.writeCache({ nodes: built.nodes, services: built.services, collectors: built.collectors, provider: built.provider, fetchedAt: inv.fetchedAt });
    this.facts.sourceOk(SOURCE_ID);
    const src = this.facts.sources.get(SOURCE_ID);
    if (src) src.note = built.warnings.length ? built.warnings.join(' ') : undefined;
    if (first) {
      this.log.info(`netbox ${inv.netboxVersion ?? ''}: ${built.nodes.length - 1} devices on the map, ${built.services.length} service tiles`);
      built.warnings.forEach((w) => this.log.warn(`netbox: ${w}`));
    }
  }

  private apply(built: NetboxLab, first: boolean) {
    const nodes = mergeById(built.nodes.length ? built.nodes : [{ id: INTERNET_ID, label: 'Internet', kind: 'internet' as const }], this.yamlNodes);
    const services = mergeById(built.services, this.yamlServices);
    const candidate: LabConfig = { ...this.lab, topology: { nodes }, services };
    const errors = validateConfig(candidate, { merged: true });
    if (errors.length) {
      // Keep whatever we had; a bad override shouldn't blank the map.
      throw new Error(`NetBox topology rejected: ${errors.join('; ')}`);
    }
    const key = JSON.stringify([nodes, services]);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lab.topology = { nodes };
      this.lab.services = services;
      if (built.provider && !this.lab.lab.provider) this.lab.lab.provider = built.provider;
      if (!first) {
        this.log.info(`netbox: topology changed — ${nodes.length - 1} devices, ${services.length} services`);
        this.onChange();
      }
    }
    const yamlIds = new Set(this.yamlCollectors.map((c) => c.id));
    const auto = built.collectors.filter((c) => !yamlIds.has(c.id));
    const ckey = JSON.stringify(auto);
    if (first) {
      this.collectorKey = ckey;
      this.lab.collectors = [...this.yamlCollectors, ...auto];
    } else if (ckey !== this.collectorKey) {
      this.collectorKey = ckey;
      this.log.warn('netbox: the devices tagged for collectors changed — restart the dashboard to start polling them');
    }
  }

  private readCache(): Cached | null {
    try {
      return JSON.parse(readFileSync(this.cachePath, 'utf8')) as Cached;
    } catch {
      return null;
    }
  }

  private writeCache(c: Cached) {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(c));
    } catch (err) {
      this.log.warn(`netbox: couldn't write cache ${this.cachePath}: ${(err as Error).message}`);
    }
  }
}
