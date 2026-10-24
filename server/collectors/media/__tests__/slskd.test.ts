import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlskd, parseSlskdTransfers, slskdStatus } from '../slskd.ts';
import { NOW, cfg, fixture, json, makeCtx, stubFetch } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

describe('parseSlskdTransfers', () => {
  it('sums averageSpeed of in-progress files (bytes/s → bits/s) and flattens files', () => {
    const { bps, files } = parseSlskdTransfers(fixture('slskd-downloads.json'), NOW);
    expect(bps).toBe((524288 + 262144) * 8);
    expect(files.map((f) => [f.name, f.status])).toEqual([
      ['01 - 15 Step.flac', 'completed'],
      ['02 - Bodysnatchers.flac', 'downloading'],
      ['03 - Nude.flac', 'queued'],
      ['04 - Weird Fishes.flac', 'failed'],
      ['01 Mysterons.flac', 'downloading'],
    ]);
    const [done, active, , failed] = files;
    expect(done.updatedAt).toBe(Date.parse('2025-10-24T15:41:10Z')); // zone-less timestamps are UTC
    expect(done.progress).toBe(1);
    expect(active).toMatchObject({ id: '6f1c1f4e-2f0b-4a5e-9a0e-2f7f3c3b1a02', progress: 0.415, speedBps: 524288 * 8, sizeBytes: 31457280, updatedAt: NOW });
    expect(failed.message).toBe('Remote connection closed');
  });

  it('upload side only contributes rate', () => {
    expect(parseSlskdTransfers(fixture('slskd-uploads.json'), NOW).bps).toBe(131072 * 8);
  });
});

describe('slskdStatus', () => {
  it.each([
    ['Requested', 'queued'],
    ['Queued, Locally', 'queued'],
    ['Queued, Remotely', 'queued'],
    ['Initializing', 'queued'],
    ['InProgress', 'downloading'],
    ['Completed, Succeeded', 'completed'],
    ['Completed, Cancelled', 'failed'],
    ['Completed, TimedOut', 'failed'],
    ['Completed, Rejected', 'failed'],
    ['Completed, Errored', 'failed'],
  ])('%s → %s', (state, expected) => expect(slskdStatus(state)).toBe(expected));
});

describe('createSlskd', () => {
  it('validates config', () => {
    expect(() => createSlskd(cfg({ kind: 'slskd', url: 'http://slskd:5030' }), makeCtx())).toThrow(/`apiKey` is required/);
  });

  it('writes a soulseek downloads fact', async () => {
    const calls = stubFetch(({ url }) =>
      url.pathname === '/api/v0/transfers/downloads' ? json(fixture('slskd-downloads.json'))
      : url.pathname === '/api/v0/transfers/uploads' ? json(fixture('slskd-uploads.json'))
      : undefined,
    );
    const ctx = makeCtx();
    await createSlskd(cfg({ kind: 'slskd', id: 'soulseek', url: 'http://slskd:5030', apiKey: 'slskd-key-1', host: 'switchyard' }), ctx).poll(NOW);
    expect(calls.every((x) => x.headers.get('x-api-key') === 'slskd-key-1')).toBe(true);
    const f = ctx.facts.downloads.get('soulseek')!;
    expect(f).toMatchObject({ client: 'slskd', protocol: 'soulseek', host: 'switchyard', downBps: (524288 + 262144) * 8, upBps: 131072 * 8, at: NOW });
    expect(f.queue.map((i) => i.status)).toEqual(['downloading', 'downloading', 'queued']);
    expect(f.history.map((i) => i.status)).toEqual(['completed', 'failed']);
    expect(f.queue[0]).not.toHaveProperty('username');
  });
});
