import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { interpolateEnv, parseConfig, parseSpeed, validateConfig } from '../config.ts';
import { exampleConfig } from './helpers.ts';

describe('config', () => {
  it('parses and validates the demo config', () => {
    const cfg = exampleConfig();
    expect(cfg.mode).toBe('demo');
    expect(cfg.topology.nodes.find((n) => n.kind === 'internet')?.id).toBe('internet');
    expect(cfg.services).toHaveLength(9);
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('parses the NetBox example, deferring cross-checks until NetBox is merged in', () => {
    const cfg = parseConfig(readFileSync(new URL('../../config/lab.example.yaml', import.meta.url), 'utf8'), {
      NETBOX_URL: 'http://netbox.local', NETBOX_TOKEN: 't',
    });
    expect(cfg.netbox).toMatchObject({ url: 'http://netbox.local', token: 't' });
    expect(cfg.topology.nodes).toEqual([]);
    expect(validateConfig(cfg)).toEqual([]);
    expect(validateConfig(cfg, { merged: true })).toContain('topology needs exactly one node of kind "internet"');
  });

  it('interpolates env vars with defaults, leaving no secrets in the file', () => {
    expect(interpolateEnv({ a: '${KEY}', b: ['x-${USER_X:-admin}'] }, { KEY: 's3cret' })).toEqual({ a: 's3cret', b: ['x-admin'] });
  });

  it('parses link speeds', () => {
    expect(parseSpeed('2.5G', '1G')).toBe(2.5e9);
    expect(parseSpeed(undefined, '10G')).toBe(10e9);
    expect(parseSpeed('100M', '1G')).toBe(100e6);
  });

  it('rejects broken topologies', () => {
    expect(() =>
      parseConfig(`topology:\n  nodes:\n    - { id: a, kind: host, label: A, parent: ghost, link: { medium: 1G } }\n`),
    ).toThrow(/unknown parent "ghost"[\s\S]*exactly one node of kind "internet"/);
  });
});
