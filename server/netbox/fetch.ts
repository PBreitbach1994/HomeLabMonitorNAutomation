import type { NetboxConfig } from '../config.ts';
import { NetBoxError, type NetBoxClient } from './client.ts';
import type { Inventory, NbCircuit, NbDevice, NbInterface, NbService, NbVirtualMachine } from './types.ts';

/** Reads everything the topology builder needs, in as few calls as NetBox allows. */
export async function fetchInventory(nb: NetBoxClient, cfg: Pick<NetboxConfig, 'site' | 'tag'>, warn: (m: string) => void = () => {}): Promise<Inventory> {
  const site = cfg.site ? { site: cfg.site } : {};
  const tag = cfg.tag ?? 'dashboard';
  // An unknown tag slug is a 400 from NetBox; treat it as "nothing tagged yet".
  const tagged = <T>(path: string) =>
    nb.list<T>(path, { tag }).catch((err) => {
      if (err instanceof NetBoxError && err.status === 400) {
        warn(`NetBox has no "${tag}" tag yet — run \`npm run netbox:bootstrap\`, then tag the services you want as tiles.`);
        return [] as T[];
      }
      throw err;
    });

  const [status, devices, interfaces, vms, services] = await Promise.all([
    nb.get<Record<string, unknown>>('status/').catch(() => undefined),
    nb.list<NbDevice>('dcim/devices', site),
    nb.list<NbInterface>('dcim/interfaces', site),
    tagged<NbVirtualMachine>('virtualization/virtual-machines'),
    tagged<NbService>('ipam/services'),
  ]);
  if (cfg.site && devices.length === 0) warn(`NetBox site "${cfg.site}" has no devices — check the site slug.`);

  const circuitIds = new Set<number>();
  for (const i of interfaces) {
    if (i.link_peers_type !== 'circuits.circuittermination') continue;
    for (const p of i.link_peers ?? []) if (p.circuit?.id) circuitIds.add(p.circuit.id);
  }
  const circuits = await Promise.all([...circuitIds].map((id) => nb.get<NbCircuit>(`circuits/circuits/${id}/`)));

  return {
    fetchedAt: Date.now(),
    netboxVersion: typeof status?.['netbox-version'] === 'string' ? (status['netbox-version'] as string) : undefined,
    devices,
    interfaces,
    circuits,
    vms,
    services,
  };
}
