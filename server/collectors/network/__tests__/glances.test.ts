import { afterEach, describe, expect, it } from 'vitest';
import { createGlances, parseGlances, parseUptime, pickTemperature } from '../glances.ts';
import { cfg, fixture, fixtureJson, json, serve, testContext, type TestServer } from './helpers.ts';

const raw = {
  cpu: fixtureJson('glances-v4-cpu.json'),
  mem: fixtureJson('glances-v4-mem.json'),
  sensors: fixtureJson('glances-v4-sensors.json'),
  uptime: fixtureJson('glances-v4-uptime.json'),
};

describe('parseGlances', () => {
  it('reads cpu.total, mem.percent, the hottest CPU sensor and uptime', () => {
    // Core 1 (54) is the hottest CPU sensor; NVMe "Composite" (61) is ignored when CPU sensors exist.
    expect(parseGlances(raw)).toEqual({ cpuPct: 12.4, memPct: 41.3, tempC: 54, uptimeS: 11 * 86400 + 3600 + 2 * 60 + 3 });
  });

  it('reports nulls for what Glances does not have', () => {
    expect(parseGlances({ cpu: {}, mem: null })).toEqual({ cpuPct: null, memPct: null, tempC: null, uptimeS: null });
  });
});

describe('pickTemperature', () => {
  it('falls back to any temperature_core sensor, converts °F, and ignores junk', () => {
    expect(pickTemperature([{ label: 'Composite', value: 44, unit: 'C', type: 'temperature_core' }])).toBe(44);
    expect(pickTemperature([{ label: 'Package id 0', value: 122, unit: 'F', type: 'temperature_core' }])).toBe(50);
    expect(pickTemperature([{ label: 'acpitz 0', value: -273, unit: 'C', type: 'temperature_core' }])).toBeNull();
    expect(pickTemperature([{ label: 'fan1', value: 1200, unit: 'R', type: 'fan_speed' }])).toBeNull();
    expect(pickTemperature([])).toBeNull();
    expect(pickTemperature(undefined)).toBeNull();
  });
});

describe('parseUptime', () => {
  it('parses Python timedelta strings', () => {
    expect(parseUptime('11 days, 1:02:03')).toBe(954_123);
    expect(parseUptime('1 day, 0:00:05')).toBe(86_405);
    expect(parseUptime('3:04:05')).toBe(11_045);
    expect(parseUptime('0:00:59.123456')).toBe(59);
    expect(parseUptime(1234)).toBe(1234);
    expect(parseUptime('soon')).toBeNull();
  });
});

describe('glances collector', () => {
  let srv: TestServer | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it('polls /api/4 and tolerates a disabled sensors plugin', async () => {
    srv = await serve((req, res) => {
      const m = /^\/api\/4\/(cpu|mem|uptime)$/.exec(req.url ?? '');
      if (m) return json(res, 200, fixture(`glances-v4-${m[1]}.json`));
      json(res, 404, { detail: 'Unknown plugin sensors' });
    });
    const ctx = testContext();
    const c = createGlances(cfg('glances', { host: 'switchyard', url: srv.url }), ctx);
    expect(c).toMatchObject({ kind: 'glances', domains: ['hosts'], intervalMs: 10_000 });
    await c.poll(5);
    expect(ctx.facts.hosts.get('switchyard')).toEqual({ cpuPct: 12.4, memPct: 41.3, tempC: null, uptimeS: 954_123, at: 5 });
    expect(ctx.logs.some((l) => l.includes('sensors unavailable'))).toBe(true);
  });

  it('hints at apiVersion when /api/4 is missing, and sends basic auth', async () => {
    srv = await serve((req, res) => json(res, req.url?.startsWith('/api/3/') ? 200 : 404, req.url?.endsWith('cpu') ? { total: 3 } : { percent: 9 }));
    await expect(createGlances(cfg('glances', { host: 'h', url: srv.url }), testContext()).poll(1)).rejects.toThrow(/apiVersion: 3/);
    const ctx = testContext();
    await createGlances(cfg('glances', { host: 'h', url: srv.url, apiVersion: 3, username: 'glances', password: 'pw' }), ctx).poll(1);
    expect(ctx.facts.hosts.get('h')).toMatchObject({ cpuPct: 3, memPct: 9 });
    expect(srv.requests.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from('glances:pw').toString('base64')}`);
  });

  it('requires host and url', () => {
    expect(() => createGlances(cfg('glances', { url: 'http://x:61208' }), testContext())).toThrow(/"host"/);
    expect(() => createGlances(cfg('glances', { host: 'x' }), testContext())).toThrow(/"url"/);
  });
});
