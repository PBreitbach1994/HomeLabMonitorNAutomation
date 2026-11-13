// The few NetBox objects the dashboard reads, created idempotently (existing ones are left alone).

import type { NetBoxClient } from './client.ts';

export const TAGS = {
  dashboard: { name: 'dashboard', slug: 'dashboard', color: '2196f3', description: 'Show this service or VM as a tile on the home lab dashboard' },
  vpn: { name: 'vpn', slug: 'vpn', color: '4caf50', description: 'Traffic for this service leaves through the VPN tunnel' },
  snmp: { name: 'snmp', slug: 'snmp', color: '00bcd4', description: 'Poll this device over SNMP for port counters' },
  glances: { name: 'glances', slug: 'glances', color: '9c27b0', description: 'Read CPU, memory and temperature from Glances on this device' },
} as const;

export const CHOICE_SET = {
  name: 'Dashboard expected state',
  description: 'Whether the dashboard should expect this service to be running',
  extra_choices: [
    ['running', 'Running'],
    ['manual', 'Manual start'],
    ['paused', 'Paused'],
  ],
};

const SERVICE_TYPES = ['ipam.service', 'virtualization.virtualmachine'];

export const CUSTOM_FIELDS = [
  { name: 'dashboard_app', label: 'Dashboard app', type: 'text', description: 'What the service is, e.g. plex, sabnzbd, sonarr — tells collectors how to read it' },
  { name: 'dashboard_expect', label: 'Dashboard expected state', type: 'select', description: 'Manual start or paused services do not raise incidents when stopped' },
  { name: 'dashboard_container', label: 'Docker container', type: 'text', description: 'Container name, when it differs from the NetBox name' },
  { name: 'dashboard_health_url', label: 'Health check URL', type: 'url', description: 'Optional HTTP endpoint the dashboard probes' },
] as const;

interface Named {
  id: number;
  name: string;
  slug?: string;
}

async function findOne<T extends Named>(nb: NetBoxClient, path: string, filter: Record<string, string>): Promise<T | undefined> {
  const found = await nb.list<T>(path, filter);
  return found[0];
}

export async function ensureSchema(nb: NetBoxClient, log: (msg: string) => void = () => {}): Promise<void> {
  for (const tag of Object.values(TAGS)) {
    if (await findOne(nb, 'extras/tags', { slug: tag.slug })) continue;
    await nb.post('extras/tags/', tag);
    log(`created tag ${tag.slug}`);
  }
  let choiceSet = await findOne<Named>(nb, 'extras/custom-field-choice-sets', { name: CHOICE_SET.name });
  if (!choiceSet) {
    choiceSet = await nb.post<Named>('extras/custom-field-choice-sets/', CHOICE_SET);
    log(`created choice set "${CHOICE_SET.name}"`);
  }
  for (const cf of CUSTOM_FIELDS) {
    if (await findOne(nb, 'extras/custom-fields', { name: cf.name })) continue;
    await nb.post('extras/custom-fields/', {
      ...cf,
      object_types: SERVICE_TYPES,
      required: false,
      group_name: 'Dashboard',
      ...(cf.type === 'select' ? { choice_set: choiceSet.id } : {}),
    });
    log(`created custom field ${cf.name}`);
  }
}
