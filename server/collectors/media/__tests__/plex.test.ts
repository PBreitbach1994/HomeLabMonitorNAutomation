import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlex, parsePlexItems, parsePlexSessions, plexIds, plexLookupKeys, plexRecentlyAdded, type PlexIds,
} from '../plex.ts';
import { NOW, cfg, fixture, json, makeCtx, stubFetch } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

describe('parsePlexSessions', () => {
  const sessions = parsePlexSessions(fixture('plex-sessions.json'), {
    clients: { '192.168.4.120': 'livingroom' },
    internetId: 'wan',
  });

  it('local session mapped via clients', () => {
    expect(sessions[0]).toEqual({
      id: 'a8e1b9c7d2f34e5a9b0c1d2e',
      title: 'Severance · S02E03 · Who Is Alive?',
      user: 'householder',
      player: 'Living Room TV',
      bandwidthBps: 9480 * 1000,
      local: true,
      nodeId: 'livingroom',
    });
  });

  it('remote session goes to the internet node', () => {
    expect(sessions[1]).toMatchObject({
      title: 'Dune: Part Two (2024)',
      user: 'remote-friend',
      player: 'Den Apple TV',
      bandwidthBps: 7_200_000,
      local: false,
      nodeId: 'wan',
    });
  });

  it('unmapped local player has no nodeId (topology falls back to the Plex host side)', () => {
    expect(sessions[2]).toMatchObject({ title: 'Radiohead — 15 Step', player: 'iPhone', local: true, nodeId: undefined, bandwidthBps: 1_411_000 });
  });

  it('handles an idle server and falls back to Player.local / Media bitrate', () => {
    expect(parsePlexSessions({ MediaContainer: { size: 0 } })).toEqual([]);
    const [s] = parsePlexSessions(
      { MediaContainer: { Metadata: [{ type: 'movie', title: 'X', sessionKey: '9', Media: [{ bitrate: 4000 }], Player: { title: 'TV', local: false }, User: { title: 'u' } }] } },
      { internetId: 'wan' },
    );
    expect(s).toMatchObject({ id: '9', local: false, nodeId: 'wan', bandwidthBps: 4_000_000 });
  });

  it('can map clients by machineIdentifier too', () => {
    const [, remote] = parsePlexSessions(fixture('plex-sessions.json'), { clients: { f0e1d2c3b4a59687: 'livingroom' }, internetId: 'wan' });
    expect(remote.nodeId).toBe('livingroom');
  });
});

describe('plexIds', () => {
  it.each([
    [{ Guid: [{ id: 'imdb://tt1' }, { id: 'tmdb://603' }, { id: 'tvdb://81189' }] }, { imdb: 'tt1', tmdb: '603', tvdb: '81189' }],
    [{ guid: 'com.plexapp.agents.thetvdb://81189/5/16?lang=en' }, { legacyShowTvdb: '81189' }],
    [{ guid: 'com.plexapp.agents.hama://tvdb-81189/1/1?lang=en' }, { legacyShowTvdb: '81189' }],
    [{ guid: 'com.plexapp.agents.themoviedb://603?lang=en' }, { tmdb: '603' }],
    [{ guid: 'com.plexapp.agents.imdb://tt0133093?lang=en' }, { imdb: 'tt0133093' }],
    [{ Guid: [{ id: 'mbid://A74B1B7F-71A5-4011-9441-D0B5E4122711' }] }, { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711' }],
    [{ guid: 'plex://movie/5d776' }, {}],
  ])('%j', (meta, expected) => expect(plexIds(meta)).toEqual(expected));
});

describe('plexRecentlyAdded', () => {
  const items = parsePlexItems(fixture('plex-recently-added.json'));
  const parents: Record<string, PlexIds> = {
    1001: plexIds(fixture<any>('plex-metadata-1001.json').MediaContainer.Metadata[0]),
    2001: plexIds(fixture<any>('plex-metadata-2001.json').MediaContainer.Metadata[0]),
    5012: plexIds(fixture<any>('plex-metadata-5012.json').MediaContainer.Metadata[0]),
  };
  const children = { 2004: parsePlexItems(fixture('plex-children-2004.json')) };

  it('asks for the parents it needs (not for legacy-agent items)', () => {
    expect(items.flatMap(plexLookupKeys)).toEqual(['2001', '1001', '5012']);
  });

  it('keys episodes by the show tvdb id, seasons by season, movies by tmdb, albums by MBIDs', () => {
    const added = plexRecentlyAdded(items, (k) => (k ? parents[k] : undefined), (k) => children[k as '2004']);
    const at = (s: number) => s * 1000;
    expect(added).toEqual([
      { mediaKey: 'tv:tvdb:413066:s02', title: 'Shrinking · Season 2', addedAt: at(1761321000) },
      { mediaKey: 'tv:tvdb:413066:s02e03', title: 'Shrinking · S02E03', addedAt: at(1761320900) },
      { mediaKey: 'tv:tvdb:413066:s02e02', title: 'Shrinking · S02E02', addedAt: at(1761320600) },
      { mediaKey: 'tv:tvdb:413066:s02e01', title: 'Shrinking · S02E01', addedAt: at(1761320300) },
      { mediaKey: 'music:mb:a74b1b7f-71a5-4011-9441-d0b5e4122711:6e335887-60ba-38f0-95af-fae7774336bf', title: 'Radiohead — In Rainbows', addedAt: at(1761319300) },
      { mediaKey: 'tv:tvdb:371980:s02e03', title: 'Severance · S02E03', addedAt: at(1761318500) },
      { mediaKey: 'tv:tvdb:371980:s02', title: 'Severance · Season 2', addedAt: at(1761318500) },
      { mediaKey: 'movie:tmdb:693134', title: 'Dune: Part Two (2024)', addedAt: at(1761311100) },
      { mediaKey: 'tv:tvdb:81189:s05e16', title: 'Breaking Bad · S05E16', addedAt: at(1761200000) },
      { mediaKey: 'tv:tvdb:81189:s05', title: 'Breaking Bad · Season 5', addedAt: at(1761200000) },
    ]);
  });

  it('never uses an episode/season own tvdb id as the show id', () => {
    const added = plexRecentlyAdded(items, () => undefined);
    expect(added.map((a) => a.mediaKey)).toEqual(['movie:tmdb:693134', 'tv:tvdb:81189:s05e16', 'tv:tvdb:81189:s05']);
  });
});

describe('createPlex', () => {
  it('validates config', () => {
    expect(() => createPlex(cfg({ kind: 'plex', url: 'http://plex:32400' }), makeCtx())).toThrow(/`token` is required/);
    expect(() => createPlex(cfg({ kind: 'plex', url: 'http://plex:32400', token: 't0ken', clients: ['x'] }), makeCtx())).toThrow(/map/);
  });

  it('polls sessions + recentlyAdded, caches parent lookups and season children', async () => {
    const calls = stubFetch(({ url }) => {
      const p = url.pathname;
      if (p === '/status/sessions') return json(fixture('plex-sessions.json'));
      if (p === '/library/recentlyAdded') return json(fixture('plex-recently-added.json'));
      if (p === '/library/metadata/2004/children') return json(fixture('plex-children-2004.json'));
      const m = /^\/library\/metadata\/(\d+)$/.exec(p);
      if (m && ['1001', '2001', '5012'].includes(m[1])) return json(fixture(`plex-metadata-${m[1]}.json`));
      return undefined;
    });
    const ctx = makeCtx();
    const c = createPlex(cfg({ kind: 'plex', url: 'http://192.168.4.79:32400', token: 'plex-token-xyz', host: 'nichnas', clients: { '192.168.4.120': 'livingroom' } }), ctx);
    expect(c.domains).toEqual(['plex']);
    await c.poll(NOW);

    for (const call of calls) {
      expect(call.headers.get('x-plex-token')).toBe('plex-token-xyz');
      expect(call.headers.get('accept')).toBe('application/json');
      expect(call.url.search).not.toContain('plex-token-xyz');
    }
    const recent = calls.find((x) => x.url.pathname === '/library/recentlyAdded')!;
    expect(recent.url.searchParams.get('includeGuids')).toBe('1');
    expect(recent.url.searchParams.get('X-Plex-Container-Size')).toBe('50');

    const plex = ctx.facts.plex!;
    expect(plex.host).toBe('nichnas');
    expect(plex.at).toBe(NOW);
    expect(plex.sessions.map((s) => s.nodeId)).toEqual(['livingroom', 'wan', undefined]);
    expect(plex.recentlyAdded.map((a) => a.mediaKey)).toContain('tv:tvdb:371980:s02e03');
    expect(plex.recentlyAdded.map((a) => a.mediaKey)).toContain('tv:tvdb:413066:s02e01');

    const lookups = calls.filter((x) => x.url.pathname.startsWith('/library/metadata')).length;
    expect(lookups).toBe(4); // 3 parents + 1 season's children
    await c.poll(NOW + 10_000);
    expect(calls.filter((x) => x.url.pathname.startsWith('/library/metadata')).length).toBe(lookups); // all cached
  });

  it('survives a failing parent lookup', async () => {
    stubFetch(({ url }) => {
      if (url.pathname === '/status/sessions') return json({ MediaContainer: { size: 0 } });
      if (url.pathname === '/library/recentlyAdded') return json(fixture('plex-recently-added.json'));
      return new Response('boom', { status: 500 });
    });
    const ctx = makeCtx();
    await createPlex(cfg({ kind: 'plex', url: 'http://plex:32400', token: 'plex-token-xyz' }), ctx).poll(NOW);
    expect(ctx.facts.plex!.sessions).toEqual([]);
    expect(ctx.facts.plex!.recentlyAdded.map((a) => a.mediaKey)).toEqual(['movie:tmdb:693134', 'tv:tvdb:81189:s05e16', 'tv:tvdb:81189:s05']);
  });
});
