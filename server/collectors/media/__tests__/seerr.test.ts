import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSeerr, parseSeerrRequests, seerrMediaRefs, seerrStatus } from '../seerr.ts';
import { NOW, cfg, fixture, json, makeCtx, stubFetch } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

describe('parseSeerrRequests', () => {
  it('keys tv by tvdb and movies by tmdb; skips shows without a tvdb id', () => {
    const reqs = parseSeerrRequests(fixture('seerr-requests.json'));
    expect(reqs).toEqual([
      { mediaKey: 'movie:tmdb:786892', title: 'Movie (TMDB 786892)', requestedAt: Date.parse('2025-10-24T15:00:00Z'), status: 'declined' },
      { mediaKey: 'tv:tvdb:392256', title: 'Series (TMDB 100088)', requestedAt: Date.parse('2025-10-22T20:00:00Z'), status: 'pending' },
      { mediaKey: 'tv:tvdb:371980', title: 'Series (TMDB 95396)', requestedAt: Date.parse('2025-10-20T18:30:00Z'), status: 'partially available' },
      { mediaKey: 'movie:tmdb:693134', title: 'Movie (TMDB 693134)', requestedAt: Date.parse('2025-10-24T12:30:00Z'), status: 'available' },
    ]);
  });

  it('uses looked-up titles', () => {
    const reqs = parseSeerrRequests(fixture('seerr-requests.json'), (r) => (r.tmdbId === 95396 ? 'Severance (2022)' : undefined));
    expect(reqs.find((r) => r.mediaKey === 'tv:tvdb:371980')!.title).toBe('Severance (2022)');
  });

  it('lists the media to look titles up for', () => {
    expect(seerrMediaRefs(fixture('seerr-requests.json'))).toEqual([
      { type: 'movie', tmdbId: 786892 },
      { type: 'tv', tmdbId: 555555 },
      { type: 'tv', tmdbId: 100088 },
      { type: 'tv', tmdbId: 95396 },
      { type: 'movie', tmdbId: 693134 },
    ]);
  });
});

describe('seerrStatus', () => {
  it.each([
    [1, 2, 'pending'],
    [2, 2, 'approved'],
    [2, 3, 'processing'],
    [2, 5, 'available'],
    [3, 5, 'declined'],
    [4, 3, 'failed'],
    [5, 5, 'available'],
    [5, 1, 'completed'],
  ])('request %s / media %s → %s', (r, m, expected) => expect(seerrStatus(r, m)).toBe(expected));
});

describe('createSeerr', () => {
  it('validates config', () => {
    expect(() => createSeerr(cfg({ kind: 'seerr', url: 'http://seerr:5055' }), makeCtx())).toThrow(/`apiKey` is required/);
  });

  it('polls requests, looks up titles once, and writes facts.requests', async () => {
    const calls = stubFetch(({ url }) => {
      if (url.pathname === '/api/v1/request') return json(fixture('seerr-requests.json'));
      if (url.pathname === '/api/v1/movie/693134') return json(fixture('seerr-movie-693134.json'));
      if (url.pathname === '/api/v1/tv/95396') return json(fixture('seerr-tv-95396.json'));
      return undefined; // others 404 → fallback title, retried later
    });
    const ctx = makeCtx();
    const c = createSeerr(cfg({ kind: 'seerr', url: 'http://seerr:5055', apiKey: 'seerr-secret' }), ctx);
    expect(c.domains).toEqual(['requests']);
    await c.poll(NOW);
    const req = calls[0];
    expect(req.headers.get('x-api-key')).toBe('seerr-secret');
    expect(Object.fromEntries(req.url.searchParams)).toMatchObject({ take: '50', skip: '0', sort: 'added' });
    expect(ctx.facts.requests.map((r) => r.title)).toEqual([
      'Movie (TMDB 786892)',
      'Series (TMDB 100088)',
      'Severance (2022)',
      'Dune: Part Two (2024)',
    ]);

    const before = calls.length;
    await c.poll(NOW + 60_000);
    expect(calls.length - before).toBe(1); // only the request list; titles cached, misses back off
  });
});
