// slskd (Soulseek): GET /api/v0/transfers/downloads and /uploads (X-API-Key header).
// Both return users → directories → files; we sum averageSpeed (bytes/s) of in-progress files
// for the soulseek protocol rate, and list download files as queue/history items.

import type { CollectorConfig } from '../../config.ts';
import type { DownloadClientFact, DownloadItemFact, DownloadStatus } from '../../facts.ts';
import { num, str, type Collector, type CollectorContext } from '../types.ts';
import {
  clamp01, getJson, intervalMs, list, numOrNull, obj, optionalString, parseDate, requireString, requireUrl,
} from './common.ts';

/** slskd TransferStates are flags serialized like "InProgress" or "Completed, Errored". */
export function slskdStatus(state: unknown): DownloadStatus {
  const s = str(state).toLowerCase();
  if (s.includes('inprogress')) return 'downloading';
  if (s.includes('completed')) return s.includes('succeeded') ? 'completed' : 'failed';
  return 'queued'; // Requested, Queued (Locally/Remotely), Initializing
}

export interface SlskdTransfer extends DownloadItemFact {
  username: string;
  final: boolean;
}

export function parseSlskdTransfers(json: unknown, now: number): { bps: number; files: SlskdTransfer[] } {
  let bps = 0;
  const files: SlskdTransfer[] = [];
  for (const u of list(json)) {
    const user = obj(u);
    for (const d of list(user.directories)) {
      for (const f of list(obj(d).files)) {
        const file = obj(f);
        const status = slskdStatus(file.state);
        const speed = Math.max(0, num(file.averageSpeed));
        if (status === 'downloading') bps += speed * 8;
        const filename = str(file.filename);
        const final = status === 'completed' || status === 'failed';
        const pct = numOrNull(file.percentComplete);
        const size = numOrNull(file.size);
        files.push({
          id: str(file.id) || `${str(user.username)}:${filename}`,
          name: filename.split(/[\\/]/).filter(Boolean).pop() ?? filename,
          status,
          progress: clamp01(pct != null ? pct / 100 : status === 'completed' ? 1 : null),
          sizeBytes: size != null && size > 0 ? size : undefined,
          speedBps: status === 'downloading' ? speed * 8 : undefined,
          updatedAt:
            status === 'downloading' ? now
            : (final ? parseDate(file.endedAt) : null) ?? parseDate(file.enqueuedAt) ?? parseDate(file.requestedAt) ?? now,
          message: status === 'failed' ? str(file.exception) || str(file.state) : undefined,
          username: str(user.username) || str(file.username),
          final,
        });
      }
    }
  }
  return { bps, files };
}

const strip = ({ username: _u, final: _f, ...item }: SlskdTransfer): DownloadItemFact => item;

export function createSlskd(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const url = requireUrl(cfg);
  const apiKey = requireString(cfg, 'apiKey', 'slskd.yml → web.authentication.api_keys');
  const host = optionalString(cfg, 'host');
  const opts = { headers: { 'X-API-Key': apiKey }, secrets: [apiKey] };

  return {
    id: cfg.id,
    kind: 'slskd',
    intervalMs: intervalMs(cfg, 5),
    domains: ['downloads'],
    async poll(now) {
      const [downloads, uploads] = await Promise.all([
        getJson(`${url}/api/v0/transfers/downloads`, opts),
        getJson(`${url}/api/v0/transfers/uploads`, opts),
      ]);
      const down = parseSlskdTransfers(downloads, now);
      const up = parseSlskdTransfers(uploads, now);
      const rank = (s: DownloadStatus) => (s === 'downloading' ? 0 : 1);
      const queue = down.files
        .filter((f) => !f.final)
        .sort((a, b) => rank(a.status) - rank(b.status) || a.updatedAt - b.updatedAt)
        .slice(0, 50)
        .map(strip);
      const history = down.files
        .filter((f) => f.final)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 30)
        .map(strip);
      const fact: DownloadClientFact = {
        client: 'slskd',
        protocol: 'soulseek',
        host,
        downBps: down.bps,
        upBps: up.bps,
        queue,
        history,
        at: now,
      };
      ctx.facts.downloads.set(cfg.id, fact);
    },
  };
}
