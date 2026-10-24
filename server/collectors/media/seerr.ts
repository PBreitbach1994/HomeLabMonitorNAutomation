// Overseerr / Jellyseerr / Seerr: GET /api/v1/request (X-Api-Key). Requests are show- or
// movie-level (tv:tvdb:<id>, movie:tmdb:<id>); the pipeline prefix-matches episodes under them.
//
// Request objects carry no title, so titles come from /api/v1/movie/{tmdbId} and
// /api/v1/tv/{tmdbId}, a few per poll, cached for the collector's lifetime.

import type { CollectorConfig } from '../../config.ts';
import type { RequestFact } from '../../facts.ts';
import { num, str, type Collector, type CollectorContext } from '../types.ts';
import {
  getJson, intervalMs, list, mapLimit, numOrNull, obj, parseDate, requireString, requireUrl, uniq,
} from './common.ts';
import { movieKey, tvKey } from './keys.ts';

// server/constants/media.ts — MediaRequestStatus and MediaStatus.
const REQUEST_STATUS: Record<number, string> = { 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed' };
const MEDIA_STATUS: Record<number, string> = {
  1: 'unknown', 2: 'pending', 3: 'processing', 4: 'partially available', 5: 'available', 6: 'blacklisted', 7: 'deleted',
};

/** One status string: declined/pending/failed win; otherwise what the media itself has reached. */
export function seerrStatus(requestStatus: unknown, mediaStatus: unknown): string {
  const req = REQUEST_STATUS[num(requestStatus, 0)] ?? 'unknown';
  if (req === 'declined' || req === 'pending' || req === 'failed') return req;
  const media = MEDIA_STATUS[num(mediaStatus, 0)];
  if (media === 'processing' || media === 'partially available' || media === 'available' || media === 'deleted') return media;
  return req;
}

export type MediaRef = { type: 'tv' | 'movie'; tmdbId: number };
const refKey = (r: MediaRef) => `${r.type}:${r.tmdbId}`;

function mediaType(raw: unknown, fallback: unknown): 'tv' | 'movie' | undefined {
  const t = str(raw) || str(fallback);
  return t === 'tv' || t === 'movie' ? t : undefined;
}

/** The (type, tmdbId) pairs a requests page references, for title lookups. */
export function seerrMediaRefs(json: unknown): MediaRef[] {
  const out = new Map<string, MediaRef>();
  for (const raw of list(obj(json).results)) {
    const r = obj(raw);
    const media = obj(r.media);
    const type = mediaType(media.mediaType, r.type);
    const tmdbId = numOrNull(media.tmdbId);
    if (type && tmdbId != null && tmdbId > 0) out.set(`${type}:${tmdbId}`, { type, tmdbId });
  }
  return [...out.values()];
}

export function parseSeerrRequests(json: unknown, titleOf: (ref: MediaRef) => string | undefined = () => undefined): RequestFact[] {
  const out: RequestFact[] = [];
  for (const raw of list(obj(json).results)) {
    const r = obj(raw);
    const media = obj(r.media);
    const type = mediaType(media.mediaType, r.type);
    // TV is keyed by tvdb (what Sonarr uses); shows TMDB can't map to tvdb can't be matched.
    const mediaKey = type === 'tv' ? tvKey(media.tvdbId) : type === 'movie' ? movieKey(media.tmdbId) : undefined;
    if (!mediaKey || !type) continue;
    const tmdbId = num(media.tmdbId, 0);
    out.push({
      mediaKey,
      title: titleOf({ type, tmdbId }) ?? `${type === 'tv' ? 'Series' : 'Movie'} (TMDB ${tmdbId || '?'})`,
      requestedAt: parseDate(r.createdAt) ?? 0,
      status: seerrStatus(r.status, media.status),
    });
  }
  return out;
}

const TITLE_LOOKUPS_PER_POLL = 5;
const TITLE_RETRY_MS = 30 * 60_000;

export function createSeerr(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = requireUrl(cfg);
  const apiKey = requireString(cfg, 'apiKey', 'Seerr → Settings → General → API Key');
  const take = Math.min(100, Math.max(1, Math.round(num(cfg.take, 50))));
  const opts = { headers: { 'X-Api-Key': apiKey }, secrets: [apiKey] };
  const titles = new Map<string, string>();
  const failedAt = new Map<string, number>();

  async function lookupTitles(refs: MediaRef[], now: number): Promise<void> {
    const todo = uniq(refs.map(refKey))
      .filter((k) => !titles.has(k) && now - (failedAt.get(k) ?? -Infinity) > TITLE_RETRY_MS)
      .slice(0, TITLE_LOOKUPS_PER_POLL);
    await mapLimit(todo, 3, async (k) => {
      const [type, id] = k.split(':');
      try {
        const m = obj(await getJson(`${url}/api/v1/${type}/${id}`, opts));
        const title = str(type === 'tv' ? m.name : m.title) || str(m.originalTitle) || str(m.originalName);
        if (!title) throw new Error('no title');
        const year = (str(type === 'tv' ? m.firstAirDate : m.releaseDate).match(/^\d{4}/) ?? [])[0];
        titles.set(k, year ? `${title} (${year})` : title);
      } catch {
        failedAt.set(k, now);
      }
    });
  }

  return {
    id: cfg.id,
    kind: cfg.kind,
    intervalMs: intervalMs(cfg, 60),
    domains: ['requests'],
    async poll(now) {
      const json = await getJson(`${url}/api/v1/request?take=${take}&skip=0&sort=added&filter=all`, opts);
      await lookupTitles(seerrMediaRefs(json), now);
      ctx.facts.requests = parseSeerrRequests(json, (r) => titles.get(refKey(r)));
    },
  };
}
