import { readFileSync } from 'node:fs';
import type { Inventory } from '../types.ts';

/** Recorded from a real NetBox 4.7.5 loaded from examples/demo-lab.inventory.yaml (trimmed to the fields we read). */
export const inventory = (): Inventory =>
  JSON.parse(readFileSync(new URL('../__fixtures__/demo-lab-inventory.json', import.meta.url), 'utf8')) as Inventory;
