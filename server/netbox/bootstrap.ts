// The few NetBox objects the dashboard reads, created idempotently (existing ones are left alone).
// The definitions live in schema.json, which deploy/netbox/setup.py also reads.

import type { NetBoxClient } from './client.ts';
import schema from './schema.json' with { type: 'json' };

export const TAGS = schema.tags;
export const CHOICE_SET = schema.choiceSet;
export const CUSTOM_FIELDS = schema.customFields;

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
  for (const tag of TAGS) {
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
      object_types: schema.customFieldObjectTypes,
      required: false,
      group_name: 'Dashboard',
      ...(cf.type === 'select' ? { choice_set: choiceSet.id } : {}),
    });
    log(`created custom field ${cf.name}`);
  }
}
