import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeConfig, type LabConfig } from '../../config.ts';
import { FactStore } from '../../facts.ts';
import { NetBoxClient } from '../client.ts';
import { fetchInventory } from '../fetch.ts';
import { NetboxSource, mergeById } from '../source.ts';
import type { Inventory } from '../types.ts';
import { inventory } from './fixture.ts';

/** A stand-in NetBox serving the recorded inventory, with real pagination and token checks. */
function fakeNetbox(inv: () => Inventory, opts: { token?: string; tagMissing?: boolean } = {}) {
  const seen: { path: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    seen.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const token = opts.token ?? 'v1token';
    if (req.headers.authorization !== `Token ${token}` && req.headers.authorization !== `Bearer ${token}`) {
      return send(403, { detail: 'Invalid token' });
    }
    const data = inv();
    const page = (rows: unknown[]) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const results = rows.slice(offset, offset + limit);
      send(200, { count: rows.length, next: offset + limit < rows.length ? 'http://wrong-host/next' : null, previous: null, results });
    };
    const circuit = /^\/api\/circuits\/circuits\/(\d+)\/$/.exec(url.pathname);
    if (circuit) return send(200, data.circuits.find((c) => c.id === Number(circuit[1])));
    if ((url.pathname.includes('virtual-machines') || url.pathname.includes('ipam/services')) && opts.tagMissing) {
      return send(400, { tag: ['Select a valid choice. dashboard is not one of the available choices.'] });
    }
    switch (url.pathname) {
      case '/api/status/':
        return send(200, { 'netbox-version': '4.7.5' });
      case '/api/dcim/devices/':
        return page(data.devices);
      case '/api/dcim/interfaces/':
        return page(data.interfaces);
      case '/api/virtualization/virtual-machines/':
        return page(data.vms);
      case '/api/ipam/services/':
        return page(data.services);
      default:
        return send(404, { detail: 'Not found.' });
    }
  });
  return { server, seen };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const quiet = { info() {}, warn() {}, error() {} };
let server: Server | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-cache-'));
});
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('NetBoxClient', () => {
  it('uses Token for v1 and Bearer for v2 tokens, and pages by offset (ignoring next URLs)', async () => {
    const fake = fakeNetbox(inventory, { token: 'nbt_abc.def' });
    server = fake.server;
    const url = await listen(server);
    const nb = new NetBoxClient({ url: `${url}/api/`, token: 'nbt_abc.def', pageSize: 10 });
    const ifaces = await nb.list('dcim/interfaces');
    expect(ifaces).toHaveLength(inventory().interfaces.length);
    expect(fake.seen.every((s) => s.auth === 'Bearer nbt_abc.def')).toBe(true);
    expect(fake.seen.filter((s) => s.path.startsWith('/api/dcim/interfaces/')).length).toBe(4); // 36 rows / 10
    await expect(new NetBoxClient({ url, token: 'wrong' }).list('dcim/devices')).rejects.toThrow(/403.*check the token/);
  });

  it('reports an unreachable NetBox clearly', async () => {
    await expect(new NetBoxClient({ url: 'http://127.0.0.1:1', token: 't', timeoutMs: 2000 }).get('status/')).rejects.toThrow(/can't reach NetBox/);
  });
});

describe('fetchInventory', () => {
  it('reads everything the builder needs', async () => {
    server = fakeNetbox(inventory).server;
    const inv = await fetchInventory(new NetBoxClient({ url: await listen(server), token: 'v1token' }), { site: 'demo-lab' });
    expect(inv.netboxVersion).toBe('4.7.5');
    expect(inv.circuits.map((c) => c.cid)).toEqual(['EX-1000']);
    expect(inv.vms.length).toBeGreaterThan(0);
  });

  it('treats a missing dashboard tag as "nothing tagged" and says how to fix it', async () => {
    server = fakeNetbox(inventory, { tagMissing: true }).server;
    const warnings: string[] = [];
    const inv = await fetchInventory(new NetBoxClient({ url: await listen(server), token: 'v1token' }), {}, (w) => warnings.push(w));
    expect(inv.vms).toEqual([]);
    expect(warnings[0]).toMatch(/netbox:bootstrap/);
  });
});

describe('NetboxSource', () => {
  const lab = (url: string, extra: Partial<LabConfig> = {}): LabConfig =>
    normalizeConfig({ mode: 'live', netbox: { url, token: 'v1token', cache: join(dir, 'cache.json') }, ...extra });

  it('loads the topology, adds collectors, and applies YAML overrides', async () => {
    server = fakeNetbox(inventory).server;
    const cfg = lab(await listen(server), {
      topology: { nodes: [{ id: 'gw-01', label: 'Gateway', kind: 'router' }] },
      collectors: [{ id: 'ping', kind: 'ping', targets: { internet: '9.9.9.9' } }],
    });
    const facts = new FactStore();
    await new NetboxSource(cfg, facts, quiet).start();
    const gw = cfg.topology.nodes.find((n) => n.id === 'gw-01')!;
    expect(gw).toMatchObject({ label: 'Gateway', parent: 'internet', link: { measure: 'gw-01/wan0' } });
    expect(cfg.services.length).toBe(9);
    // YAML collectors win over NetBox-derived ones with the same id.
    expect(cfg.collectors.filter((c) => c.id === 'ping')).toEqual([{ id: 'ping', kind: 'ping', targets: { internet: '9.9.9.9' } }]);
    expect(cfg.collectors.some((c) => c.id === 'snmp-sw-core')).toBe(true);
    expect(facts.sources.get('netbox')).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8')).nodes.length).toBe(12);
  });

  it('falls back to the cached topology when NetBox is down', async () => {
    server = fakeNetbox(inventory).server;
    const url = await listen(server);
    await new NetboxSource(lab(url), new FactStore(), quiet).start();
    await new Promise((r) => server!.close(r));
    server = undefined;

    const cfg = lab(url);
    const facts = new FactStore();
    const src = new NetboxSource(cfg, facts, quiet);
    await src.start();
    src.stop();
    expect(cfg.topology.nodes.length).toBe(12);
    expect(facts.sources.get('netbox')).toMatchObject({ ok: false });
    expect(facts.sources.get('netbox')!.lastError).toMatch(/can't reach NetBox/);
  });

  it('starts with just the internet node when NetBox is down and nothing is cached', async () => {
    const cfg = lab('http://127.0.0.1:1');
    const src = new NetboxSource(cfg, new FactStore(), quiet);
    await src.start();
    src.stop();
    expect(cfg.topology.nodes.map((n) => n.id)).toEqual(['internet']);
  });

  it('notices topology changes on refresh and tells the dashboard', async () => {
    let inv = inventory();
    server = fakeNetbox(() => inv).server;
    const cfg = lab(await listen(server));
    let changes = 0;
    const src = new NetboxSource(cfg, new FactStore(), quiet, () => changes++);
    await src.start();
    src.stop();
    await src.refresh(false);
    expect(changes).toBe(0);
    inv = inventory();
    inv.devices.find((d) => d.name === 'printer-01')!.status = { value: 'decommissioning' };
    await src.refresh(false);
    expect(changes).toBe(1);
    expect(cfg.topology.nodes.some((n) => n.id === 'printer-01')).toBe(false);
  });
});

describe('mergeById', () => {
  it('overlays fields and links by id and appends new entries', () => {
    const merged = mergeById(
      [{ id: 'a', label: 'A', link: { medium: '1G', measure: 'x/1' } }, { id: 'b', label: 'B' }] as never[],
      [{ id: 'a', link: { measure: 'x/2' } }, { id: 'c', label: 'C' }] as never[],
    );
    expect(merged).toEqual([
      { id: 'a', label: 'A', link: { medium: '1G', measure: 'x/2' } },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ]);
  });
});
