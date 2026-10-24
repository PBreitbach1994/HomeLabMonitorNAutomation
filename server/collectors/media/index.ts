import type { CollectorFactory } from '../types.ts';
import { createArr } from './arr.ts';
import { createPlex } from './plex.ts';
import { createQbittorrent } from './qbittorrent.ts';
import { createSabnzbd } from './sabnzbd.ts';
import { createSeerr } from './seerr.ts';
import { createSlskd } from './slskd.ts';

/** Media-stack collectors: sabnzbd, qbittorrent, sonarr/radarr/lidarr, plex, seerr, slskd. */
export const MEDIA_FACTORIES: Record<string, CollectorFactory> = {
  sabnzbd: createSabnzbd,
  qbittorrent: createQbittorrent,
  sonarr: createArr,
  radarr: createArr,
  lidarr: createArr,
  plex: createPlex,
  seerr: createSeerr,
  overseerr: createSeerr,
  jellyseerr: createSeerr,
  slskd: createSlskd,
};
