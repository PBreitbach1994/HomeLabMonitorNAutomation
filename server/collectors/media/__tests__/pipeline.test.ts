// End-to-end: every media fixture parsed by the collectors' pure functions, then run through the
// real pipeline correlation and incident rules. This is what proves the join keys line up.

import { describe, expect, it } from 'vitest';
import { correlate } from '../../../derive/pipeline.ts';
import { RULES, type RuleContext } from '../../../derive/incidents.ts';
import { FactStore } from '../../../facts.ts';
import { parseArrHealth, parseArrHistory, parseArrQueue } from '../arr.ts';
import { parsePlexItems, parsePlexSessions, plexIds, plexRecentlyAdded, type PlexIds } from '../plex.ts';
import { parseQbitTorrents, parseQbitTransfer } from '../qbittorrent.ts';
import { parseSabHistory, parseSabQueue } from '../sabnzbd.ts';
import { parseSeerrRequests } from '../seerr.ts';
import { NOW, fixture } from './helpers.ts';

function factsFromFixtures(): FactStore {
  const facts = new FactStore();
  const sab = parseSabQueue(fixture('sabnzbd-queue.json'), NOW);
  facts.downloads.set('sabnzbd', {
    client: 'sabnzbd', protocol: 'usenet', host: 'switchyard', downBps: sab.downBps, upBps: 0,
    queue: sab.queue, history: parseSabHistory(fixture('sabnzbd-history.json'), NOW), at: NOW,
  });
  const qbit = parseQbitTorrents(fixture('qbittorrent-torrents.json'), NOW);
  facts.downloads.set('qbittorrent', {
    client: 'qbittorrent', protocol: 'torrent', host: 'switchyard', ...parseQbitTransfer(fixture('qbittorrent-transfer.json')), ...qbit, at: NOW,
  });
  for (const app of ['sonarr', 'radarr', 'lidarr'] as const) {
    facts.arr.set(app, {
      app,
      label: app[0].toUpperCase() + app.slice(1),
      queue: parseArrQueue(app, fixture(`${app}-queue.json`)),
      history: parseArrHistory(app, fixture(`${app}-history.json`)),
      health: app === 'sonarr' ? parseArrHealth(fixture('sonarr-health.json')) : [],
      at: NOW,
    });
  }
  facts.requests = parseSeerrRequests(fixture('seerr-requests.json'));
  const parents: Record<string, PlexIds> = Object.fromEntries(
    ['1001', '2001', '5012'].map((k) => [k, plexIds(fixture<any>(`plex-metadata-${k}.json`).MediaContainer.Metadata[0])]),
  );
  facts.plex = {
    host: 'nichnas',
    sessions: parsePlexSessions(fixture('plex-sessions.json'), { internetId: 'internet' }),
    recentlyAdded: plexRecentlyAdded(parsePlexItems(fixture('plex-recently-added.json')), (k) => (k ? parents[k] : undefined)),
    at: NOW,
  };
  return facts;
}

describe('media facts → pipeline', () => {
  const facts = factsFromFixtures();
  const { items } = correlate(facts, NOW);
  const byId = (id: string) => items.find((i) => i.id.toUpperCase() === id.toUpperCase())!;

  it('joins Sonarr + SABnzbd + Seerr + Plex: requested → In Plex', () => {
    const sev = byId('SABnzbd_nzo_sev0203x');
    expect(sev.status).toBe('In Plex');
    expect(sev.mediaKey).toBe('tv:tvdb:371980:s02e03');
    expect(sev.stages).toEqual({
      requested: 'verified', grabbed: 'verified', downloading: 'verified', downloaded: 'verified', imported: 'verified', available: 'verified',
    });
    expect(sev.client).toBe('sabnzbd');
  });

  it('joins Radarr + SABnzbd + Plex for movies', () => {
    const dune = byId('SABnzbd_nzo_dune2160');
    expect(dune.status).toBe('In Plex');
    expect(dune.stages.requested).toBe('verified');
  });

  it('joins a qBittorrent season pack with its import-blocked Sonarr queue item', () => {
    const pack = byId('8C212779B4ABDE7C6BC608063A0D008B7E40CE32');
    expect(pack.status).toBe('Import blocked');
    expect(pack.client).toBe('qbittorrent');
    expect(pack.mediaKey).toBe('tv:tvdb:359543:s04');
    expect(pack.stages.downloaded).toBe('verified');
    expect(pack.stages.imported).toBe('blocked');
  });

  it('shows downloading, unpacking and failed releases', () => {
    expect(byId('SABnzbd_nzo_tlou0204')).toMatchObject({ status: 'Downloading', progress: 0.6, current: 'downloading' });
    expect(byId('SABnzbd_nzo_tlou0203').status).toBe('Unpacking');
    expect(byId('SABnzbd_nzo_andor201')).toMatchObject({ status: 'Downloading failed', current: 'downloaded' });
    expect(byId('A1B2C3D4E5F60718293A4B5C6D7E8F9012345678')).toMatchObject({ status: 'Downloading', client: 'qbittorrent' });
  });

  it('feeds the arr-stuck, arr-health and download-failed incident rules', () => {
    const ctx = { now: NOW, facts, pipeline: items } as unknown as RuleContext;
    const run = (id: string) => RULES.find((r) => r.id === id)!.evaluate(ctx);

    const stuck = run('arr-stuck');
    expect(stuck.map((f) => f.key).sort()).toEqual(['arr-stuck:radarr', 'arr-stuck:sonarr']);
    expect(stuck.find((f) => f.key === 'arr-stuck:sonarr')!.title).toBe('1 download stuck in Sonarr');

    expect(run('arr-health').map((f) => [f.severity, f.detail])).toEqual([
      ['warning', 'Indexers unavailable due to failures: NZBgeek (Prowlarr)'],
      ['critical', 'Unable to communicate with qBittorrent. Connection refused (switchyard:8081)'],
    ]);

    const failed = run('download-failed');
    expect(failed.map((f) => f.key)).toContain('dl-failed:SABnzbd_nzo_andor201');
  });
});
