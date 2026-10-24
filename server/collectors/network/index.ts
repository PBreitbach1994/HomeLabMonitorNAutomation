import type { CollectorFactory } from '../types.ts';
import { createDocker } from './docker.ts';
import { createGlances } from './glances.ts';
import { createGluetun } from './gluetun.ts';
import { createPing } from './ping.ts';
import { createSnmp } from './snmp.ts';
import { createTailscale } from './tailscale.ts';
import { createUnifi } from './unifi.ts';

/** Network & system collectors: snmp, unifi, ping, docker, glances, gluetun, tailscale. */
export const NETWORK_FACTORIES: Record<string, CollectorFactory> = {
  snmp: createSnmp,
  unifi: createUnifi,
  ping: createPing,
  docker: createDocker,
  glances: createGlances,
  gluetun: createGluetun,
  tailscale: createTailscale,
};
