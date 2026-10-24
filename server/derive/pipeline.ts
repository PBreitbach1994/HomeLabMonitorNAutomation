// Correlates *arr history/queue, download clients, Seerr requests and Plex into one row per
// release. The join key is the download client's id, which the *arr apps store as `downloadId`.

import type { ArrEventFact, ArrQueueFact, DownloadItemFact, FactStore, MediaKind } from '../facts.ts';
import type { Evidence, PipelineItem, StageKey } from '../../shared/model.ts';
import { STAGES } from '../../shared/model.ts';

export const PIPELINE_WINDOW_MS = 24 * 3600_000;
/** Finished releases (in Plex, or failed and replaced) drop off after this. */
export const FINISHED_TTL_MS = 3 * 3600_000;

interface Release {
  id: string;
  title: string;
  mediaKey?: string;
  kind: MediaKind;
  client?: string;
  dl?: DownloadItemFact;
  grabbed?: ArrEventFact;
  imported?: ArrEventFact;
  failed?: ArrEventFact;
  queue?: ArrQueueFact;
  updatedAt: number;
}

const BLOCKED_STATES = new Set(['importBlocked', 'importPending', 'failedPending']);

export function correlate(facts: FactStore, now: number): { items: PipelineItem[]; tracked: number } {
  const rels = new Map<string, Release>();
  const get = (id: string, seed: Partial<Release>): Release => {
    const key = id.toUpperCase();
    let r = rels.get(key);
    if (!r) {
      r = { id, title: seed.title ?? id, kind: seed.kind ?? 'other', updatedAt: 0 };
      rels.set(key, r);
    }
    if (!r.mediaKey && seed.mediaKey) r.mediaKey = seed.mediaKey;
    if (r.kind === 'other' && seed.kind) r.kind = seed.kind;
    return r;
  };

  for (const arr of facts.arr.values()) {
    for (const e of arr.history) {
      if (!e.downloadId || now - e.date > PIPELINE_WINDOW_MS) continue;
      const r = get(e.downloadId, e);
      if (e.eventType === 'grabbed') {
        r.grabbed = e;
        r.title = e.title;
      } else if (e.eventType === 'imported') r.imported = e;
      else if (e.eventType === 'failed') r.failed = e;
      r.updatedAt = Math.max(r.updatedAt, e.date);
    }
    for (const q of arr.queue) {
      if (!q.downloadId) continue;
      const r = get(q.downloadId, q);
      r.queue = q;
      if (r.title === r.id) r.title = q.title;
    }
  }

  for (const [clientId, d] of facts.downloads) {
    for (const item of [...d.history, ...d.queue]) {
      const known = rels.has(item.id.toUpperCase());
      // Client-only items (not grabbed by an *arr) are tracked only while recent.
      if (!known && now - item.updatedAt > PIPELINE_WINDOW_MS) continue;
      const r = get(item.id, { title: item.name });
      r.dl = item;
      r.client = d.client ?? clientId;
      if (r.title === r.id) r.title = item.name;
      r.updatedAt = Math.max(r.updatedAt, item.updatedAt);
    }
  }

  // Requests are usually show- or movie-level, so a request key matches any episode under it.
  const requestKeys = facts.requests.filter((q) => q.status !== 'declined').map((q) => q.mediaKey);
  const isRequested = (key?: string) => !!key && requestKeys.some((k) => key === k || key.startsWith(`${k}:`));
  const available = new Map<string, number>();
  for (const a of facts.plex?.recentlyAdded ?? []) {
    available.set(a.mediaKey, Math.max(available.get(a.mediaKey) ?? 0, a.addedAt));
  }

  const items: PipelineItem[] = [];
  for (const r of rels.values()) {
    if (!r.updatedAt) r.updatedAt = now;
    const stages: Record<StageKey, Evidence> = {
      requested: isRequested(r.mediaKey) ? 'verified' : 'none',
      grabbed: r.grabbed || r.queue ? 'verified' : 'none',
      downloading: 'none',
      downloaded: 'none',
      imported: r.imported ? 'verified' : 'none',
      available: 'none',
    };
    let status = 'Grabbed';
    let progress: number | null = null;
    const dl = r.dl;
    if (dl) {
      switch (dl.status) {
        case 'downloading':
          stages.downloading = 'active';
          status = 'Downloading';
          progress = dl.progress;
          break;
        case 'queued':
        case 'paused':
          status = dl.status === 'paused' ? 'Paused' : 'Queued';
          progress = dl.progress;
          break;
        case 'verifying':
        case 'extracting':
          stages.downloading = 'verified';
          stages.downloaded = 'active';
          status = 'Unpacking';
          break;
        case 'completed':
          stages.downloading = 'verified';
          stages.downloaded = 'verified';
          status = 'Waiting for import';
          break;
        case 'failed':
          stages.downloading = 'verified';
          stages.downloaded = 'failed';
          status = 'Downloading failed';
          break;
      }
    }
    if (r.failed) {
      stages.downloaded = 'failed';
      status = 'Downloading failed';
    }
    if (r.queue && BLOCKED_STATES.has(r.queue.trackedState ?? '') && r.queue.trackedStatus !== 'ok' && !r.imported) {
      if (stages.downloaded === 'none') stages.downloaded = 'verified';
      stages.imported = 'blocked';
      status = 'Import blocked';
    }
    if (r.imported) {
      status = 'Imported';
      const addedAt = r.mediaKey ? available.get(r.mediaKey) : undefined;
      if (addedAt != null && addedAt >= r.imported.date - 5 * 60_000) {
        stages.available = 'verified';
        status = 'In Plex';
        r.updatedAt = Math.max(r.updatedAt, addedAt);
      }
    }

    // Anything before the furthest stage with evidence must have happened: mark it inferred.
    let seen = false;
    for (let i = STAGES.length - 1; i >= 0; i--) {
      const s = STAGES[i];
      if (stages[s] !== 'none') seen = true;
      else if (seen) stages[s] = 'inferred';
    }
    const current =
      [...STAGES].reverse().find((s) => stages[s] !== 'none' && stages[s] !== 'inferred') ?? 'grabbed';

    items.push({
      id: r.id,
      title: r.title,
      mediaKey: r.mediaKey,
      kind: r.kind,
      client: r.client ?? '',
      status,
      progress,
      updatedAt: r.updatedAt,
      current,
      stages,
    });
  }

  // A failure is old news once a later release of the same media made it to the library.
  const superseded = new Set<string>();
  for (const i of items) {
    if (i.stages.downloaded !== 'failed' || !i.mediaKey) continue;
    if (items.some((o) => o !== i && o.mediaKey === i.mediaKey && o.stages.imported === 'verified' && o.updatedAt >= i.updatedAt)) {
      superseded.add(i.id);
      i.status = 'Failed · replaced';
    }
  }
  const finished = (i: PipelineItem) => i.stages.available === 'verified' || superseded.has(i.id);
  const live = items.filter((i) => !finished(i) || now - i.updatedAt < FINISHED_TTL_MS);

  const rank = (i: PipelineItem) => {
    const s = i.stages[i.current];
    if (s === 'active') return 0;
    if ((s === 'failed' && !superseded.has(i.id)) || s === 'blocked') return 1;
    return 2;
  };
  live.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  return { items: live.slice(0, 25), tracked: live.length };
}
