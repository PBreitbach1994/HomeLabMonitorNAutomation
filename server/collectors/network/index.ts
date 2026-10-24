import type { CollectorFactory } from '../types.ts';

/** Network & system collectors: snmp, unifi, ping, docker, glances, gluetun, tailscale. */
export const NETWORK_FACTORIES: Record<string, CollectorFactory> = {};
