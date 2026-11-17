// Runs against a real, throwaway NetBox (e.g. deploy/netbox in Docker):
//   NETBOX_TEST_URL=http://localhost:8000 NETBOX_TEST_TOKEN=<write token> npx vitest run importer.integration
// Skipped otherwise. It creates a site named after a random suffix and doesn't clean up.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NetBoxClient } from '../client.ts';
import { fetchInventory } from '../fetch.ts';
import { applyInventory } from '../importer.ts';
import { parseInventory } from '../inventory.ts';
import { buildFromInventory } from '../topology.ts';

const url = process.env.NETBOX_TEST_URL;
const token = process.env.NETBOX_TEST_TOKEN;

describe.skipIf(!url || !token)('importer against a real NetBox', () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  // Same lab, fresh site and names, so repeated runs don't collide with each other.
  const text = readFileSync(new URL('../../../examples/demo-lab.inventory.yaml', import.meta.url), 'utf8')
    .replace('name: Demo Lab', `name: Import Test ${suffix}`)
    .replace('cid: EX-1000', `cid: EX-${suffix}`)
    .replace(/10\.20\.0\./g, `10.${30 + Math.floor(Math.random() * 200)}.0.`)
    .replace(/\b(gw-01|sw-core|sw-rack|sw-desk|ap-hall|ap-garage|srv-01|srv-02|nas-01|ws-01|printer-01|pp-01)\b/g, `$1-${suffix}`);
  const inv = parseInventory(text);
  // Built only when the suite runs; describe bodies are evaluated even when skipped.
  const nb = url && token ? new NetBoxClient({ url, token }) : (undefined as unknown as NetBoxClient);
  const site = inv.site.slug;
  const n = (name: string) => `${name}-${suffix}`;

  it('plans without writing on a dry run', { timeout: 120_000 }, async () => {
    const r = await applyInventory(nb, inv, { dryRun: true });
    expect(r.created.some((c) => c === `device ${n('gw-01')}`)).toBe(true);
    expect(r.created.some((c) => c.startsWith('cable '))).toBe(true);
    expect(await nb.list('dcim/sites', { slug: site })).toEqual([]);
  });

  it('creates the lab, and the dashboard reads back the intended topology', { timeout: 300_000 }, async () => {
    const r = await applyInventory(nb, inv);
    expect(r.warnings).toEqual([]);
    const lab = buildFromInventory(await fetchInventory(nb, { site }));
    expect(lab.warnings).toEqual([]);
    const parents = Object.fromEntries(lab.nodes.map((x) => [x.id, x.parent]));
    expect(parents).toEqual({
      internet: undefined,
      [n('gw-01')]: 'internet',
      [n('sw-core')]: n('gw-01'),
      [n('sw-rack')]: n('sw-core'),
      [n('sw-desk')]: n('sw-core'),
      [n('srv-01')]: n('sw-rack'),
      [n('srv-02')]: n('sw-rack'),
      [n('nas-01')]: n('sw-rack'),
      [n('ws-01')]: n('sw-desk'),
      [n('printer-01')]: n('sw-desk'),
      [n('ap-hall')]: n('sw-desk'),
      [n('ap-garage')]: n('ap-hall'),
    });
    expect(lab.nodes.find((x) => x.id === n('srv-01'))!.link).toMatchObject({ bonded: true, speed: 5e9 });
    expect(lab.nodes.find((x) => x.id === n('gw-01'))!.link).toMatchObject({ speed: 1e9, measure: `${n('gw-01')}/wan0` });
    expect(lab.nodes.find((x) => x.id === n('ap-garage'))!.link!.medium).toBe('wifi');
    const tiles = Object.fromEntries(lab.services.map((s) => [s.label, s]));
    expect(tiles['qBittorrent']).toMatchObject({ host: n('srv-01'), vpn: true });
    expect(tiles['Uptime Kuma'].expect).toBe('manual');
    expect(tiles['Backups']).toMatchObject({ host: n('srv-02'), expect: 'paused' });
  });

  it('changes nothing when run again', { timeout: 300_000 }, async () => {
    const r = await applyInventory(nb, inv);
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
