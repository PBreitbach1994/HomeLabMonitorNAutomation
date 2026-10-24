// SABnzbd: GET /api?mode=queue and mode=history (output=json, apikey in the query string).
// Item ids are SABnzbd nzo_ids, which is what Sonarr/Radarr/Lidarr record as `downloadId`.

import type { CollectorConfig } from '../../config.ts';
import type { DownloadClientFact, DownloadItemFact, DownloadStatus } from '../../facts.ts';
import { num, str, type Collector, type CollectorContext } from '../types.ts';
import {
  clamp01, fromUnix, getJson, intervalMs, list, numOrNull, obj, optionalString, requireString, requireUrl,
} from './common.ts';

const MIB = 1024 * 1024;

// SABnzbd's Status constants (sabnzbd/constants.py). Queue slots and history slots reuse some
// names with different meanings, e.g. "Queued" in history = waiting for post-processing.
const QUEUE_STATUS: Record<string, DownloadStatus> = {
  downloading: 'downloading',
  fetching: 'downloading', // fetching extra par2 blocks
  grabbing: 'queued', // fetching the NZB itself
  queued: 'queued',
  propagating: 'queued', // delayed until the post has propagated
  checking: 'queued', // pre-check
  paused: 'paused',
};

const HISTORY_STATUS: Record<string, DownloadStatus> = {
  completed: 'completed',
  failed: 'failed',
  queued: 'verifying',
  quickcheck: 'verifying',
  verifying: 'verifying',
  repairing: 'verifying',
  fetching: 'verifying',
  checking: 'verifying',
  extracting: 'extracting',
  moving: 'extracting',
  running: 'extracting', // user post-processing script
};

export function sabStatus(raw: unknown, where: 'queue' | 'history'): DownloadStatus {
  const key = str(raw).toLowerCase().replace(/[^a-z]/g, '');
  if (where === 'queue') return QUEUE_STATUS[key] ?? 'queued';
  return HISTORY_STATUS[key] ?? 'verifying';
}

/** SABnzbd answers bad API keys etc. with HTTP 200 and `{ status: false, error }`. */
function assertSabOk(json: unknown): void {
  const o = obj(json);
  if (o.status === false || typeof o.error === 'string') {
    throw new Error(`SABnzbd: ${str(o.error, 'request rejected')}`);
  }
}

export interface SabQueue {
  downBps: number;
  paused: boolean;
  queue: DownloadItemFact[];
}

export function parseSabQueue(json: unknown, now: number): SabQueue {
  assertSabOk(json);
  const q = obj(obj(json).queue);
  const downBps = Math.max(0, num(q.kbpersec)) * 1024 * 8; // kbpersec is KiB/s
  const paused = q.paused === true || str(q.status).toLowerCase() === 'paused';
  let speedAssigned = false;
  const queue: DownloadItemFact[] = [];
  for (const raw of list(q.slots)) {
    const s = obj(raw);
    if (str(s.status).toLowerCase() === 'deleted') continue;
    const status = sabStatus(s.status, 'queue');
    const mb = numOrNull(s.mb);
    const mbleft = numOrNull(s.mbleft);
    const pct = numOrNull(s.percentage);
    const progress = pct != null ? pct / 100 : mb && mbleft != null ? (mb - mbleft) / mb : null;
    // SABnzbd downloads one job at a time; the first active slot gets the client's speed.
    const speedBps = status === 'downloading' && !speedAssigned ? downBps : undefined;
    if (speedBps != null) speedAssigned = true;
    queue.push({
      id: str(s.nzo_id),
      name: str(s.filename, str(s.nzo_id)),
      status,
      progress: clamp01(progress),
      sizeBytes: mb != null ? Math.round(mb * MIB) : undefined,
      speedBps,
      category: str(s.cat) || undefined,
      updatedAt: now,
    });
  }
  return { downBps, paused, queue: queue.filter((i) => i.id) };
}

export function parseSabHistory(json: unknown, now: number): DownloadItemFact[] {
  assertSabOk(json);
  const out: DownloadItemFact[] = [];
  for (const raw of list(obj(obj(json).history).slots)) {
    const s = obj(raw);
    const id = str(s.nzo_id);
    if (!id) continue;
    const status = sabStatus(s.status, 'history');
    const bytes = numOrNull(s.bytes);
    const message =
      status === 'failed' ? str(s.fail_message) || 'Failed'
      : status !== 'completed' ? str(s.action_line) || undefined
      : undefined;
    out.push({
      id,
      name: str(s.name, id),
      status,
      progress: status === 'failed' ? null : 1,
      sizeBytes: bytes != null && bytes > 0 ? bytes : undefined,
      category: str(s.category) || undefined,
      updatedAt: fromUnix(s.completed) ?? now, // 0 while still post-processing
      message,
    });
  }
  return out;
}

export function createSabnzbd(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = requireUrl(cfg);
  const apiKey = requireString(cfg, 'apiKey', 'SABnzbd → Config → General → API Key');
  const host = optionalString(cfg, 'host');
  const historyLimit = Math.max(1, Math.round(num(cfg.historyLimit, 50)));
  const secrets = [apiKey];
  const api = (mode: string, extra = '') =>
    `${url}/api?mode=${mode}&output=json${extra}&apikey=${encodeURIComponent(apiKey)}`;

  return {
    id: cfg.id,
    kind: 'sabnzbd',
    intervalMs: intervalMs(cfg, 5),
    domains: ['downloads'],
    async poll(now) {
      const [q, h] = await Promise.all([
        getJson(api('queue'), { secrets }),
        getJson(api('history', `&limit=${historyLimit}`), { secrets }),
      ]);
      const queue = parseSabQueue(q, now);
      const fact: DownloadClientFact = {
        client: 'sabnzbd',
        protocol: 'usenet',
        host,
        downBps: queue.downBps,
        upBps: 0,
        paused: queue.paused,
        queue: queue.queue,
        history: parseSabHistory(h, now),
        at: now,
      };
      ctx.facts.downloads.set(cfg.id, fact);
    },
  };
}
