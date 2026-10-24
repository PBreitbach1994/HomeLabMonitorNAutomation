// Sonarr / Radarr (API v3) and Lidarr (API v1): queue, history and health, X-Api-Key header.
//
// The *arr apps return one queue/history record per *episode* (Sonarr) or *track* (Lidarr), so a
// season pack shows up as N records sharing a downloadId. We collapse those into one fact per
// download so the pipeline sees one release with a season-level mediaKey (tv:tvdb:<id>:s01).

import type { CollectorConfig } from '../../config.ts';
import type { ArrEventFact, ArrFact, ArrHealthFact, ArrQueueFact, MediaKind } from '../../facts.ts';
import { str, type Collector, type CollectorContext } from '../types.ts';
import {
  configError, getJson, intervalMs, list, lowerFirst, numOrNull, obj, optionalString, parseDate, records,
  requireString, requireUrl, uniq, type Json,
} from './common.ts';
import { episodeFromTitle, movieKey, musicKey, seasonPackFromTitle, tvKey } from './keys.ts';

export type ArrApp = 'sonarr' | 'radarr' | 'lidarr';

interface ArrSpec {
  apiVersion: 'v3' | 'v1';
  label: string;
  kind: MediaKind;
  /** Query params that embed the media objects we build mediaKeys from. */
  include: string;
  /** Queue param that also lists downloads the app couldn't match (often the import-blocked ones). */
  includeUnknown: string;
}

export const ARR_APPS: Record<ArrApp, ArrSpec> = {
  sonarr: {
    apiVersion: 'v3', label: 'Sonarr', kind: 'tv',
    include: 'includeSeries=true&includeEpisode=true', includeUnknown: 'includeUnknownSeriesItems=true',
  },
  radarr: {
    apiVersion: 'v3', label: 'Radarr', kind: 'movie',
    include: 'includeMovie=true', includeUnknown: 'includeUnknownMovieItems=true',
  },
  lidarr: {
    apiVersion: 'v1', label: 'Lidarr', kind: 'music',
    include: 'includeArtist=true&includeAlbum=true', includeUnknown: 'includeUnknownArtistItems=true',
  },
};

export function isArrApp(kind: string): kind is ArrApp {
  return kind in ARR_APPS;
}

/** History eventType → pipeline event. Everything else (renames, deletes, ignores…) is dropped. */
export function arrEventType(raw: unknown): ArrEventFact['eventType'] | undefined {
  switch (lowerFirst(raw)) {
    case 'grabbed':
      return 'grabbed';
    case 'downloadFolderImported':
    case 'downloadImported':
    case 'trackFileImported':
      return 'imported';
    case 'downloadFailed':
      return 'failed';
    default:
      return undefined;
  }
}

function truthy(v: unknown): boolean {
  return v === true || /^true$/i.test(str(v));
}

/** Season/episode numbers carried by a record (`episode`, or an `episodes` array on some builds). */
function episodesOf(r: Json): { season: number; episode: number }[] {
  const eps = [obj(r.episode), ...list(r.episodes).map(obj)];
  return eps
    .map((e) => ({ season: numOrNull(e.seasonNumber), episode: numOrNull(e.episodeNumber) }))
    .filter((e): e is { season: number; episode: number } => e.season != null && e.episode != null);
}

function seasonsOf(r: Json): number[] {
  const own = [numOrNull(r.seasonNumber), ...list(r.seasonNumbers).map(numOrNull)];
  return [...episodesOf(r).map((e) => e.season), ...own.filter((n): n is number => n != null)];
}

/**
 * Sonarr mediaKey for all records of one download:
 * one episode → s01e02 · season pack → s01 · several seasons → show level.
 */
export function sonarrMediaKey(recs: Json[], title: string): string | undefined {
  const tvdb = recs.map((r) => numOrNull(obj(r.series).tvdbId)).find((n) => n != null && n > 0);
  if (tvdb == null) return undefined;
  const eps = uniq(recs.flatMap(episodesOf).map((e) => `${e.season}:${e.episode}`))
    .map((k) => k.split(':').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const seasons = uniq(recs.flatMap(seasonsOf));
  if (seasons.length > 1) return tvKey(tvdb);
  const titleEp = episodeFromTitle(title);
  const pack =
    recs.some((r) => truthy(obj(r.data).fullSeason) || str(obj(r.data).releaseType) === 'SeasonPack') ||
    seasonPackFromTitle(title) != null ||
    (eps.length > 1 && !titleEp);
  const season = seasons[0] ?? seasonPackFromTitle(title) ?? titleEp?.season;
  if (pack) return tvKey(tvdb, season);
  if (eps.length) return tvKey(tvdb, eps[0][0], eps[0][1]);
  if (titleEp) return tvKey(tvdb, titleEp.season, titleEp.episode);
  return tvKey(tvdb, season);
}

export function arrMediaKey(app: ArrApp, recs: Json[], title: string): string | undefined {
  switch (app) {
    case 'sonarr':
      return sonarrMediaKey(recs, title);
    case 'radarr':
      for (const r of recs) {
        const key = movieKey(obj(r.movie).tmdbId);
        if (key) return key;
      }
      return undefined;
    case 'lidarr':
      for (const r of recs) {
        const key = musicKey(obj(r.artist).foreignArtistId, obj(r.album).foreignAlbumId);
        if (key) return key;
      }
      return undefined;
  }
}

function groupBy(rows: Json[], keyOf: (r: Json) => string | undefined): Json[][] {
  const groups = new Map<string, Json[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()];
}

export function parseArrQueue(app: ArrApp, json: unknown): ArrQueueFact[] {
  const spec = ARR_APPS[app];
  // Records without a downloadId (delay-profile pending releases) stay individual.
  const groups = groupBy(records(json), (r) => str(r.downloadId).toUpperCase() || `#${str(r.id)}`);
  return groups.map((recs) => {
    const r = recs[0];
    const title = str(r.title);
    const messages = uniq(
      recs.flatMap((x) => [
        ...list(x.statusMessages).flatMap((m) => list(obj(m).messages).map((s) => str(s).trim())),
        str(x.errorMessage).trim(),
      ]),
    ).filter(Boolean);
    return {
      downloadId: str(r.downloadId),
      title,
      mediaKey: arrMediaKey(app, recs, title),
      kind: spec.kind,
      status: lowerFirst(r.status) ?? 'unknown',
      trackedState: lowerFirst(r.trackedDownloadState),
      trackedStatus: lowerFirst(r.trackedDownloadStatus),
      messages,
    };
  });
}

export function parseArrHistory(app: ArrApp, json: unknown): ArrEventFact[] {
  const spec = ARR_APPS[app];
  const rows = records(json).filter((r) => str(r.downloadId) && arrEventType(r.eventType));
  const groups = groupBy(rows, (r) => `${str(r.downloadId).toUpperCase()}|${arrEventType(r.eventType)}`);
  const out: ArrEventFact[] = [];
  for (const recs of groups) {
    const r = recs[0];
    const eventType = arrEventType(r.eventType)!;
    const dates = recs.map((x) => parseDate(x.date)).filter((d): d is number => d != null);
    if (!dates.length) continue;
    const title = str(r.sourceTitle);
    const message = eventType === 'failed' ? str(obj(r.data).message) || undefined : undefined;
    out.push({
      downloadId: str(r.downloadId),
      eventType,
      title,
      mediaKey: arrMediaKey(app, recs, title),
      kind: spec.kind,
      date: Math.max(...dates),
      message,
    });
  }
  return out.sort((a, b) => b.date - a.date);
}

const HEALTH_TYPES = new Set<ArrHealthFact['type']>(['ok', 'notice', 'warning', 'error']);

export function parseArrHealth(json: unknown): ArrHealthFact[] {
  return records(json)
    .map((h) => {
      const t = str(h.type).toLowerCase() as ArrHealthFact['type'];
      return {
        type: HEALTH_TYPES.has(t) ? t : 'notice',
        message: str(h.message),
        source: str(h.source) || undefined,
      };
    })
    .filter((h) => h.message);
}

export function createArr(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  if (!isArrApp(cfg.kind)) throw configError(cfg, `unsupported *arr kind (expected sonarr, radarr or lidarr)`);
  const app = cfg.kind;
  const spec = ARR_APPS[app];
  const url = requireUrl(cfg);
  const apiKey = requireString(cfg, 'apiKey', `${spec.label} → Settings → General → API Key`);
  const label = optionalString(cfg, 'label') ?? spec.label;
  const api = `${url}/api/${spec.apiVersion}`;
  const opts = { headers: { 'X-Api-Key': apiKey }, secrets: [apiKey] };

  return {
    id: cfg.id,
    kind: app,
    intervalMs: intervalMs(cfg, 15),
    domains: ['arr'],
    async poll(now) {
      const [queue, history, health] = await Promise.all([
        getJson(`${api}/queue?page=1&pageSize=100&${spec.include}&${spec.includeUnknown}`, opts),
        getJson(`${api}/history?page=1&pageSize=100&sortKey=date&sortDirection=descending&${spec.include}`, opts),
        getJson(`${api}/health`, opts),
      ]);
      const fact: ArrFact = {
        app,
        label,
        queue: parseArrQueue(app, queue),
        history: parseArrHistory(app, history),
        health: parseArrHealth(health),
        at: now,
      };
      ctx.facts.arr.set(cfg.id, fact);
    },
  };
}
