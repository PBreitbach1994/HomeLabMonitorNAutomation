# NetBox as the source of truth

The dashboard reads your lab from NetBox: which devices exist, how they're cabled, where the
internet comes in, and which services deserve a tile. Nothing about your network is hard-coded,
and the map changes when NetBox does (it re-reads every 5 minutes).

## Setup

1. **Create two tokens** in NetBox (*User → API Tokens*):
   - a **read-only** token for the dashboard;
   - a token that may add tags and custom fields, used once for the bootstrap (or run it as an admin).
   Both v1 tokens and NetBox 4.5+ v2 tokens (`nbt_…`) work.
2. **Bootstrap** the few objects the dashboard reads (safe to re-run; it never changes existing ones):
   ```bash
   NETBOX_URL=https://netbox.lan NETBOX_TOKEN=<write token> npm run netbox:bootstrap
   ```
   This adds the tags `dashboard`, `vpn`, `snmp`, `glances` and four optional custom fields on
   services and VMs (`dashboard_app`, `dashboard_expect`, `dashboard_container`, `dashboard_health_url`).
3. **Configure the dashboard**: `cp config/lab.example.yaml config/lab.yaml`, put
   `NETBOX_URL` / `NETBOX_TOKEN` (read-only) in `.env`, set `netbox.site` if you have several sites.
4. **Check what it sees** before looking at the map:
   ```bash
   NETBOX_URL=… NETBOX_TOKEN=… npm run netbox:export -- --site home
   ```
   This prints the derived topology and tiles as YAML, plus any modelling warnings.

Start in `mode: demo` to see your real topology with simulated traffic, then switch to
`mixed`/`live` as collectors come online.

## What is read, and how

| In NetBox | On the dashboard |
|---|---|
| **Device** (status active/offline/failed/staged) | A node. Its **name** is its id everywhere — collectors, overrides, port keys. |
| Device **role** slug | The node kind: `router`, `switch`, `access-point`, `server`, `nas`, `workstation`, `printer`… Unknown slugs are guessed from their words; override with `netbox.roles`. |
| Device type, manufacturer | The model line under the name. |
| Primary IP | Where auto-created collectors connect (SNMP, Glances, ping). |
| **Cables** between interfaces | The links. Paths are *traced*, so patch panels (front/rear ports) in between are fine. |
| Interface type or speed | Link medium and capacity (`2.5gbase-t` → 2.5G). Set *speed* to override. |
| **LAG** (member interfaces with *Parent LAG* set) | Several cables to the same neighbour become one bonded link; capacity and traffic are summed. |
| **Wireless link** between two interfaces | A Wi-Fi backhaul link (wired paths are preferred when both exist). |
| **Circuit** whose termination is cabled to a device interface | The internet. Provider → label, termination *port speed* (else *commit rate*) → the plan the WAN utilization is measured against, that interface → the WAN counters. The device on the other end is the root of the map. |
| **VM** or **IPAM service** tagged `dashboard` | A service tile, on the VM's pinned device (or its cluster's only device) or the service's parent device. |
| tag `vpn` on a VM/service | The service's traffic leaves through the VPN tunnel. |
| `dashboard_expect` = manual / paused | Stopped/paused doesn't raise an incident. |
| `dashboard_app` | What the service is (`plex`, `sabnzbd`, `qbittorrent`, `sonarr`…), so app collectors and the traffic attribution can find it. |
| `dashboard_container` | The Docker container name, when it differs (matching already ignores case and punctuation). |
| tag `snmp` on a device | An SNMP collector for it (credentials from `netbox.collectors.snmp`). |
| tag `glances` on a device | A Glances collector at `http://<primary IP>:61208`. |

Devices that have interfaces but no traced path to the root are left off the map and listed in a
warning (on the Network page and in the ⋯ menu), as are tiles whose host isn't on the map.

### Interface names must match the counters

Each link is measured at the **parent's** port (e.g. the switch port facing a server), falling back
to the far end. The key is `<device name>/<interface name>`, so NetBox interface names need to match
what the collector reports:

- **SNMP**: the interface's `ifName` (MikroTik `ether1`/`sfp-sfpplus1`, Cisco `Gi1/0/1`…). Check with
  `snmpwalk -v2c -c <community> <ip> 1.3.6.1.2.1.31.1.1.1.1`.
- **UniFi**: the port name shown in the controller (default `Port 1`…), or the port number.

The NetBox community device-type library usually uses the vendor's names already.

### YAML overrides

`topology.nodes` and `services` in `lab.yaml` override NetBox entries by id (a node's id is the
device name; a tile's id is its name, lower-cased and dashed). Use it for display tweaks or links
NetBox can't express; anything not in NetBox is appended.

## When NetBox is down

The last good result is cached in `data/netbox-cache.json`, so the dashboard still starts with the
last known map and retries every 30 seconds. With Docker, mount `./data` and make it writable for
the container user: `mkdir -p data && sudo chown 1000:1000 data`.

## Trying it without touching your NetBox

`scripts/netbox-seed-demo.ts --confirm` creates a fictional *Demo Lab* site (router, three
switches, a LAG-bonded server, a patch panel, a wireless mesh AP, containers as VMs, an ISP circuit)
in a throwaway NetBox. It's how this integration was tested against NetBox 4.7.5.
