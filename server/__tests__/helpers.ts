import { readFileSync } from 'node:fs';
import { parseConfig, type LabConfig } from '../config.ts';

export function exampleConfig(): LabConfig {
  return parseConfig(readFileSync(new URL('../../config/demo.yaml', import.meta.url), 'utf8'));
}
