import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACTORIES } from '../../index.ts';
import { getJson, intervalMs, parseDate, requireUrl, scrub } from '../common.ts';
import { MEDIA_FACTORIES } from '../index.ts';
import { episodeFromTitle, movieKey, musicKey, seasonPackFromTitle, tvKey } from '../keys.ts';
import { cfg, json, makeCtx, stubFetch } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

describe('media keys', () => {
  it('match the pipeline formats', () => {
    expect(tvKey(81189)).toBe('tv:tvdb:81189');
    expect(tvKey('81189', 1)).toBe('tv:tvdb:81189:s01');
    expect(tvKey(81189, 1, 2)).toBe('tv:tvdb:81189:s01e02');
    expect(tvKey(81189, 0, 3)).toBe('tv:tvdb:81189:s00e03'); // specials
    expect(tvKey(81189, 12, 105)).toBe('tv:tvdb:81189:s12e105');
    expect(tvKey(0, 1, 1)).toBeUndefined();
    expect(tvKey(null)).toBeUndefined();
    expect(movieKey(603)).toBe('movie:tmdb:603');
    expect(movieKey(undefined)).toBeUndefined();
    expect(musicKey('ABC', 'DEF')).toBe('music:mb:abc:def');
    expect(musicKey('abc')).toBe('music:mb:abc');
    expect(musicKey('')).toBeUndefined();
  });

  it('parse release names', () => {
    expect(episodeFromTitle('Show.S01E02.1080p')).toEqual({ season: 1, episode: 2 });
    expect(episodeFromTitle('Show.S01.1080p')).toBeUndefined();
    expect(seasonPackFromTitle('Show.S01.1080p')).toBe(1);
    expect(seasonPackFromTitle('Show S03 Complete')).toBe(3);
    expect(seasonPackFromTitle('Show.S01E02.1080p')).toBeUndefined();
    expect(seasonPackFromTitle('Show.2023.1080p')).toBeUndefined();
  });
});

describe('common', () => {
  it('scrubs secrets, raw and URL-encoded', () => {
    expect(scrub('key=a+b/c== and a%2Bb%2Fc%3D%3D', ['a+b/c=='])).toBe('key=*** and ***');
    expect(scrub('nothing here', [undefined, ''])).toBe('nothing here');
  });

  it('validates urls and intervals', () => {
    expect(requireUrl(cfg({ kind: 'x', url: 'http://h:1/base/' }))).toBe('http://h:1/base');
    expect(() => requireUrl(cfg({ kind: 'x', url: 'http://h:1/?apikey=1' }))).toThrow(/query string/);
    expect(() => requireUrl(cfg({ kind: 'x', url: 'ftp://h' }))).toThrow(/http/);
    expect(intervalMs(cfg({ kind: 'x' }), 5)).toBe(5000);
    expect(intervalMs(cfg({ kind: 'x', interval: 0.2 }), 5)).toBe(1000);
  });

  it('treats zone-less timestamps as UTC', () => {
    expect(parseDate('2025-10-24T15:41:10.0000000')).toBe(Date.parse('2025-10-24T15:41:10Z'));
    expect(parseDate('2025-10-24T15:41:10+02:00')).toBe(Date.parse('2025-10-24T13:41:10Z'));
    expect(parseDate('')).toBeNull();
  });

  it('times out with a clear, secret-free message', async () => {
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    await expect(getJson('http://h/api?apikey=topsecret', { timeoutMs: 20, secrets: ['topsecret'] })).rejects.toThrow(
      'http://h/api?apikey=***: no response within 0.02s',
    );
  });

  it('rejects non-JSON bodies (e.g. a login page)', async () => {
    stubFetch(() => new Response('<!DOCTYPE html><html>login</html>', { status: 200 }));
    await expect(getJson('http://h/api')).rejects.toThrow(/non-JSON/);
    stubFetch(() => json({ ok: 1 }));
    await expect(getJson('http://h/api')).resolves.toEqual({ ok: 1 });
  });
});

describe('registration', () => {
  it('registers every media kind with the runner', () => {
    for (const kind of ['sabnzbd', 'qbittorrent', 'sonarr', 'radarr', 'lidarr', 'plex', 'seerr', 'overseerr', 'jellyseerr', 'slskd']) {
      expect(MEDIA_FACTORIES[kind], kind).toBeTypeOf('function');
      expect(FACTORIES[kind], kind).toBe(MEDIA_FACTORIES[kind]);
    }
  });

  it.each([
    ['sabnzbd', { apiKey: 'k' }, 'downloads'],
    ['qbittorrent', {}, 'downloads'],
    ['sonarr', { apiKey: 'k' }, 'arr'],
    ['plex', { token: 't' }, 'plex'],
    ['seerr', { apiKey: 'k' }, 'requests'],
    ['slskd', { apiKey: 'k' }, 'downloads'],
  ])('%s builds a collector with id/kind/domains', (kind, extra, domain) => {
    const c = MEDIA_FACTORIES[kind](cfg({ kind, id: `my-${kind}`, url: 'http://h:1', ...extra }), makeCtx());
    expect(c.id).toBe(`my-${kind}`);
    expect(c.kind).toBe(kind);
    expect(c.domains).toEqual([domain]);
    expect(c.intervalMs).toBeGreaterThanOrEqual(1000);
  });
});
