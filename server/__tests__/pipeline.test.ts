import { describe, expect, it } from 'vitest';
import { FactStore, type ArrFact, type DownloadItemFact } from '../facts.ts';
import { correlate } from '../derive/pipeline.ts';

const NOW = 1_800_000_000_000;
const ep = 'tv:tvdb:100:s01e02';

function store(opts: { history?: ArrFact['history']; queue?: ArrFact['queue']; sabQueue?: DownloadItemFact[]; sabHistory?: DownloadItemFact[] }) {
  const f = new FactStore();
  f.arr.set('sonarr', { app: 'sonarr', label: 'Sonarr', queue: opts.queue ?? [], history: opts.history ?? [], health: [], at: NOW });
  f.downloads.set('sabnzbd', {
    client: 'sabnzbd', protocol: 'usenet', downBps: 0, upBps: 0, queue: opts.sabQueue ?? [], history: opts.sabHistory ?? [], at: NOW,
  });
  return f;
}

const grabbed = (id: string, date = NOW - 60_000, mediaKey = ep) =>
  ({ downloadId: id, eventType: 'grabbed', title: `Show.S01E02-${id}`, mediaKey, kind: 'tv', date }) as const;

describe('media pipeline correlation', () => {
  it('joins *arr grab and download client by downloadId (case-insensitive)', () => {
    const f = store({
      history: [grabbed('SABnzbd_nzo_ABC')],
      sabQueue: [{ id: 'sabnzbd_nzo_abc', name: 'Show.S01E02', status: 'downloading', progress: 0.42, updatedAt: NOW }],
    });
    const { items, tracked } = correlate(f, NOW);
    expect(tracked).toBe(1);
    expect(items[0].stages).toEqual({
      requested: 'inferred', grabbed: 'verified', downloading: 'active', downloaded: 'none', imported: 'none', available: 'none',
    });
    expect(items[0].status).toBe('Downloading');
    expect(items[0].progress).toBe(0.42);
  });

  it('verifies the request with a show-level Seerr key and infers skipped stages', () => {
    const f = store({
      history: [grabbed('n1'), { ...grabbed('n1'), eventType: 'imported', date: NOW - 10_000 }],
    });
    f.requests = [{ mediaKey: 'tv:tvdb:100', title: 'Show', requestedAt: NOW - 3600_000, status: 'approved' }];
    f.plex = { sessions: [], recentlyAdded: [{ mediaKey: ep, title: 'Show', addedAt: NOW - 5_000 }], at: NOW };
    const [item] = correlate(f, NOW).items;
    expect(item.stages).toEqual({
      requested: 'verified', grabbed: 'verified', downloading: 'inferred', downloaded: 'inferred', imported: 'verified', available: 'verified',
    });
    expect(item.status).toBe('In Plex');
  });

  it('does not count a declined request as requested', () => {
    const f = store({ history: [grabbed('n2')] });
    f.requests = [{ mediaKey: 'tv:tvdb:100', title: 'Show', requestedAt: NOW - 3600_000, status: 'declined' }];
    expect(correlate(f, NOW).items[0].stages.requested).toBe('inferred');
  });

  it('marks failures and import blocks', () => {
    const f = store({
      history: [grabbed('bad'), { ...grabbed('bad'), eventType: 'failed', date: NOW - 30_000 }, grabbed('stuck', NOW - 90_000, 'tv:tvdb:200:s01e01')],
      queue: [{ downloadId: 'stuck', title: 'Other.S01E01', kind: 'tv', status: 'completed', trackedState: 'importBlocked', trackedStatus: 'warning', messages: ["Release name didn't match"] }],
      sabHistory: [{ id: 'stuck', name: 'Other.S01E01', status: 'completed', progress: 1, updatedAt: NOW - 80_000 }],
    });
    const items = correlate(f, NOW).items;
    const bad = items.find((i) => i.id === 'bad')!;
    const stuck = items.find((i) => i.id === 'stuck')!;
    expect(bad.stages.downloaded).toBe('failed');
    expect(bad.status).toBe('Downloading failed');
    expect(stuck.stages.imported).toBe('blocked');
    expect(stuck.current).toBe('imported');
  });

  it('demotes a failure once a later release of the same media is imported', () => {
    const f = store({
      history: [
        grabbed('old', NOW - 600_000), { ...grabbed('old'), eventType: 'failed', date: NOW - 500_000 },
        grabbed('new', NOW - 400_000), { ...grabbed('new'), eventType: 'imported', date: NOW - 100_000 },
      ],
    });
    const items = correlate(f, NOW).items;
    expect(items.find((i) => i.id === 'old')!.status).toBe('Failed · replaced');
  });

  it('sorts active work first', () => {
    const f = store({
      history: [grabbed('done', NOW - 5000), { ...grabbed('done'), eventType: 'imported', date: NOW - 1000 }, grabbed('live', NOW - 600_000, 'tv:tvdb:300:s02e01')],
      sabQueue: [{ id: 'live', name: 'x', status: 'downloading', progress: 0.1, updatedAt: NOW - 600_000 }],
    });
    expect(correlate(f, NOW).items.map((i) => i.id)).toEqual(['live', 'done']);
  });
});
