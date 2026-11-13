// The slices of NetBox API objects the dashboard reads (NetBox 4.x; older field names noted).

export interface NbRef {
  id: number;
  name?: string;
  display?: string;
  slug?: string;
}

export interface NbChoice {
  value: string;
  label?: string;
}

export interface NbTag {
  slug: string;
  name?: string;
}

export interface NbDevice {
  id: number;
  name: string | null;
  display?: string;
  display_url?: string;
  role?: NbRef; // 4.x
  device_role?: NbRef; // 3.x
  device_type: { model: string; manufacturer?: NbRef };
  status?: NbChoice;
  site?: NbRef;
  primary_ip?: { address: string } | null;
  cluster?: NbRef | null;
  tags?: NbTag[];
}

export interface NbInterface {
  id: number;
  name: string;
  device: NbRef;
  type: NbChoice;
  enabled?: boolean;
  mgmt_only?: boolean;
  speed?: number | null; // kbps
  lag?: NbRef | null;
  wireless_link?: NbRef | null;
  link_peers_type?: string | null;
  link_peers?: Array<{ id: number; circuit?: { id: number; cid?: string; provider?: NbRef } }>;
  connected_endpoints_type?: string | null;
  connected_endpoints?: Array<{ id: number; name: string; device?: NbRef }> | null;
  connected_endpoints_reachable?: boolean | null;
}

export interface NbCircuit {
  id: number;
  cid: string;
  provider: NbRef;
  commit_rate?: number | null; // kbps
  termination_a?: { id: number; port_speed?: number | null; upstream_speed?: number | null } | null;
  termination_z?: { id: number; port_speed?: number | null; upstream_speed?: number | null } | null;
}

type CustomFields = Record<string, unknown>;

export interface NbVirtualMachine {
  id: number;
  name: string;
  status?: NbChoice;
  device?: NbRef | null;
  cluster?: NbRef | null;
  tags?: NbTag[];
  custom_fields?: CustomFields;
}

export interface NbService {
  id: number;
  name: string;
  protocol?: NbChoice;
  ports?: number[];
  parent_object_type?: string; // 4.3+: dcim.device | virtualization.virtualmachine
  parent?: NbRef | null;
  device?: NbRef | null; // < 4.3
  virtual_machine?: NbRef | null; // < 4.3
  tags?: NbTag[];
  custom_fields?: CustomFields;
}

export interface Inventory {
  fetchedAt: number;
  netboxVersion?: string;
  devices: NbDevice[];
  interfaces: NbInterface[];
  circuits: NbCircuit[];
  vms: NbVirtualMachine[];
  services: NbService[];
}
