// Creates the tags and custom fields the dashboard reads in your NetBox. Safe to re-run:
// anything that already exists is left alone. Needs a token allowed to add tags/custom fields.
//   NETBOX_URL=https://netbox.local NETBOX_TOKEN=… npm run netbox:bootstrap

import { NetBoxClient } from '../server/netbox/client.ts';
import { CUSTOM_FIELDS, TAGS, ensureSchema } from '../server/netbox/bootstrap.ts';

const nb = new NetBoxClient({ url: process.env.NETBOX_URL ?? '', token: process.env.NETBOX_TOKEN ?? '' });
try {
  const created: string[] = [];
  await ensureSchema(nb, (m) => created.push(m));
  console.log(created.length ? created.map((m) => `  ${m}`).join('\n') : '  everything already in place');
  console.log(`\nTags: ${Object.values(TAGS).map((t) => t.slug).join(', ')}`);
  console.log(`Custom fields (on services and VMs): ${CUSTOM_FIELDS.map((f) => f.name).join(', ')}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
