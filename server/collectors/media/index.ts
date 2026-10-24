import type { CollectorFactory } from '../types.ts';

/** Media-stack collectors: sabnzbd, qbittorrent, sonarr/radarr/lidarr, plex, seerr. */
export const MEDIA_FACTORIES: Record<string, CollectorFactory> = {};
