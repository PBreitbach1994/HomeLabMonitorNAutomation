// SNMP IF-MIB collector: per-port octet counters, speed and oper status → facts.ifaces.
// Keys are "<device>/<ifName>", matching `measure: crs304/ether1` in lab.yaml.

import { createRequire } from 'node:module';
import type { CollectorConfig } from '../../config.ts';
import type { IfaceSample } from '../../facts.ts';
import type { Collector, CollectorContext } from '../types.ts';
import { TIMEOUT_MS, errMsg, intervalMs, onceLogger, optList, optNum, optStr, reqStr } from './util.ts';

export const IF_MIB = {
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10', // Counter32 — only used for SNMPv1, which can't carry Counter64
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15', // Mbps
} as const;

type Column = keyof typeof IF_MIB;
const COLUMNS = Object.entries(IF_MIB) as [Column, string][];

/** net-snmp ObjectType codes for "no value here" varbinds. */
const VARBIND_ERRORS = new Set([128, 129, 130]); // NoSuchObject, NoSuchInstance, EndOfMibView

export interface Varbind {
  oid: string;
  type?: number;
  value: unknown;
}

export interface SnmpPort {
  ifIndex: string;
  ifName: string;
  sample: IfaceSample;
}

/**
 * Counter64 values arrive from net-snmp as the raw big-endian BER content bytes in a Buffer
 * (1–8 bytes, or 9 with a leading 0x00 when the top bit is set). Values past 2^53 lose
 * sub-byte precision when converted to a JS number, which is irrelevant for rate math.
 */
export function counter64(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'bigint') return v >= 0n ? Number(v) : null;
  if (v instanceof Uint8Array) {
    if (v.length === 0 || v.length > 9) return null;
    let n = 0n;
    for (const b of v) n = (n << 8n) | BigInt(b);
    return n <= 0xffff_ffff_ffff_ffffn ? Number(n) : null;
  }
  return null;
}

function displayString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8').replace(/\0+$/, '').trim();
  return null;
}

function gauge(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Turns walked IF-MIB varbinds into one sample per interface. Prefers the 64-bit HC counters
 * and falls back to 32-bit ifIn/OutOctets (SNMPv1). Interfaces without a name or counters are
 * skipped; `ports` limits the result to those ifNames.
 */
export function parseIfMib(varbinds: Varbind[], ports?: string[]): SnmpPort[] {
  const rows = new Map<string, Partial<Record<Column, unknown>>>();
  for (const vb of varbinds) {
    if (vb.type != null && VARBIND_ERRORS.has(vb.type)) continue;
    for (const [col, base] of COLUMNS) {
      if (!vb.oid.startsWith(`${base}.`)) continue;
      const index = vb.oid.slice(base.length + 1);
      const row = rows.get(index) ?? {};
      row[col] = vb.value;
      rows.set(index, row);
      break;
    }
  }
  const wanted = ports?.length ? new Set(ports) : null;
  const out: SnmpPort[] = [];
  for (const [ifIndex, r] of rows) {
    const ifName = displayString(r.ifName);
    if (!ifName || (wanted && !wanted.has(ifName))) continue;
    const inOctets = counter64(r.ifHCInOctets) ?? gauge(r.ifInOctets);
    const outOctets = counter64(r.ifHCOutOctets) ?? gauge(r.ifOutOctets);
    if (inOctets == null || outOctets == null) continue;
    const speedMbps = gauge(r.ifHighSpeed);
    const oper = gauge(r.ifOperStatus);
    out.push({
      ifIndex,
      ifName,
      sample: {
        inOctets,
        outOctets,
        speedBps: speedMbps == null ? undefined : speedMbps * 1e6,
        up: oper == null ? undefined : oper === 1, // 1 up, 2 down, 3 testing, 5 dormant, 7 lowerLayerDown…
      },
    });
  }
  return out.sort((a, b) => Number(a.ifIndex) - Number(b.ifIndex));
}

// ------------------------------------------------------------------ net-snmp binding

/** The slice of net-snmp (CommonJS, untyped) this collector uses. */
interface NetSnmp {
  Version1: number;
  Version2c: number;
  Version3: number;
  SecurityLevel: Record<'noAuthNoPriv' | 'authNoPriv' | 'authPriv', number>;
  AuthProtocols: Record<string, number>;
  PrivProtocols: Record<string, number>;
  createSession(target: string, community: string, options: object): SnmpSession;
  createV3Session(target: string, user: object, options: object): SnmpSession;
}

interface SnmpSession {
  subtree(
    oid: string,
    maxRepetitions: number,
    feed: (varbinds: Varbind[]) => boolean | void,
    done: (error: Error | null) => void,
  ): void;
  on(event: 'error' | 'close', cb: (err?: Error) => void): void;
  close(): void;
}

let netSnmp: NetSnmp | null = null;
function loadNetSnmp(): NetSnmp {
  netSnmp ??= createRequire(import.meta.url)('net-snmp') as NetSnmp;
  return netSnmp;
}

const AUTH_PROTOCOLS = ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'];
const PRIV_PROTOCOLS = ['des', 'aes', 'aes256b', 'aes256r'];

export interface SnmpTarget {
  host: string;
  port: number;
  version: '1' | '2c' | '3';
  community: string;
  user?: {
    name: string;
    level: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
    authProtocol?: string;
    authKey?: string;
    privProtocol?: string;
    privKey?: string;
  };
  context?: string;
}

/** Validates and normalizes the connection part of the config (no I/O). */
export function snmpTarget(cfg: CollectorConfig): SnmpTarget {
  const host = reqStr(cfg, 'host');
  const port = optNum(cfg, 'port') ?? 161;
  const user = optStr(cfg, 'user');
  const rawVersion = optStr(cfg, 'version')?.toLowerCase().replace(/^v/, '') ?? (user ? '3' : '2c');
  const version = rawVersion === '2' ? '2c' : rawVersion;
  if (version !== '1' && version !== '2c' && version !== '3') {
    throw new Error(`snmp: "version" must be 1, 2c or 3, got ${JSON.stringify(cfg.version)}`);
  }
  const target: SnmpTarget = { host, port, version, community: optStr(cfg, 'community') ?? 'public', context: optStr(cfg, 'context') };
  if (version !== '3') return target;

  if (!user) throw new Error('snmp: "user" is required for SNMPv3');
  const authKey = optStr(cfg, 'authKey');
  const privKey = optStr(cfg, 'privKey');
  const authProtocol = (optStr(cfg, 'authProtocol') ?? 'sha').toLowerCase();
  const privProtocol = (optStr(cfg, 'privProtocol') ?? 'aes').toLowerCase().replace(/^aes-?128$/, 'aes');
  if (privKey && !authKey) throw new Error('snmp: "privKey" needs "authKey" too (SNMPv3 has no privacy without auth)');
  if (authKey && !AUTH_PROTOCOLS.includes(authProtocol)) {
    throw new Error(`snmp: "authProtocol" must be one of ${AUTH_PROTOCOLS.join(', ')}`);
  }
  if (privKey && !PRIV_PROTOCOLS.includes(privProtocol)) {
    throw new Error(`snmp: "privProtocol" must be one of ${PRIV_PROTOCOLS.join(', ')}`);
  }
  target.user = {
    name: user,
    level: privKey ? 'authPriv' : authKey ? 'authNoPriv' : 'noAuthNoPriv',
    ...(authKey ? { authProtocol, authKey } : {}),
    ...(privKey ? { privProtocol, privKey } : {}),
  };
  return target;
}

function openSession(t: SnmpTarget, onError: (err: Error) => void): SnmpSession {
  const snmp = loadNetSnmp();
  // Per-request timeout; a walk is several requests, and poll() caps the whole thing at TIMEOUT_MS.
  const options = { port: t.port, retries: 1, timeout: 2000, backoff: 1, transport: t.host.includes(':') ? 'udp6' : 'udp4', context: t.context };
  let session: SnmpSession;
  if (t.version === '3' && t.user) {
    const u = t.user;
    session = snmp.createV3Session(t.host, {
      name: u.name,
      level: snmp.SecurityLevel[u.level],
      ...(u.authKey ? { authProtocol: snmp.AuthProtocols[u.authProtocol!], authKey: u.authKey } : {}),
      ...(u.privKey ? { privProtocol: snmp.PrivProtocols[u.privProtocol!], privKey: u.privKey } : {}),
    }, { ...options, version: snmp.Version3 });
  } else {
    session = snmp.createSession(t.host, t.community, { ...options, version: t.version === '1' ? snmp.Version1 : snmp.Version2c });
  }
  // An unhandled 'error' from the UDP socket would crash the process.
  session.on('error', (err) => onError(err ?? new Error('SNMP socket error')));
  return session;
}

function walk(session: SnmpSession, oid: string): Promise<Varbind[]> {
  return new Promise((resolve, reject) => {
    const out: Varbind[] = [];
    session.subtree(oid, 25, (vbs) => void out.push(...vbs), (err) => (err ? reject(err) : resolve(out)));
  });
}

export function createSnmp(cfg: CollectorConfig, ctx: CollectorContext): Collector {
  const target = snmpTarget(cfg);
  const device = optStr(cfg, 'device') ?? cfg.id;
  const ports = optList(cfg, 'ports');
  const timeoutMs = optNum(cfg, 'timeoutMs') ?? TIMEOUT_MS;
  const columns: string[] = target.version === '1'
    ? [IF_MIB.ifName, IF_MIB.ifInOctets, IF_MIB.ifOutOctets, IF_MIB.ifHighSpeed, IF_MIB.ifOperStatus]
    : [IF_MIB.ifName, IF_MIB.ifHCInOctets, IF_MIB.ifHCOutOctets, IF_MIB.ifHighSpeed, IF_MIB.ifOperStatus];
  const once = onceLogger(ctx.log);
  let session: SnmpSession | null = null;

  const reset = () => {
    try {
      session?.close();
    } catch {
      /* already closed */
    }
    session = null;
  };

  return {
    id: cfg.id,
    kind: 'snmp',
    intervalMs: intervalMs(cfg, 5),
    domains: ['ifaces'],
    async poll(now) {
      // Keep one session across polls (SNMPv3 engine discovery happens once); rebuild it after any failure.
      const s = (session ??= openSession(target, (err) => {
        ctx.log.warn(`collector "${cfg.id}": SNMP socket error: ${err.message}`);
        reset();
      }));
      let timer: NodeJS.Timeout | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`walk timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        const varbinds: Varbind[] = [];
        await Promise.race([
          (async () => {
            for (const oid of columns) varbinds.push(...(await walk(s, oid)));
          })(),
          deadline,
        ]);
        const found = parseIfMib(varbinds, ports);
        if (!found.length) {
          throw new Error(
            ports?.length
              ? `none of ports [${ports.join(', ')}] found on ${target.host} (check ifName values)`
              : `no IF-MIB interfaces with counters on ${target.host}${target.version === '1' ? '' : ' (agent may lack ifXTable HC counters; try version: 1)'}`,
          );
        }
        if (ports?.length) {
          const missing = ports.filter((p) => !found.some((f) => f.ifName === p));
          if (missing.length) once('warn', `collector "${cfg.id}": ports not found on ${target.host}: ${missing.join(', ')}`);
        }
        for (const p of found) ctx.facts.setIface(`${device}/${p.ifName}`, p.sample, now);
      } catch (err) {
        reset(); // closing cancels any requests still in flight
        const msg = errMsg(err);
        // SNMP agents silently drop requests with a wrong community / v3 key, so say so.
        throw new Error(/timed out/i.test(msg)
          ? `SNMP ${target.host}:${target.port}: ${msg} (no response — check host, port, ${target.version === '3' ? 'v3 user/keys/protocols' : 'community'})`
          : msg);
      } finally {
        clearTimeout(timer);
      }
    },
    stop: reset,
  };
}
