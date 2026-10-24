import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPing, parsePing } from '../ping.ts';
import { FIXTURES, cfg, fixture, tempDir, testContext } from './helpers.ts';

describe('parsePing', () => {
  it('reads iputils loss and rtt min/avg/max/mdev', () => {
    expect(parsePing(fixture('ping-iputils.txt'))).toEqual({ transmitted: 3, received: 3, lossPct: 0, rttMs: 7.543, jitterMs: 0.374 });
  });

  it('handles fractional loss', () => {
    expect(parsePing(fixture('ping-iputils-partial.txt'))).toEqual({
      transmitted: 3, received: 1, lossPct: 66.6667, rttMs: 0.912, jitterMs: 0,
    });
  });

  it('reports 100% loss with null rtt/jitter (iputils with +errors, BusyBox)', () => {
    expect(parsePing(fixture('ping-iputils-down.txt'))).toEqual({ transmitted: 3, received: 0, lossPct: 100, rttMs: null, jitterMs: null });
    expect(parsePing(fixture('ping-busybox-down.txt'))).toEqual({ transmitted: 3, received: 0, lossPct: 100, rttMs: null, jitterMs: null });
  });

  it('computes jitter from the replies when BusyBox prints no mdev', () => {
    const r = parsePing(fixture('ping-busybox.txt'))!;
    expect(r).toMatchObject({ transmitted: 3, received: 3, lossPct: 0, rttMs: 7.617 });
    // population std-dev of 7.312, 7.651, 7.889 (what iputils calls mdev)
    expect(r.jitterMs).toBeCloseTo(0.2367, 3);
  });

  it('parses BSD/macOS "round-trip … stddev"', () => {
    const out = '3 packets transmitted, 3 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 7.1/7.5/8.0/0.37 ms\n';
    expect(parsePing(out)).toMatchObject({ lossPct: 0, rttMs: 7.5, jitterMs: 0.37 });
  });

  it('returns null without a statistics block', () => {
    expect(parsePing('')).toBeNull();
    expect(parsePing('ping: nosuch.invalid: Name or service not known\n')).toBeNull();
  });
});

describe('ping collector', () => {
  // A stand-in for /bin/ping that answers from the fixtures by target.
  const tmp = tempDir();
  afterAll(() => tmp.cleanup());
  const fake = join(tmp.dir, 'ping');
  writeFileSync(
    fake,
    `#!/bin/sh
for host; do :; done
case "$host" in
  1.1.1.1) cat "${join(FIXTURES, 'ping-iputils.txt')}" ;;
  192.168.4.1) cat "${join(FIXTURES, 'ping-busybox.txt')}" ;;
  10.9.9.9) cat "${join(FIXTURES, 'ping-iputils-down.txt')}"; exit 1 ;;
  nosuch.invalid) echo "ping: nosuch.invalid: Name or service not known" >&2; exit 2 ;;
  noperm) echo "ping: socket: Operation not permitted" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(fake, 0o755);

  it('pings every target in parallel and writes facts', async () => {
    const ctx = testContext();
    const c = createPing(cfg('ping', { bin: fake, targets: { internet: '1.1.1.1', router: '192.168.4.1', nas: '10.9.9.9' } }), ctx);
    expect(c).toMatchObject({ kind: 'ping', domains: ['ping'], intervalMs: 5000 });
    await c.poll(42);
    expect(ctx.facts.ping.get('internet')).toEqual({ target: '1.1.1.1', rttMs: 7.543, jitterMs: 0.374, lossPct: 0, at: 42 });
    expect(ctx.facts.ping.get('router')).toMatchObject({ target: '192.168.4.1', rttMs: 7.617, lossPct: 0 });
    expect(ctx.facts.ping.get('nas')).toEqual({ target: '10.9.9.9', rttMs: null, jitterMs: null, lossPct: 100, at: 42 });
  });

  it('records an unresolvable target as down but reports why', async () => {
    const ctx = testContext();
    const c = createPing(cfg('ping', { bin: fake, targets: { internet: '1.1.1.1', typo: 'nosuch.invalid' } }), ctx);
    await expect(c.poll(1)).rejects.toThrow(/typo \(nosuch\.invalid\): .*Name or service not known/);
    expect(ctx.facts.ping.get('typo')).toMatchObject({ lossPct: 100, rttMs: null });
    expect(ctx.facts.ping.get('internet')).toMatchObject({ lossPct: 0 });
  });

  it('treats missing ICMP permission or a missing binary as a collector failure, not packet loss', async () => {
    const ctx = testContext();
    await expect(createPing(cfg('ping', { bin: fake, targets: { internet: 'noperm' } }), ctx).poll(1)).rejects.toThrow(/Operation not permitted/);
    expect(ctx.facts.ping.has('internet')).toBe(false);
    await expect(createPing(cfg('ping', { bin: join(tmp.dir, 'nope'), targets: { a: '1.1.1.1' } }), ctx).poll(1)).rejects.toThrow(/not found/);
  });

  it('requires targets', () => {
    expect(() => createPing(cfg('ping', {}), testContext())).toThrow(/"targets"/);
    expect(() => createPing(cfg('ping', { targets: {} }), testContext())).toThrow(/"targets"/);
  });
});
