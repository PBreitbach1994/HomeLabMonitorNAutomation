// End-to-end: the collector walks a real (net-snmp) SNMP agent on localhost, so the session
// setup, v3 USM, getBulk walking and Counter64 Buffer handling are all the library's own.

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSnmp } from '../snmp.ts';
import { cfg, testContext } from './helpers.ts';

const snmp: any = createRequire(import.meta.url)('net-snmp');
const port = 20000 + Math.floor(Math.random() * 30000);
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8); // net-snmp's agent insists on 8-byte Counter64 buffers
  b.writeBigUInt64BE(n);
  return b;
};

let agent: any;

beforeAll(() => {
  agent = snmp.createAgent({ port, address: '127.0.0.1' }, () => {});
  const auth = agent.getAuthorizer();
  auth.addCommunity('public');
  auth.addUser({
    name: 'mon',
    level: snmp.SecurityLevel.authPriv,
    authProtocol: snmp.AuthProtocols.sha,
    authKey: 'authpass123',
    privProtocol: snmp.PrivProtocols.aes,
    privKey: 'privpass123',
  });
  const mib = agent.getMib();
  const RO = snmp.MaxAccess['read-only'];
  const NA = snmp.MaxAccess['not-accessible'];
  mib.registerProvider({
    name: 'ifEntry', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.2.2.1', maxAccess: NA,
    tableColumns: [
      { number: 1, name: 'ifIndex', type: snmp.ObjectType.Integer, maxAccess: RO },
      { number: 8, name: 'ifOperStatus', type: snmp.ObjectType.Integer, maxAccess: RO },
    ],
    tableIndex: [{ columnName: 'ifIndex' }],
  });
  mib.registerProvider({
    name: 'ifXEntry', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.31.1.1.1', maxAccess: NA,
    tableColumns: [
      { number: 1, name: 'ifName', type: snmp.ObjectType.OctetString, maxAccess: RO },
      { number: 6, name: 'ifHCInOctets', type: snmp.ObjectType.Counter64, maxAccess: RO },
      { number: 10, name: 'ifHCOutOctets', type: snmp.ObjectType.Counter64, maxAccess: RO },
      { number: 15, name: 'ifHighSpeed', type: snmp.ObjectType.Gauge, maxAccess: RO },
    ],
    tableAugments: 'ifEntry',
  });
  const rows: [number, string, bigint, bigint, number, number][] = [
    [1, 'ether1', 812_345_678_901n, 98_765_432_109n, 10000, 1],
    [2, 'ether2', 2n ** 63n + 5n, 1n, 10000, 1],
    [5, 'ether5', 0n, 0n, 0, 2],
  ];
  for (const [i, name, inO, outO, mbps, oper] of rows) {
    mib.addTableRow('ifEntry', [i, oper]);
    mib.addTableRow('ifXEntry', [i, name, u64(inO), u64(outO), mbps]);
  }
});

afterAll(() => agent?.close());

describe('snmp collector against a live agent', () => {
  it('walks IF-MIB over v2c', async () => {
    const ctx = testContext();
    const c = createSnmp(cfg('snmp', { host: '127.0.0.1', port, version: '2c', community: 'public', device: 'crs304' }), ctx);
    try {
      await c.poll(1_000_000);
    } finally {
      c.stop?.();
    }
    expect([...ctx.facts.ifaces.keys()]).toEqual(['crs304/ether1', 'crs304/ether2', 'crs304/ether5']);
    expect(ctx.facts.ifaces.get('crs304/ether1')).toMatchObject({ inOctets: 812_345_678_901, outOctets: 98_765_432_109, speedBps: 10e9, up: true });
    expect(ctx.facts.ifaces.get('crs304/ether2')!.inOctets).toBe(2 ** 63);
    expect(ctx.facts.ifaces.get('crs304/ether5')).toMatchObject({ up: false, speedBps: 0 });
  });

  it('walks over SNMPv3 authPriv (SHA/AES), reuses the session, and yields rates', async () => {
    const ctx = testContext();
    const c = createSnmp(
      cfg('snmp', {
        host: '127.0.0.1', port, version: 3, user: 'mon',
        authProtocol: 'sha', authKey: 'authpass123', privProtocol: 'aes', privKey: 'privpass123',
        device: 'crs304', ports: ['ether1'],
      }),
      ctx,
    );
    try {
      await c.poll(1_000_000);
      // +625 MB in 5 s on ether1 = 1 Gbit/s in.
      agent.getMib().setTableSingleCell('ifXEntry', 6, [1], u64(812_345_678_901n + 625_000_000n));
      await c.poll(1_005_000);
    } finally {
      c.stop?.();
    }
    expect([...ctx.facts.ifaces.keys()]).toEqual(['crs304/ether1']);
    expect(ctx.facts.ifaces.get('crs304/ether1')).toMatchObject({ inBps: 1e9, outBps: 0 });
  });
});
