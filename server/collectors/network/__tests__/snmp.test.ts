import { describe, expect, it } from 'vitest';
import { counter64, createSnmp, parseIfMib, snmpTarget, type Varbind } from '../snmp.ts';
import { cfg, fixtureJson, testContext } from './helpers.ts';

const varbinds = fixtureJson<Varbind[]>('snmp-crs304-ifmib.json');

describe('counter64', () => {
  it('decodes big-endian BER content bytes, with or without the sign-padding 0x00', () => {
    expect(counter64(Buffer.from([0]))).toBe(0);
    expect(counter64(Buffer.from([0x04, 0xd2]))).toBe(1234);
    expect(counter64(Buffer.from([0x01, 0, 0, 0, 0]))).toBe(2 ** 32);
    expect(counter64(Buffer.from([0x00, 0xbd, 0x23, 0x93, 0x5c, 0x35]))).toBe(812_345_678_901);
    // Top bit set → 9 bytes on the wire.
    expect(counter64(Buffer.from([0x00, 0x80, 0, 0, 0, 0, 0, 0, 0]))).toBe(2 ** 63);
    expect(counter64(Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBe(Number(2n ** 64n - 1n));
  });

  it('rejects things that are not a Counter64', () => {
    expect(counter64(Buffer.alloc(0))).toBeNull();
    expect(counter64(Buffer.alloc(10, 1))).toBeNull();
    expect(counter64('123')).toBeNull();
    expect(counter64(undefined)).toBeNull();
    expect(counter64(-1)).toBeNull();
    expect(counter64(42)).toBe(42);
    expect(counter64(42n)).toBe(42);
  });
});

describe('parseIfMib', () => {
  it('builds one sample per interface from walked ifXTable/ifTable varbinds', () => {
    const ports = parseIfMib(varbinds);
    expect(ports.map((p) => p.ifName)).toEqual(['ether1', 'ether2', 'ether3', 'ether4', 'ether5', 'bridge', 'lo']);
    expect(ports[0]).toEqual({
      ifIndex: '1',
      ifName: 'ether1',
      sample: { inOctets: 812_345_678_901, outOctets: 98_765_432_109, speedBps: 10e9, up: true },
    });
    expect(ports[1].sample).toEqual({ inOctets: 5_123_456_789_012, outOctets: 1_234_567_890_123, speedBps: 10e9, up: true });
    expect(ports[3].sample).toEqual({ inOctets: 0, outOctets: 0, speedBps: 0, up: false });
    expect(ports[4].sample).toMatchObject({ inOctets: 2 ** 32, speedBps: 1e9, up: true });
  });

  it('applies the ports filter', () => {
    expect(parseIfMib(varbinds, ['ether1', 'ether3']).map((p) => p.ifName)).toEqual(['ether1', 'ether3']);
  });

  it('falls back to 32-bit counters (SNMPv1) and skips error varbinds / rows without counters', () => {
    const v1: Varbind[] = [
      { oid: '1.3.6.1.2.1.31.1.1.1.1.1', type: 4, value: Buffer.from('ge-0/0/1') },
      { oid: '1.3.6.1.2.1.31.1.1.1.1.2', type: 4, value: Buffer.from('ge-0/0/2') },
      { oid: '1.3.6.1.2.1.2.2.1.10.1', type: 65, value: 3_000_000_000 },
      { oid: '1.3.6.1.2.1.2.2.1.16.1', type: 65, value: 12 },
      { oid: '1.3.6.1.2.1.31.1.1.1.6.1', type: 128, value: null }, // NoSuchObject
      { oid: '1.3.6.1.2.1.2.2.1.8.1', type: 2, value: 7 }, // lowerLayerDown
    ];
    expect(parseIfMib(v1)).toEqual([
      { ifIndex: '1', ifName: 'ge-0/0/1', sample: { inOctets: 3_000_000_000, outOctets: 12, speedBps: undefined, up: false } },
    ]);
  });
});

describe('snmp config', () => {
  it('infers v3 authPriv from the keys and maps protocols', () => {
    const t = snmpTarget(cfg('snmp', { host: '192.168.7.250', version: 3, user: 'mon', authProtocol: 'SHA', authKey: 'authpass1', privProtocol: 'AES', privKey: 'privpass1' }));
    expect(t).toMatchObject({ version: '3', port: 161, user: { name: 'mon', level: 'authPriv', authProtocol: 'sha', privProtocol: 'aes' } });
  });

  it('defaults to v2c with community "public", or v3 when a user is given', () => {
    expect(snmpTarget(cfg('snmp', { host: 'sw' }))).toMatchObject({ version: '2c', community: 'public' });
    expect(snmpTarget(cfg('snmp', { host: 'sw', version: '2' })).version).toBe('2c');
    expect(snmpTarget(cfg('snmp', { host: 'sw', user: 'mon' }))).toMatchObject({ version: '3', user: { level: 'noAuthNoPriv' } });
  });

  it('rejects bad config with a clear message', () => {
    expect(() => snmpTarget(cfg('snmp', {}))).toThrow(/"host" is required/);
    expect(() => snmpTarget(cfg('snmp', { host: 'sw', version: 3, user: '' }))).toThrow(/"user" is required/);
    expect(() => snmpTarget(cfg('snmp', { host: 'sw', version: 3, user: 'u', privKey: 'p' }))).toThrow(/needs "authKey"/);
    expect(() => snmpTarget(cfg('snmp', { host: 'sw', version: 3, user: 'u', authKey: 'k', authProtocol: 'sha3' }))).toThrow(/authProtocol/);
    expect(() => snmpTarget(cfg('snmp', { host: 'sw', version: 4 }))).toThrow(/version/);
  });

  it('builds a collector keyed by device', () => {
    const c = createSnmp(cfg('snmp', { host: 'sw', device: 'crs304', interval: 5 }), testContext());
    expect(c).toMatchObject({ kind: 'snmp', intervalMs: 5000, domains: ['ifaces'] });
    c.stop?.();
  });
});
