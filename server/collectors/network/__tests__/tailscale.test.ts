import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTailscale, parseTailscaleStatus } from '../tailscale.ts';
import { FIXTURES, cfg, fixture, fixtureJson, json, serve, tempDir, testContext } from './helpers.ts';

describe('parseTailscaleStatus', () => {
  it('reads BackendState and counts online peers', () => {
    expect(parseTailscaleStatus(fixtureJson('tailscale-status.json'))).toEqual({ up: true, peersOnline: 3 });
  });

  it('handles a stopped / logged-out node and rejects garbage', () => {
    expect(parseTailscaleStatus({ BackendState: 'Stopped', Peer: null })).toEqual({ up: false, peersOnline: 0 });
    expect(parseTailscaleStatus({ BackendState: 'NeedsLogin' })).toEqual({ up: false, peersOnline: 0 });
    expect(() => parseTailscaleStatus({})).toThrow(/BackendState/);
  });
});

describe('tailscale collector', () => {
  const tmp = tempDir();
  afterAll(() => tmp.cleanup());

  it('runs `tailscale status --json`', async () => {
    const bin = join(tmp.dir, 'tailscale');
    writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "status --json" ] || exit 9\ncat "${join(FIXTURES, 'tailscale-status.json')}"\n`);
    chmodSync(bin, 0o755);
    const ctx = testContext();
    const c = createTailscale(cfg('tailscale', { bin }), ctx);
    expect(c).toMatchObject({ kind: 'tailscale', domains: ['tailscale'], intervalMs: 30_000 });
    await c.poll(3);
    expect(ctx.facts.tailscale).toEqual({ up: true, peersOnline: 3, at: 3 });
  });

  it('fails (rather than reporting "down") when tailscaled is unreachable', async () => {
    const bin = join(tmp.dir, 'tailscale-broken');
    writeFileSync(bin, '#!/bin/sh\necho "failed to connect to local tailscaled; it doesn\'t appear to be running" >&2\nexit 1\n');
    chmodSync(bin, 0o755);
    const ctx = testContext();
    await expect(createTailscale(cfg('tailscale', { bin }), ctx).poll(1)).rejects.toThrow(/failed to connect to local tailscaled/);
    expect(ctx.facts.tailscale).toBeNull();
  });

  it('can query the LocalAPI over the tailscaled socket instead', async () => {
    const socket = join(tmp.dir, 'tailscaled.sock');
    const srv = await serve((req, res) =>
      req.url === '/localapi/v0/status' && req.headers.host === 'local-tailscaled.sock'
        ? json(res, 200, fixture('tailscale-status.json'))
        : json(res, 403, 'invalid host'),
    socket);
    try {
      const ctx = testContext();
      await createTailscale(cfg('tailscale', { socket }), ctx).poll(4);
      expect(ctx.facts.tailscale).toEqual({ up: true, peersOnline: 3, at: 4 });
    } finally {
      await srv.close();
    }
  });
});
