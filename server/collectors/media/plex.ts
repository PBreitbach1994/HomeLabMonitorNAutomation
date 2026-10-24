// Plex Media Server: /status/sessions (now playing) and /library/recentlyAdded (for the pipeline's
// "In Plex" stage). X-Plex-Token header, Accept: application/json.
//
// recentlyAdded items carry their *own* guids, but the pipeline keys TV by the *show's* tvdb id
// (and music by the artist's MBID), so episodes/seasons/albums need their parent looked up via
// /library/metadata/{ratingKey}; those lookups are cached by ratingKey.

import type { CollectorConfig } from '../../config.ts';
import type { PlexFact, PlexSessionFact } from '../../facts.ts';
import { str, type Collector, type CollectorContext } from '../types.ts';
import {
  fromUnix, getJson, intervalMs, list, mapLimit, numOrNull, obj, optionalString, requireString, requireUrl,
  stringMap, uniq, type Json,
} from './common.ts';
import { movieKey, musicKey, tvKey } from './keys.ts';

const pad = (n: number) => String(n).padStart(2, '0');

// ------------------------------------------------------------------ sessions

export interface PlexSessionOptions {
  /** Player address / machineIdentifier / title → topology node id. */
  clients?: Record<string, string>;
  /** Node id of the topology's `internet` node, used for remote players. */
  internetId?: string;
}

function sessionTitle(m: Json): string {
  const title = str(m.title);
  const type = str(m.type);
  if (type === 'episode') {
    const s = numOrNull(m.parentIndex);
    const e = numOrNull(m.index);
    const se = s != null && e != null ? `S${pad(s)}E${pad(e)}` : '';
    return [str(m.grandparentTitle), se, title].filter(Boolean).join(' · ') || 'Unknown';
  }
  if (type === 'track') return [str(m.grandparentTitle), title].filter(Boolean).join(' — ') || 'Unknown';
  const year = numOrNull(m.year);
  return title ? (type === 'movie' && year ? `${title} (${year})` : title) : 'Unknown';
}

export function parsePlexSessions(json: unknown, opts: PlexSessionOptions = {}): PlexSessionFact[] {
  const clients = opts.clients ?? {};
  return list(obj(obj(json).MediaContainer).Metadata).map((raw, i) => {
    const m = obj(raw);
    const player = obj(m.Player);
    const session = obj(m.Session);
    const location = str(session.location).toLowerCase();
    const local = location ? location === 'lan' : player.local === true || player.local === 1 || player.local === '1';
    const kbps = numOrNull(session.bandwidth) ?? numOrNull(obj(list(m.Media)[0]).bitrate) ?? 0;
    const address = str(player.address);
    const mapped = clients[address] ?? clients[str(player.machineIdentifier)] ?? clients[str(player.title)];
    return {
      id: str(session.id) || str(m.sessionKey) || `session-${i}`,
      title: sessionTitle(m),
      user: str(obj(m.User).title, 'Unknown'),
      player: str(player.title) || str(player.product) || str(player.device) || 'Unknown player',
      bandwidthBps: Math.max(0, kbps) * 1000,
      local,
      nodeId: mapped ?? (local ? undefined : opts.internetId),
    };
  });
}

// ------------------------------------------------------------------ library ids

export interface PlexIds {
  tvdb?: string;
  tmdb?: string;
  imdb?: string;
  mbid?: string;
  /** Show-level tvdb id from a legacy `com.plexapp.agents.thetvdb://<show>/<s>/<e>` guid. */
  legacyShowTvdb?: string;
}

/** Ids from `Guid: [{ id: 'tvdb://123' }]` (includeGuids=1) and legacy-agent `guid` strings. */
export function plexIds(meta: unknown): PlexIds {
  const m = obj(meta);
  const ids: PlexIds = {};
  for (const g of list(m.Guid)) {
    const match = /^([a-z]+):\/\/(.+)$/i.exec(str(obj(g).id));
    if (!match) continue;
    const scheme = match[1].toLowerCase();
    const value = match[2];
    if (scheme === 'tvdb') ids.tvdb ??= value;
    else if (scheme === 'tmdb') ids.tmdb ??= value;
    else if (scheme === 'imdb') ids.imdb ??= value;
    else if (scheme === 'mbid') ids.mbid ??= value.toLowerCase();
  }
  const legacy = str(m.guid);
  const tvdb = /agents\.thetvdb:\/\/(\d+)/.exec(legacy) ?? /agents\.hama:\/\/tvdb\d?-(\d+)/.exec(legacy);
  if (tvdb) ids.legacyShowTvdb = tvdb[1];
  const tmdb = /agents\.themoviedb:\/\/(\d+)/.exec(legacy);
  if (tmdb) ids.tmdb ??= tmdb[1];
  const imdb = /agents\.imdb:\/\/(tt\d+)/.exec(legacy);
  if (imdb) ids.imdb ??= imdb[1];
  const mbid = /(?:musicbrainz|mbid)[^/]*:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(legacy);
  if (mbid) ids.mbid ??= mbid[1].toLowerCase();
  return ids;
}

const hasIds = (ids: PlexIds) => !!(ids.tvdb || ids.tmdb || ids.imdb || ids.mbid || ids.legacyShowTvdb);

export interface PlexItem {
  type: string; // movie | show | season | episode | artist | album | track
  ratingKey: string;
  title: string;
  parentTitle?: string;
  grandparentTitle?: string;
  parentKey?: string;
  grandparentKey?: string;
  index?: number;
  parentIndex?: number;
  year?: number;
  leafCount?: number;
  addedAt: number; // ms
  updatedAt?: number; // ms
  ids: PlexIds;
}

export function parsePlexItems(json: unknown): PlexItem[] {
  return list(obj(obj(json).MediaContainer).Metadata).map((raw) => {
    const m = obj(raw);
    return {
      type: str(m.type),
      ratingKey: str(m.ratingKey),
      title: str(m.title),
      parentTitle: str(m.parentTitle) || undefined,
      grandparentTitle: str(m.grandparentTitle) || undefined,
      parentKey: str(m.parentRatingKey) || undefined,
      grandparentKey: str(m.grandparentRatingKey) || undefined,
      index: numOrNull(m.index) ?? undefined,
      parentIndex: numOrNull(m.parentIndex) ?? undefined,
      year: numOrNull(m.year) ?? undefined,
      leafCount: numOrNull(m.leafCount) ?? undefined,
      addedAt: fromUnix(m.addedAt) ?? 0,
      updatedAt: fromUnix(m.updatedAt) ?? undefined,
      ids: plexIds(m),
    };
  });
}

/** ratingKeys whose ids are needed to key this item (show for TV, artist/album for music). */
export function plexLookupKeys(item: PlexItem): string[] {
  const keys: (string | undefined)[] = [];
  switch (item.type) {
    case 'episode':
      if (!item.ids.legacyShowTvdb) keys.push(item.grandparentKey);
      break;
    case 'season':
      if (!item.ids.legacyShowTvdb) keys.push(item.parentKey);
      break;
    case 'album':
      keys.push(item.parentKey);
      break;
    case 'track':
      keys.push(item.parentKey, item.grandparentKey);
      break;
  }
  return keys.filter((k): k is string => !!k);
}

export type PlexAdded = PlexFact['recentlyAdded'][number];

/**
 * Turns recentlyAdded items into pipeline keys. Episodes also roll up to their season key
 * (so a season-pack import verifies once its episodes land), and season items expand to their
 * episodes when `children` has them.
 */
export function plexRecentlyAdded(
  items: PlexItem[],
  resolve: (ratingKey: string | undefined) => PlexIds | undefined,
  children: (seasonRatingKey: string) => PlexItem[] | undefined = () => undefined,
): PlexAdded[] {
  const out = new Map<string, PlexAdded>();
  const add = (mediaKey: string | undefined, title: string, addedAt: number) => {
    if (!mediaKey || !addedAt) return;
    const prev = out.get(mediaKey);
    if (!prev || addedAt > prev.addedAt) out.set(mediaKey, { mediaKey, title, addedAt });
  };
  const showTvdb = (own: PlexIds, parent: string | undefined) => {
    if (own.legacyShowTvdb) return own.legacyShowTvdb;
    const p = resolve(parent);
    return p?.tvdb ?? p?.legacyShowTvdb;
  };
  const addEpisode = (tvdb: string | undefined, show: string, season: number | undefined, ep: PlexItem) => {
    if (season == null || ep.index == null) return;
    add(tvKey(tvdb, season, ep.index), `${show} · S${pad(season)}E${pad(ep.index)}`, ep.addedAt);
    add(tvKey(tvdb, season), `${show} · Season ${season}`, ep.addedAt);
  };

  for (const it of items) {
    switch (it.type) {
      case 'movie':
        add(movieKey(it.ids.tmdb), it.year ? `${it.title} (${it.year})` : it.title, it.addedAt);
        break;
      case 'show':
        add(tvKey(it.ids.tvdb ?? it.ids.legacyShowTvdb), it.title, it.addedAt);
        break;
      case 'season': {
        const tvdb = showTvdb(it.ids, it.parentKey);
        const show = it.parentTitle ?? it.title;
        add(tvKey(tvdb, it.index), it.index != null ? `${show} · Season ${it.index}` : show, it.addedAt);
        for (const ep of children(it.ratingKey) ?? []) addEpisode(tvdb, show, ep.parentIndex ?? it.index, ep);
        break;
      }
      case 'episode':
        addEpisode(showTvdb(it.ids, it.grandparentKey), it.grandparentTitle ?? it.title, it.parentIndex, it);
        break;
      case 'album':
        add(musicKey(resolve(it.parentKey)?.mbid, it.ids.mbid), [it.parentTitle, it.title].filter(Boolean).join(' — '), it.addedAt);
        break;
      case 'track':
        add(
          musicKey(resolve(it.grandparentKey)?.mbid, resolve(it.parentKey)?.mbid),
          [it.grandparentTitle, it.parentTitle].filter(Boolean).join(' — '),
          it.addedAt,
        );
        break;
    }
  }
  return [...out.values()].sort((a, b) => b.addedAt - a.addedAt);
}

// ------------------------------------------------------------------ collector

const NEGATIVE_TTL_MS = 10 * 60_000;
const LOOKUPS_PER_POLL = 25;

export function createPlex(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = requireUrl(cfg);
  const token = requireString(cfg, 'token', 'X-Plex-Token of the server owner');
  const host = optionalString(cfg, 'host');
  const clients = stringMap(cfg, 'clients');
  const internetId = ctx.lab.topology.nodes.find((n) => n.kind === 'internet')?.id;
  const opts = { headers: { 'X-Plex-Token': token, Accept: 'application/json' }, secrets: [token] };
  const get = (path: string) => getJson(`${url}${path}`, opts);

  const idCache = new Map<string, { ids: PlexIds; at: number; ok: boolean }>();
  const childCache = new Map<string, { stamp: string; items: PlexItem[] }>();

  async function resolveIds(keys: string[], now: number): Promise<void> {
    const missing = uniq(keys)
      .filter((k) => {
        const c = idCache.get(k);
        return !c || (!c.ok && now - c.at > NEGATIVE_TTL_MS);
      })
      .slice(0, LOOKUPS_PER_POLL);
    await mapLimit(missing, 4, async (k) => {
      try {
        const json = await get(`/library/metadata/${encodeURIComponent(k)}?includeGuids=1`);
        const ids = plexIds(list(obj(obj(json).MediaContainer).Metadata)[0]);
        idCache.set(k, { ids, at: now, ok: hasIds(ids) });
      } catch {
        // Deleted / unmatched items: retry later rather than failing the whole poll.
        idCache.set(k, { ids: {}, at: now, ok: false });
      }
    });
  }

  async function loadSeasons(seasons: PlexItem[]): Promise<void> {
    const keep = new Set(seasons.map((s) => s.ratingKey));
    for (const k of childCache.keys()) if (!keep.has(k)) childCache.delete(k);
    const stale = seasons.filter((s) => {
      const stamp = `${s.addedAt}:${s.updatedAt ?? ''}:${s.leafCount ?? ''}`;
      return childCache.get(s.ratingKey)?.stamp !== stamp;
    });
    await mapLimit(stale.slice(0, LOOKUPS_PER_POLL), 4, async (s) => {
      const stamp = `${s.addedAt}:${s.updatedAt ?? ''}:${s.leafCount ?? ''}`;
      try {
        const json = await get(`/library/metadata/${encodeURIComponent(s.ratingKey)}/children`);
        childCache.set(s.ratingKey, { stamp, items: parsePlexItems(json).filter((i) => i.type === 'episode') });
      } catch {
        childCache.delete(s.ratingKey);
      }
    });
  }

  return {
    id: cfg.id,
    kind: 'plex',
    intervalMs: intervalMs(cfg, 10),
    domains: ['plex'],
    async poll(now) {
      const [sessionsJson, recentJson] = await Promise.all([
        get('/status/sessions'),
        get('/library/recentlyAdded?includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=50'),
      ]);
      const sessions = parsePlexSessions(sessionsJson, { clients, internetId });
      const items = parsePlexItems(recentJson);
      await resolveIds(items.flatMap(plexLookupKeys), now);
      await loadSeasons(items.filter((i) => i.type === 'season' && i.ratingKey));
      const recentlyAdded = plexRecentlyAdded(
        items,
        (k) => (k ? idCache.get(k)?.ids : undefined),
        (k) => childCache.get(k)?.items,
      );
      ctx.facts.plex = { host, sessions, recentlyAdded, at: now };
    },
  };
}
