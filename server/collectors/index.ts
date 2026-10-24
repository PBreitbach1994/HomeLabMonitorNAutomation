import type { CollectorFactory } from './types.ts';
import { createSimulator } from './simulator.ts';
import { NETWORK_FACTORIES } from './network/index.ts';
import { MEDIA_FACTORIES } from './media/index.ts';

/** Collector kinds available to `collectors[].kind` in lab.yaml. */
export const FACTORIES: Record<string, CollectorFactory> = {
  simulator: createSimulator,
  ...NETWORK_FACTORIES,
  ...MEDIA_FACTORIES,
};
