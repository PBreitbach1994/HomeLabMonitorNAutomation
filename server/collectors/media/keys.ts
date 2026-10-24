// Media keys are the cross-app identity the pipeline joins on. *arr, Plex and Seerr collectors
// must all build them here so the formats can't drift:
//   tv:tvdb:<seriesTvdbId>[:s01[e02]]   movie:tmdb:<tmdbId>   music:mb:<artistMbid>[:<albumMbid>]

import { str } from '../types.ts';

const pad = (n: number) => String(n).padStart(2, '0');

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function index(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function tvKey(tvdbId: unknown, season?: unknown, episode?: unknown): string | undefined {
  const id = positiveInt(tvdbId);
  if (id == null) return undefined;
  const s = index(season);
  if (s == null) return `tv:tvdb:${id}`;
  const e = index(episode);
  return e == null ? `tv:tvdb:${id}:s${pad(s)}` : `tv:tvdb:${id}:s${pad(s)}e${pad(e)}`;
}

export function movieKey(tmdbId: unknown): string | undefined {
  const id = positiveInt(tmdbId);
  return id == null ? undefined : `movie:tmdb:${id}`;
}

export function musicKey(artistMbid: unknown, albumMbid?: unknown): string | undefined {
  const artist = str(artistMbid).trim().toLowerCase();
  if (!artist) return undefined;
  const album = str(albumMbid).trim().toLowerCase();
  return album ? `music:mb:${artist}:${album}` : `music:mb:${artist}`;
}

const EPISODE_RE = /\bS(\d{1,3})[ ._-]?E(\d{1,4})/i;
const SEASON_RE = /\b(?:S(\d{1,3})|Season[ ._-]?(\d{1,3}))\b/i;

/** Season + first episode from a release name like `Show.S01E02.1080p`. */
export function episodeFromTitle(title: string): { season: number; episode: number } | undefined {
  const m = EPISODE_RE.exec(title);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : undefined;
}

/** Season number when the release name looks like a season pack (`S01`, `Season 1`, no `E02`). */
export function seasonPackFromTitle(title: string): number | undefined {
  if (EPISODE_RE.test(title)) return undefined;
  const m = SEASON_RE.exec(title);
  return m ? Number(m[1] ?? m[2]) : undefined;
}
