// qBittorrent WebUI API v2: cookie login, GET /api/v2/transfer/info and /api/v2/torrents/info.
// Ids are info-hashes upper-cased, which is how Sonarr/Radarr/Lidarr record `downloadId`.

import type { CollectorConfig } from '../../config.ts';
import type { DownloadClientFact, DownloadItemFact, DownloadStatus } from '../../facts.ts';
import { num, str, type Collector, type CollectorContext } from '../types.ts';
import {
  HttpError, clamp01, configError, fromUnix, httpRequest, intervalMs, list, numOrNull, obj, optionalString,
  readJson, requireUrl,
} from './common.ts';

// TorrentState names from the WebUI API (v5 renamed paused* → stopped*; both handled).
const STATE: Record<string, DownloadStatus> = {
  downloading: 'downloading',
  forceddl: 'downloading',
  metadl: 'downloading',
  forcedmetadl: 'downloading',
  stalleddl: 'downloading',
  allocating: 'downloading',
  queueddl: 'queued',
  pauseddl: 'paused',
  stoppeddl: 'paused',
  checkingdl: 'verifying',
  checkingup: 'verifying',
  moving: 'verifying',
  uploading: 'completed',
  forcedup: 'completed',
  stalledup: 'completed',
  queuedup: 'completed',
  pausedup: 'completed',
  stoppedup: 'completed',
  error: 'failed',
  missingfiles: 'failed',
};

const STATE_MESSAGE: Record<string, string> = {
  stalleddl: 'Stalled: no peers sending data',
  metadl: 'Fetching metadata',
  forcedmetadl: 'Fetching metadata',
  error: 'qBittorrent reports an error (I/O or tracker); see the torrent in qBittorrent',
  missingfiles: 'Files are missing',
  moving: 'Moving files',
  checkingresumedata: 'Checking resume data',
};

export function qbitStatus(state: unknown, progress: number | null): DownloadStatus {
  const key = str(state).toLowerCase();
  const done = progress != null && progress >= 1;
  return STATE[key] ?? (done ? 'completed' : 'queued'); // checkingResumeData, unknown
}

export function parseQbitTransfer(json: unknown): { downBps: number; upBps: number } {
  const t = obj(json);
  return { downBps: Math.max(0, num(t.dl_info_speed)) * 8, upBps: Math.max(0, num(t.up_info_speed)) * 8 };
}

export interface QbitTorrents {
  queue: DownloadItemFact[];
  history: DownloadItemFact[];
}

/** Incomplete torrents → queue; complete ones (progress 1) → history, newest completion first. */
export function parseQbitTorrents(json: unknown, now: number, opts: { historyLimit?: number; queueLimit?: number } = {}): QbitTorrents {
  const { historyLimit = 50, queueLimit = 200 } = opts;
  const queue: DownloadItemFact[] = [];
  const history: DownloadItemFact[] = [];
  for (const raw of list(json)) {
    const t = obj(raw);
    const hash = str(t.hash).toUpperCase();
    if (!hash) continue;
    const progress = clamp01(numOrNull(t.progress));
    const status = qbitStatus(t.state, progress);
    const state = str(t.state).toLowerCase();
    const size = numOrNull(t.size) ?? numOrNull(t.total_size);
    const lastSeen = Math.max(fromUnix(t.last_activity) ?? 0, fromUnix(t.added_on) ?? 0) || now;
    const done = progress != null && progress >= 1;
    // Only torrents actually moving data are "fresh"; stalled/paused ones keep their last activity
    // so long-dead client-only torrents age out of the pipeline.
    const transferring = num(t.dlspeed) > 0 || state === 'downloading' || state === 'forceddl';
    const item: DownloadItemFact = {
      id: hash,
      name: str(t.name, hash),
      status,
      progress,
      sizeBytes: size != null && size > 0 ? size : undefined,
      speedBps: done ? undefined : Math.max(0, num(t.dlspeed)) * 8,
      category: str(t.category) || undefined,
      updatedAt: done ? fromUnix(t.completion_on) ?? lastSeen : transferring ? now : lastSeen,
      message: STATE_MESSAGE[state],
    };
    (done ? history : queue).push(item);
  }
  history.sort((a, b) => b.updatedAt - a.updatedAt);
  return { queue: queue.slice(0, queueLimit), history: history.slice(0, historyLimit) };
}

/** `name=value` pairs from Set-Cookie (SID, or QBT_SID_<port> on newer builds). */
export function sessionCookie(headers: Headers): string {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
  return raw
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

export function createQbittorrent(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = requireUrl(cfg);
  const username = optionalString(cfg, 'username');
  const password = typeof cfg.password === 'string' ? cfg.password : '';
  if (username && !password) {
    throw configError(cfg, '`password` is required when `username` is set (omit both if the WebUI bypasses auth for this host)');
  }
  const historyLimit = Math.max(1, Math.round(num(cfg.historyLimit, 50)));
  const host = optionalString(cfg, 'host');
  const origin = new URL(url).origin;
  const secrets = [password];

  let cookie = '';
  let loggingIn: Promise<void> | null = null;

  async function login(): Promise<void> {
    const res = await httpRequest(`${url}/api/v2/auth/login`, {
      method: 'POST',
      // qBittorrent's CSRF check compares Origin/Referer with Host, so send matching ones.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: `${origin}/` },
      body: new URLSearchParams({ username: username ?? '', password }).toString(),
      secrets,
    });
    const text = (await res.text().catch(() => '')).trim();
    if (res.status === 403) {
      throw new HttpError(403, 'qBittorrent refused the login (403): this IP is banned after too many failed logins');
    }
    if (!res.ok || text !== 'Ok.') {
      throw new HttpError(res.status, `qBittorrent login failed (${res.status} ${text.slice(0, 40)}); check username/password`);
    }
    cookie = sessionCookie(res.headers);
  }

  const ensureLogin = () =>
    (loggingIn ??= login().finally(() => {
      loggingIn = null;
    }));

  async function get<T>(path: string): Promise<T> {
    if (username && !cookie) await ensureLogin();
    const call = (c: string) => httpRequest(`${url}${path}`, { headers: c ? { Cookie: c } : {}, secrets });
    const used = cookie;
    let res = await call(used);
    if (res.status === 403 && username) {
      // Session expired (or qBittorrent restarted): log in again once. If a parallel request
      // already started (or finished) a re-login, reuse it instead of logging in twice.
      await res.body?.cancel().catch(() => undefined);
      if (cookie === used) {
        cookie = '';
        await ensureLogin();
      } else if (loggingIn) {
        await loggingIn;
      }
      res = await call(cookie);
    }
    if (res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(403, `qBittorrent: 403 Forbidden on ${path}${username ? ' after re-login' : '; set username/password or whitelist this host'}`);
    }
    return readJson<T>(res, `${url}${path}`, secrets);
  }

  return {
    id: cfg.id,
    kind: 'qbittorrent',
    intervalMs: intervalMs(cfg, 5),
    domains: ['downloads'],
    async poll(now) {
      const [transfer, torrents] = await Promise.all([
        get<unknown>('/api/v2/transfer/info'),
        get<unknown>('/api/v2/torrents/info?sort=added_on&reverse=true'),
      ]);
      const rates = parseQbitTransfer(transfer);
      const { queue, history } = parseQbitTorrents(torrents, now, { historyLimit });
      const fact: DownloadClientFact = {
        client: 'qbittorrent',
        protocol: 'torrent',
        host,
        downBps: rates.downBps,
        upBps: rates.upBps,
        queue,
        history,
        at: now,
      };
      ctx.facts.downloads.set(cfg.id, fact);
    },
  };
}
