import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUnifi, normalizeMac, parseUnifiDevices } from '../unifi.ts';
import { cfg, fixture, fixtureJson, json, serve, testContext, type TestServer } from './helpers.ts';

const statDevice = fixtureJson('unifi-stat-device.json');
// Mixed-case / dashed MACs in config must still match the controller's lower-case ones.
const devices = { '9C:05:D6:AA:00:0A': 'flex-a', '9c-05-d6-aa-00-0b': 'flex-b', '9c:05:d6:aa:00:0c': 'flex-spare' };

describe('parseUnifiDevices', () => {
  it('maps port_table entries of configured switches to <node>/<port_idx>', () => {
    const { ports, missing } = parseUnifiDevices(statDevice, devices);
    expect(ports.filter((p) => p.node === 'flex-a').map((p) => p.key)).toEqual(
      Array.from({ length: 9 }, (_, i) => `flex-a/${i + 1}`),
    );
    expect(ports.filter((p) => p.node === 'flex-b')).toHaveLength(9);
    expect(ports.find((p) => p.key === 'flex-a/3')!.sample).toEqual({
      inOctets: 6_401_993_220_118,
      outOctets: 1_822_004_993_201,
      speedBps: 2.5e9,
      up: true,
    });
    expect(ports.find((p) => p.key === 'flex-a/9')!.sample).toMatchObject({ speedBps: 10e9, up: true });
    expect(ports.find((p) => p.key === 'flex-a/7')!.sample).toMatchObject({ speedBps: 0, up: false });
    // Administratively disabled port.
    expect(ports.find((p) => p.key === 'flex-a/8')!.sample.up).toBe(false);
    // The AP isn't in `devices`; the disconnected switch (state 0) is reported missing, not zeroed.
    expect(ports.some((p) => p.mac === '74:ac:b9:11:22:33')).toBe(false);
    expect(missing).toEqual([{ mac: '9c:05:d6:aa:00:0c', node: 'flex-spare' }]);
  });

  it('surfaces API errors and odd shapes', () => {
    expect(() => parseUnifiDevices({ meta: { rc: 'error', msg: 'api.err.LoginRequired' }, data: [] }, devices)).toThrow(/LoginRequired/);
    expect(() => parseUnifiDevices({ nope: true }, devices)).toThrow(/unexpected response/);
    expect(parseUnifiDevices([], devices).ports).toEqual([]);
  });

  it('normalizes MAC spellings', () => {
    expect(normalizeMac('9C-05-D6-AA-00-0A')).toBe('9c:05:d6:aa:00:0a');
    expect(normalizeMac('9c05.d6aa.000a')).toBe('9c:05:d6:aa:00:0a');
  });
});

describe('unifi collector', () => {
  let srv: TestServer | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it('logs into UniFi OS, sends cookie + CSRF, and re-logs in on 401', async () => {
    let sessions = 0;
    let expireNext = false;
    srv = await serve((req, res, body) => {
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        const { username, password } = JSON.parse(body);
        if (username !== 'viewer' || password !== 's3cret') return json(res, 401, { error: 'bad creds' });
        sessions++;
        return json(res, 200, { username }, {
          'set-cookie': [`TOKEN=jwt${sessions}; path=/; samesite=none; secure; httponly`],
          'x-csrf-token': `csrf${sessions}`,
        });
      }
      if (req.url === '/proxy/network/api/s/default/stat/device') {
        if (req.headers.cookie !== `TOKEN=jwt${sessions}` || expireNext) {
          expireNext = false;
          return json(res, 401, { error: { code: 401, message: 'Unauthorized' } });
        }
        return json(res, 200, fixture('unifi-stat-device.json'));
      }
      json(res, 404, {});
    });
    const ctx = testContext();
    const c = createUnifi(cfg('unifi', { url: `${srv.url}/`, username: 'viewer', password: 's3cret', devices }), ctx);
    await c.poll(1_000);
    expect(ctx.facts.ifaces.get('flex-a/1')).toMatchObject({ inOctets: 912_334_556_771, outOctets: 7_120_998_331_002 });
    expect(srv.requests[1].headers['x-csrf-token']).toBe('csrf1');

    expireNext = true; // session expired server-side
    await c.poll(11_000);
    expect(sessions).toBe(2);
    expect(srv.requests.map((r) => r.url)).toEqual([
      '/api/auth/login',
      '/proxy/network/api/s/default/stat/device',
      '/proxy/network/api/s/default/stat/device',
      '/api/auth/login',
      '/proxy/network/api/s/default/stat/device',
    ]);
    expect(ctx.logs.some((l) => l.includes('flex-spare'))).toBe(true);
  });

  it('falls back to the legacy controller API when /api/auth/login is 404', async () => {
    srv = await serve((req, res) => {
      if (req.url === '/api/login' && req.method === 'POST') {
        return json(res, 200, { meta: { rc: 'ok' }, data: [] }, {
          'set-cookie': ['unifises=abc123; Path=/; Secure; HttpOnly', 'csrf_token=tok456; Path=/; Secure'],
        });
      }
      if (req.url === '/api/s/lab/stat/device' && req.headers.cookie === 'unifises=abc123; csrf_token=tok456') {
        return json(res, 200, fixture('unifi-stat-device.json'));
      }
      if (req.url?.startsWith('/api/s/')) return json(res, 401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' }, data: [] });
      json(res, 404, 'Not Found');
    });
    const ctx = testContext();
    const c = createUnifi(cfg('unifi', { url: srv.url, username: 'u', password: 'p', site: 'lab', devices }), ctx);
    await c.poll(1_000);
    expect(ctx.facts.ifaces.get('flex-b/2')).toMatchObject({ inOctets: 1_220_118_003_221 });
    expect(srv.requests.map((r) => r.url)).toEqual(['/api/auth/login', '/api/login', '/api/s/lab/stat/device']);
    expect(srv.requests[2].headers['x-csrf-token']).toBe('tok456');
  });

  it('backs off after a failed login instead of hammering the console', async () => {
    srv = await serve((_req, res) => json(res, 403, { error: 'nope' }));
    const c = createUnifi(cfg('unifi', { url: srv.url, username: 'u', password: 'bad', devices }), testContext());
    await expect(c.poll(1_000)).rejects.toThrow(/login failed: HTTP 403/);
    await expect(c.poll(11_000)).rejects.toThrow(/next attempt in 20s/);
    expect(srv.requests).toHaveLength(1);
  });

  // A throwaway self-signed cert is minted per run so no private key lives in the repo.
  const selfSigned = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'unifi-tls-'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
      ], { stdio: 'ignore' });
      return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();

  it.skipIf(!selfSigned)('accepts a self-signed console certificate only with insecure: true', async () => {
    const tls = createServer({ key: selfSigned!.key, cert: selfSigned!.cert }, (req, res) => {
      if (req.url === '/api/auth/login') return json(res, 200, {}, { 'set-cookie': ['TOKEN=t; path=/'], 'x-csrf-token': 'c' });
      json(res, 200, fixture('unifi-stat-device.json'));
    });
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
    try {
      const strict = createUnifi(cfg('unifi', { url, username: 'u', password: 'p', devices }), testContext());
      await expect(strict.poll(1_000)).rejects.toThrow(/self[- ]signed|certificate/i);

      const ctx = testContext();
      const lax = createUnifi(cfg('unifi', { url, username: 'u', password: 'p', insecure: true, devices }), ctx);
      await lax.poll(1_000);
      expect(ctx.facts.ifaces.has('flex-a/1')).toBe(true);
    } finally {
      tls.closeAllConnections();
      await new Promise((r) => tls.close(r));
    }
  });

  it('validates config', () => {
    const ctx = testContext();
    expect(() => createUnifi(cfg('unifi', { username: 'u', password: 'p', devices }), ctx)).toThrow(/"url" is required/);
    expect(() => createUnifi(cfg('unifi', { url: 'https://x', username: 'u', password: '', devices }), ctx)).toThrow(/"password"/);
    expect(() => createUnifi(cfg('unifi', { url: 'https://x', username: 'u', password: 'p' }), ctx)).toThrow(/"devices"/);
  });
});
