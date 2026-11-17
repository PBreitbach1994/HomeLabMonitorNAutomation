// Loads a lab inventory file into NetBox.
//   NETBOX_URL=… NETBOX_TOKEN=<write token> npm run netbox:import -- my-lab.yaml --dry-run
//   NETBOX_URL=… NETBOX_TOKEN=<write token> npm run netbox:import -- my-lab.yaml
// The format is documented by example in examples/demo-lab.inventory.yaml.

import { readFileSync } from 'node:fs';
import { NetBoxClient } from '../server/netbox/client.ts';
import { applyInventory } from '../server/netbox/importer.ts';
import { InventoryError, parseInventory } from '../server/netbox/inventory.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const quiet = args.includes('--quiet');
if (!file) {
  console.error('usage: npm run netbox:import -- <inventory.yaml> [--dry-run] [--quiet]');
  process.exit(2);
}

try {
  const inv = parseInventory(readFileSync(file, 'utf8'));
  const nb = new NetBoxClient({ url: process.env.NETBOX_URL ?? '', token: process.env.NETBOX_TOKEN ?? '' });
  const r = await applyInventory(nb, inv, { dryRun, log: quiet ? undefined : (l) => console.log(`  ${l}`) });
  console.log(
    `\n${dryRun ? 'Dry run — nothing written. Would create' : 'Created'} ${r.created.length}, ` +
      `${dryRun ? 'update' : 'updated'} ${r.updated.length}, unchanged ${r.unchanged}.`,
  );
  if (r.warnings.length) {
    console.log(`\n${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}:`);
    for (const w of r.warnings) console.log(`  - ${w}`);
  }
} catch (err) {
  console.error(err instanceof InventoryError ? `${file}: ${err.message}` : (err as Error).message);
  process.exit(1);
}
