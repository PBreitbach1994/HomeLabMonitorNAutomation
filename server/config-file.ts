import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfig, type LabConfig } from './config.ts';

export function loadConfig(path?: string): { config: LabConfig; path: string } {
  const candidates = [path, process.env.LAB_CONFIG, 'config/lab.yaml', 'config/lab.example.yaml'].filter(
    (p): p is string => !!p,
  );
  const found = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
  if (!found) throw new Error(`No config found (looked for ${candidates.join(', ')})`);
  let config: LabConfig;
  try {
    config = parseConfig(readFileSync(found, 'utf8'), process.env);
  } catch (err) {
    throw new Error(`${found}: ${(err as Error).message}`);
  }
  if (process.env.LAB_MODE) config.mode = process.env.LAB_MODE as LabConfig['mode'];
  if (process.env.PORT) config.server.port = Number(process.env.PORT);
  if (process.env.DASHBOARD_TOKEN) config.server.token = process.env.DASHBOARD_TOKEN;
  return { config, path: found };
}
