import type { Health, Medium, Protocol } from '../../../shared/model.ts';

// Protocol hues: validated as a categorical set on the panel surface (#101827) in this
// stack order — torrent · usenet · soulseek · plex — with "other" as a neutral fold-in.
export const PROTOCOL_COLOR: Record<Protocol, string> = {
  torrent: '#d95926',
  usenet: '#3987e5',
  soulseek: '#d55181',
  plex: '#c98500',
  other: '#7d8696',
};
export const PROTOCOL_STACK: Protocol[] = ['torrent', 'usenet', 'soulseek', 'plex', 'other'];

export const MEDIUM_COLOR: Record<Medium, string> = {
  '10G': '#2dd4bf',
  '2.5G': '#60a5fa',
  '1G': '#a78bfa',
  '100M': '#94a3b8',
  wifi: '#9fb3c8',
  vpn: '#10b981',
  logical: '#64748b',
};

export const MEDIUM_WIDTH: Record<Medium, number> = {
  '10G': 3.2,
  '2.5G': 2.2,
  '1G': 1.6,
  '100M': 1.2,
  wifi: 1.4,
  vpn: 1.4,
  logical: 1.2,
};

// Status palette — reserved for state, always paired with a label or icon.
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

export const HEALTH_COLOR: Record<Health, string> = {
  ok: STATUS.good,
  warn: STATUS.warning,
  crit: STATUS.critical,
  unknown: '#4b5567',
  off: '#4b5567',
};

export const HEALTH_LABEL: Record<Health, string> = {
  ok: 'Healthy',
  warn: 'Warning',
  crit: 'Down',
  unknown: 'No data',
  off: 'Off',
};
