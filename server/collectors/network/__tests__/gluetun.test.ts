import { afterEach, describe, expect, it } from 'vitest';
import { createGluetun, parseGluetun } from '../gluetun.ts';
import { cfg, fixture, fixtureJson, json, serve, testContext, type TestServer } from './helpers.ts';

describe('parseGluetun', () => {
  it('combines tunnel status and public IP info', () => {
    expect(parseGluetun({ status: fixtureJson('gluetun-vpn-status.json'), publicIp: fixtureJson('gluetun-publicip.json') })).toEqual({
      up: true,
      provider: 'AS9009 M247 Europe SRL',
      publicIp: '203.0.113.42',
      country: 'Switzerland',
    });
  });

  it('prefers a configured provider label and tolerates the old/empty publicip shape', () => {
    expect(parseGluetun({ status: { status: 'stopped' }, publicIp: { public_ip: '' } }, { provider: 'Mullvad' })).toEqual({
      up: false, provider: 'Mullvad', publicIp: undefined, country: undefined,
    });
    expect(parseGluetun({ status: { status: 'running' } })).toMatchObject({ up: true, publicIp: undefined });
    expect(() => parseGluetun({ status: {} })).toThrow(/no "status"/);
  });
});

describe('gluetun collector', () => {
  let srv: TestServer | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it('falls back to /v1/openvpn/status on 404 and sends X-API-Key', async () => {
    srv = await serve((req, res) => {
      if (req.headers['x-api-key'] !== 'k3y') return json(res, 401, 'Unauthorized');
      if (req.url === '/v1/openvpn/status') return json(res, 200, { status: 'running' });
      if (req.url === '/v1/publicip/ip') return json(res, 200, fixture('gluetun-publicip.json'));
      json(res, 404, 'Not found');
    });
    const ctx = testContext();
    const c = createGluetun(cfg('gluetun', { url: srv.url, host: 'switchyard', apiKey: 'k3y' }), ctx);
    expect(c).toMatchObject({ kind: 'gluetun', domains: ['vpn'], intervalMs: 15_000 });
    await c.poll(9);
    expect(ctx.facts.vpn).toEqual({
      up: true, provider: 'AS9009 M247 Europe SRL', publicIp: '203.0.113.42', country: 'Switzerland', host: 'switchyard', at: 9,
    });
    await c.poll(10); // remembers the working route
    expect(srv.requests.filter((r) => r.url === '/v1/vpn/status')).toHaveLength(1);
  });

  it('marks the tunnel down only when Gluetun says so', async () => {
    srv = await serve((req, res) =>
      req.url === '/v1/vpn/status' ? json(res, 200, { status: 'stopped' }) : json(res, 200, { public_ip: '' }),
    );
    const ctx = testContext();
    await createGluetun(cfg('gluetun', { url: srv.url, apiKey: '' }), ctx).poll(1);
    expect(ctx.facts.vpn).toMatchObject({ up: false, publicIp: undefined });
    expect(srv.requests[0].headers['x-api-key']).toBeUndefined(); // ${GLUETUN_API_KEY:-} → ''
  });

  it('throws (collector failure) when the control server is unreachable or wants auth', async () => {
    srv = await serve((_req, res) => json(res, 401, 'Unauthorized'));
    const ctx = testContext();
    await expect(createGluetun(cfg('gluetun', { url: srv.url }), ctx).poll(1)).rejects.toThrow(/wants auth/);
    const dead = srv.url;
    await srv.close();
    srv = null;
    await expect(createGluetun(cfg('gluetun', { url: dead }), ctx).poll(1)).rejects.toThrow(/ECONNREFUSED/);
    expect(ctx.facts.vpn).toBeNull();
  });

  it('requires url', () => {
    expect(() => createGluetun(cfg('gluetun', {}), testContext())).toThrow(/"url"/);
  });
});
