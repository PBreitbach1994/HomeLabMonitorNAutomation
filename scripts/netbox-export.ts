// Prints the topology and service tiles the dashboard derives from NetBox, as lab.yaml-style YAML.
// Handy to check how NetBox is being read, or to freeze a snapshot:
//   NETBOX_URL=… NETBOX_TOKEN=… npx tsx scripts/netbox-export.ts [--site slug] > snapshot.yaml

import { stringify } from 'yaml';
import { NetBoxClient } from '../server/netbox/client.ts';
import { fetchInventory } from '../server/netbox/fetch.ts';
import { buildFromInventory } from '../server/netbox/topology.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const nb = new NetBoxClient({ url: process.env.NETBOX_URL ?? '', token: process.env.NETBOX_TOKEN ?? '' });
const warnings: string[] = [];
const inv = await fetchInventory(nb, { site: arg('--site') }, (w) => warnings.push(w));
const lab = buildFromInventory(inv);
warnings.push(...lab.warnings);
for (const w of warnings) console.error(`# warning: ${w}`);

// Drop NetBox links: a frozen snapshot shouldn't point at someone's NetBox.
const nodes = lab.nodes.map(({ href: _href, ...n }) => n);
process.stdout.write(
  stringify(
    { topology: { nodes }, services: lab.services },
    { lineWidth: 0, defaultKeyType: 'PLAIN', defaultStringType: 'PLAIN', collectionStyle: 'any' },
  ),
);
