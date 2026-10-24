import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arrEventType, createArr, parseArrHealth, parseArrHistory, parseArrQueue, sonarrMediaKey,
} from '../arr.ts';
import { NOW, cfg, fixture, json, makeCtx, stubFetch } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

const TLOU = 392256;
const SLOW = 359543;
const SEV = 371980;
const ANDOR = 393189;

describe('parseArrQueue (sonarr)', () => {
  const q = parseArrQueue('sonarr', fixture('sonarr-queue.json'));

  it('collapses a season pack (one record per episode) into one item with a season key', () => {
    expect(q).toHaveLength(4);
    const pack = q.find((i) => i.downloadId === '8C212779B4ABDE7C6BC608063A0D008B7E40CE32')!;
    expect(pack).toEqual({
      downloadId: '8C212779B4ABDE7C6BC608063A0D008B7E40CE32',
      title: 'Slow.Horses.S04.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb',
      mediaKey: `tv:tvdb:${SLOW}:s04`,
      kind: 'tv',
      status: 'completed',
      trackedState: 'importBlocked',
      trackedStatus: 'warning',
      // Each episode record repeats the same statusMessages; they're de-duplicated.
      messages: [
        'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.',
      ],
    });
  });

  it('keys single episodes and keeps tracked state', () => {
    const e = q.find((i) => i.downloadId === 'SABnzbd_nzo_tlou0204')!;
    expect(e).toMatchObject({ mediaKey: `tv:tvdb:${TLOU}:s02e04`, status: 'downloading', trackedState: 'downloading', trackedStatus: 'ok', messages: [] });
  });

  it('keeps pending (delay-profile) releases that have no downloadId', () => {
    const pending = q.find((i) => i.status === 'delay')!;
    expect(pending.downloadId).toBe('');
    expect(pending.mediaKey).toBe(`tv:tvdb:${ANDOR}:s02e02`);
    expect(pending.trackedState).toBeUndefined();
  });
});

describe('parseArrQueue (radarr, bare array, PascalCase enums)', () => {
  const q = parseArrQueue('radarr', fixture('radarr-queue.json'));
  it('parses movie keys and normalizes enum casing', () => {
    expect(q.map((i) => i.mediaKey)).toEqual(['movie:tmdb:786892', 'movie:tmdb:999001']);
    expect(q[1]).toMatchObject({ status: 'completed', trackedState: 'importPending', trackedStatus: 'warning', kind: 'movie' });
    expect(q[1].messages).toEqual([
      'Not an upgrade for existing movie file. Existing quality: Bluray-1080p. New Quality Bluray-1080p.',
      'Sample',
    ]);
  });
});

describe('parseArrQueue (lidarr)', () => {
  it('keys albums by artist + release-group MBIDs', () => {
    const [item] = parseArrQueue('lidarr', fixture('lidarr-queue.json'));
    expect(item).toMatchObject({
      downloadId: '9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B',
      mediaKey: 'music:mb:a74b1b7f-71a5-4011-9441-d0b5e4122711:6e335887-60ba-38f0-95af-fae7774336bf',
      kind: 'music',
      status: 'downloading',
    });
  });
});

describe('parseArrHistory (sonarr)', () => {
  const h = parseArrHistory('sonarr', fixture('sonarr-history.json'));

  it('maps grabbed/imported/failed and drops other events and records without a downloadId', () => {
    expect(h.map((e) => [e.downloadId, e.eventType])).toEqual([
      ['SABnzbd_nzo_tlou0204', 'grabbed'],
      ['SABnzbd_nzo_tlou0203', 'grabbed'],
      ['SABnzbd_nzo_sev0203x', 'imported'],
      ['SABnzbd_nzo_sev0203x', 'grabbed'],
      ['8C212779B4ABDE7C6BC608063A0D008B7E40CE32', 'grabbed'],
      ['SABnzbd_nzo_andor201', 'failed'],
      ['SABnzbd_nzo_andor201', 'grabbed'],
    ]);
  });

  it('builds mediaKeys, dates and failure messages', () => {
    const imported = h.find((e) => e.eventType === 'imported')!;
    expect(imported).toEqual({
      downloadId: 'SABnzbd_nzo_sev0203x',
      eventType: 'imported',
      title: 'Severance.S02E03.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb',
      mediaKey: `tv:tvdb:${SEV}:s02e03`,
      kind: 'tv',
      date: Date.parse('2025-10-24T15:06:12Z'),
      message: undefined,
    });
    const pack = h.find((e) => e.downloadId.startsWith('8C21'))!;
    expect(pack.mediaKey).toBe(`tv:tvdb:${SLOW}:s04`);
    const failed = h.find((e) => e.eventType === 'failed')!;
    expect(failed.message).toBe('Aborted, cannot be completed - https://sabnzbd.org/not-complete');
    expect(failed.mediaKey).toBe(`tv:tvdb:${ANDOR}:s02e01`);
  });
});

describe('parseArrHistory (radarr, lidarr)', () => {
  it('radarr: movie keys; movieFileDeleted ignored', () => {
    const h = parseArrHistory('radarr', fixture('radarr-history.json'));
    expect(h.map((e) => [e.eventType, e.mediaKey])).toEqual([
      ['grabbed', 'movie:tmdb:786892'],
      ['imported', 'movie:tmdb:693134'],
      ['grabbed', 'movie:tmdb:693134'],
    ]);
  });

  it('lidarr: trackFileImported + downloadImported collapse into one import; albumImportIncomplete ignored', () => {
    const h = parseArrHistory('lidarr', fixture('lidarr-history.json'));
    expect(h.map((e) => e.eventType)).toEqual(['imported', 'grabbed']);
    expect(h[0]).toMatchObject({
      downloadId: '0BEEC7B5EA3F0FDBC95D0DD47F3C5BC275DA8A33',
      mediaKey: 'music:mb:a74b1b7f-71a5-4011-9441-d0b5e4122711:6e335887-60ba-38f0-95af-fae7774336bf',
      date: Date.parse('2025-10-24T15:20:09Z'),
      kind: 'music',
    });
  });
});

describe('arrEventType', () => {
  it.each([
    ['grabbed', 'grabbed'],
    ['Grabbed', 'grabbed'],
    ['downloadFolderImported', 'imported'],
    ['DownloadFolderImported', 'imported'],
    ['downloadImported', 'imported'],
    ['trackFileImported', 'imported'],
    ['downloadFailed', 'failed'],
    ['episodeFileDeleted', undefined],
    ['downloadIgnored', undefined],
    ['seriesFolderImported', undefined],
  ])('%s → %s', (raw, expected) => expect(arrEventType(raw)).toBe(expected));
});

describe('sonarrMediaKey', () => {
  const series = { tvdbId: 1234 };
  const ep = (s: number, e: number) => ({ series, episode: { seasonNumber: s, episodeNumber: e } });
  it.each([
    ['single episode', [ep(1, 2)], 'Show.S01E02.1080p', 'tv:tvdb:1234:s01e02'],
    ['multi-episode file → first episode', [ep(1, 2), ep(1, 3)], 'Show.S01E02E03.1080p', 'tv:tvdb:1234:s01e02'],
    ['season pack by title', [ep(3, 1)], 'Show.S03.1080p.WEB', 'tv:tvdb:1234:s03'],
    ['season pack by episode count', [ep(3, 1), ep(3, 2), ep(3, 3)], 'Show Complete 1080p', 'tv:tvdb:1234:s03'],
    ['"Season 2" naming', [{ series }], 'Show Season 2 1080p', 'tv:tvdb:1234:s02'],
    ['multi-season pack → show level', [ep(1, 1), ep(2, 1)], 'Show.S01-S02.1080p', 'tv:tvdb:1234'],
    ['no episode objects → parse title', [{ series }], 'Show.S05E10.720p', 'tv:tvdb:1234:s05e10'],
    ['fullSeason hint', [{ ...ep(4, 1), data: { fullSeason: 'True' } }], 'Weird Name', 'tv:tvdb:1234:s04'],
    ['no tvdb id', [{ series: { tvdbId: 0 }, episode: { seasonNumber: 1, episodeNumber: 1 } }], 'Show.S01E01', undefined],
  ])('%s', (_name, recs, title, expected) => {
    expect(sonarrMediaKey(recs, title)).toBe(expected);
  });
});

describe('parseArrHealth', () => {
  it('maps type/message/source', () => {
    expect(parseArrHealth(fixture('sonarr-health.json'))).toEqual([
      { type: 'warning', message: 'Indexers unavailable due to failures: NZBgeek (Prowlarr)', source: 'IndexerStatusCheck' },
      { type: 'error', message: 'Unable to communicate with qBittorrent. Connection refused (switchyard:8081)', source: 'DownloadClientCheck' },
      { type: 'notice', message: 'New update is available', source: 'UpdateCheck' },
    ]);
  });
});

describe('createArr', () => {
  it('validates config and kind', () => {
    expect(() => createArr(cfg({ kind: 'sonarr', url: 'http://s:8989' }), makeCtx())).toThrow(/`apiKey` is required/);
    expect(() => createArr(cfg({ kind: 'readarr', url: 'http://s:8989', apiKey: 'k' }), makeCtx())).toThrow(/unsupported/);
  });

  it.each([
    ['sonarr', '/api/v3', 'includeSeries', 'Sonarr'],
    ['radarr', '/api/v3', 'includeMovie', 'Radarr'],
    ['lidarr', '/api/v1', 'includeArtist', 'Lidarr'],
  ])('%s polls queue/history/health on %s with X-Api-Key', async (kind, prefix, include, label) => {
    const calls = stubFetch(({ url }) => {
      const what = url.pathname.split('/').pop();
      if (what === 'health') return json(kind === 'sonarr' ? fixture('sonarr-health.json') : []);
      return json(fixture(`${kind}-${what}.json`));
    });
    const ctx = makeCtx();
    const c = createArr(cfg({ kind, id: `${kind}-main`, url: `http://switchyard:1234/${kind}`, apiKey: 'arr-secret-key' }), ctx);
    expect(c.intervalMs).toBe(15_000);
    await c.poll(NOW);
    expect(calls.map((x) => x.url.pathname)).toEqual([
      `/${kind}${prefix}/queue`,
      `/${kind}${prefix}/history`,
      `/${kind}${prefix}/health`,
    ]);
    for (const call of calls) expect(call.headers.get('x-api-key')).toBe('arr-secret-key');
    expect(calls[0].url.searchParams.get(include)).toBe('true');
    expect(calls[1].url.searchParams.get('sortKey')).toBe('date');
    expect(calls[1].url.searchParams.get('sortDirection')).toBe('descending');
    const fact = ctx.facts.arr.get(`${kind}-main`)!;
    expect(fact).toMatchObject({ app: kind, label, at: NOW });
    expect(fact.queue.length).toBeGreaterThan(0);
    expect(fact.history.length).toBeGreaterThan(0);
  });

  it('uses a custom label', async () => {
    stubFetch(() => json([]));
    const ctx = makeCtx();
    await createArr(cfg({ kind: 'sonarr', url: 'http://s:8989', apiKey: 'k', label: 'Sonarr 4K' }), ctx).poll(NOW);
    expect(ctx.facts.arr.get('sonarr')).toMatchObject({ label: 'Sonarr 4K', queue: [], history: [], health: [] });
  });

  it('reports auth failures without the key', async () => {
    stubFetch(() => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
    const err = (await createArr(cfg({ kind: 'radarr', url: 'http://r:7878', apiKey: 'arr-secret-key' }), makeCtx())
      .poll(NOW)
      .catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/401 Unauthorized from http:\/\/r:7878\/api\/v3\//);
    expect(err.message).not.toContain('arr-secret-key');
  });
});
