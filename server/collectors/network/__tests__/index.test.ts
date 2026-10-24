import { describe, expect, it } from 'vitest';
import { NETWORK_FACTORIES } from '../index.ts';
import { cfg, testContext } from './helpers.ts';

const minimal: Record<string, Record<string, unknown>> = {
  snmp: { host: '192.0.2.1', interval: 5 },
  unifi: { url: 'https://192.0.2.2', username: 'u', password: 'p', devices: { '00:00:00:00:00:0a': 'flex-a' }, interval: 10 },
  ping: { targets: { internet: '1.1.1.1' }, interval: 5 },
  docker: { url: 'http://192.0.2.3:2375', interval: 15 },
  glances: { host: 'switchyard', url: 'http://192.0.2.4:61208', interval: 10 },
  gluetun: { url: 'http://192.0.2.5:8000', interval: 15 },
  tailscale: { interval: 30 },
};

const domain: Record<string, string> = {
  snmp: 'ifaces', unifi: 'ifaces', ping: 'ping', docker: 'containers', glances: 'hosts', gluetun: 'vpn', tailscale: 'tailscale',
};

describe('NETWORK_FACTORIES', () => {
  it('registers every network kind', () => {
    expect(Object.keys(NETWORK_FACTORIES).sort()).toEqual(Object.keys(minimal).sort());
  });

  it.each(Object.keys(minimal))('%s builds a collector from config', (kind) => {
    const c = NETWORK_FACTORIES[kind](cfg(kind, minimal[kind]), testContext());
    expect(c).toMatchObject({ id: `test-${kind}`, kind, intervalMs: Number(minimal[kind].interval) * 1000, domains: [domain[kind]] });
    expect(typeof c.poll).toBe('function');
    c.stop?.();
  });
});
