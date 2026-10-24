import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSabnzbd, parseSabHistory, parseSabQueue, sabStatus } from '../sabnzbd.ts';
import { NOW, cfg, fixture, json, makeCtx, stubFetch } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

describe('parseSabQueue', () => {
  const q = parseSabQueue(fixture('sabnzbd-queue.json'), NOW);

  it('converts kbpersec (KiB/s) to bits per second', () => {
    expect(q.downBps).toBe(12800 * 1024 * 8);
    expect(q.paused).toBe(false);
  });

  it('maps slots onto download items', () => {
    expect(q.queue.map((i) => [i.id, i.status])).toEqual([
      ['SABnzbd_nzo_tlou0204', 'downloading'],
      ['SABnzbd_nzo_queued01', 'queued'],
      ['SABnzbd_nzo_paused01', 'paused'],
      ['SABnzbd_nzo_propag01', 'queued'],
      ['SABnzbd_nzo_grab0001', 'queued'],
    ]);
    const active = q.queue[0];
    expect(active.name).toBe('The.Last.of.Us.S02E04.1080p.WEB.H264-SuccessfulCrab');
    expect(active.progress).toBeCloseTo(0.6);
    expect(active.sizeBytes).toBe(Math.round(4687.33 * 1024 * 1024));
    expect(active.speedBps).toBe(q.downBps);
    expect(active.category).toBe('tv');
    expect(active.updatedAt).toBe(NOW);
    expect(q.queue[1].speedBps).toBeUndefined();
  });

  it('falls back to mb/mbleft when percentage is missing', () => {
    const propagating = q.queue.find((i) => i.id === 'SABnzbd_nzo_propag01')!;
    expect(propagating.progress).toBe(0);
    const p = parseSabQueue({ queue: { kbpersec: '0', paused: true, slots: [{ nzo_id: 'x', status: 'Downloading', mb: '100', mbleft: '25' }] } }, NOW);
    expect(p.queue[0].progress).toBeCloseTo(0.75);
    expect(p.paused).toBe(true);
  });

  it('throws SABnzbd API errors (HTTP 200 + status:false)', () => {
    expect(() => parseSabQueue({ status: false, error: 'API Key Incorrect' }, NOW)).toThrow('SABnzbd: API Key Incorrect');
  });
});

describe('parseSabHistory', () => {
  const h = parseSabHistory(fixture('sabnzbd-history.json'), NOW);

  it('maps statuses, timestamps and failure messages', () => {
    expect(h.map((i) => [i.id, i.status])).toEqual([
      ['SABnzbd_nzo_tlou0203', 'extracting'],
      ['SABnzbd_nzo_sev0203x', 'completed'],
      ['SABnzbd_nzo_andor201', 'failed'],
      ['SABnzbd_nzo_dune2160', 'completed'],
    ]);
    const [extracting, done, failed] = h;
    expect(extracting.updatedAt).toBe(NOW); // completed = 0 while post-processing
    expect(extracting.message).toBe('Unpacking: 14/40');
    expect(done.updatedAt).toBe(Date.parse('2025-10-24T15:05:00Z'));
    expect(done.progress).toBe(1);
    expect(done.sizeBytes).toBe(3328599654);
    expect(done.message).toBeUndefined();
    expect(failed.message).toBe('Aborted, cannot be completed - https://sabnzbd.org/not-complete');
    expect(failed.progress).toBeNull();
  });
});

describe('sabStatus', () => {
  it.each([
    ['Fetching', 'queue', 'downloading'],
    ['Checking', 'queue', 'queued'],
    ['QuickCheck', 'history', 'verifying'],
    ['Repairing', 'history', 'verifying'],
    ['Queued', 'history', 'verifying'],
    ['Moving', 'history', 'extracting'],
    ['Running', 'history', 'extracting'],
  ] as const)('%s in %s → %s', (raw, where, expected) => {
    expect(sabStatus(raw, where)).toBe(expected);
  });
});

describe('createSabnzbd', () => {
  it('validates config', () => {
    const ctx = makeCtx();
    expect(() => createSabnzbd(cfg({ kind: 'sabnzbd', apiKey: 'k' }), ctx)).toThrow(/`url` is required/);
    expect(() => createSabnzbd(cfg({ kind: 'sabnzbd', url: 'http://sab:8080' }), ctx)).toThrow(/`apiKey` is required/);
    expect(() => createSabnzbd(cfg({ kind: 'sabnzbd', url: 'sab:8080', apiKey: 'k' }), ctx)).toThrow(/http/);
  });

  it('polls queue + history and writes the downloads fact', async () => {
    const calls = stubFetch(({ url }) =>
      json(fixture(url.searchParams.get('mode') === 'queue' ? 'sabnzbd-queue.json' : 'sabnzbd-history.json')),
    );
    const ctx = makeCtx();
    const c = createSabnzbd(cfg({ id: 'sab', kind: 'sabnzbd', url: 'http://sab:8080/', apiKey: 'secret-key-123', host: 'switchyard', interval: 3 }), ctx);
    expect(c.intervalMs).toBe(3000);
    expect(c.domains).toEqual(['downloads']);
    await c.poll(NOW);
    expect(calls.map((x) => x.url.pathname)).toEqual(['/api', '/api']);
    expect(calls[1].url.searchParams.get('limit')).toBe('50');
    expect(calls[0].url.searchParams.get('apikey')).toBe('secret-key-123');
    const f = ctx.facts.downloads.get('sab')!;
    expect(f).toMatchObject({ client: 'sabnzbd', protocol: 'usenet', host: 'switchyard', upBps: 0, at: NOW });
    expect(f.queue).toHaveLength(5);
    expect(f.history).toHaveLength(4);
  });

  it('never leaks the API key in errors', async () => {
    stubFetch(() => new Response('nope', { status: 500, statusText: 'Internal Server Error' }));
    const c = createSabnzbd(cfg({ kind: 'sabnzbd', url: 'http://sab:8080', apiKey: 'secret-key-123' }), makeCtx());
    const err = await c.poll(NOW).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('500');
    expect((err as Error).message).not.toContain('secret-key-123');

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    const err2 = await c.poll(NOW).catch((e: Error) => e);
    expect((err2 as Error).message).toMatch(/ECONNREFUSED/);
    expect((err2 as Error).message).not.toContain('secret-key-123');
  });
});
