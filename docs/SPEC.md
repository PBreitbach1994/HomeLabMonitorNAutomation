# Home Lab Control — Spec

A single live screen that answers two questions at a glance — **"is everything OK?"** and
**"what is the lab doing right now?"** — plus a drill-down Network page and, later,
guarded automation. The look takes its cue from three reference screenshots (Overview, Lab Live,
Network); the lab itself is whatever NetBox says it is.

---

## 1. Goals and non-goals

**Goals**

- Glanceable on a wall display or tablet, usable on a phone.
- Everything is *measured*, not decorative: cable animations, protocol colours and pipeline
  dots come from real counters and APIs. When a value is unknown the UI shows `—`, never a guess.
- One process, one config file, runs in a container on the lab itself.
- Same derivation code path in demo and live mode, so the demo is also an end-to-end test.
- Grows into automation: rules → incidents → notifications → (guarded) actions.

**Non-goals (for now)**

- Replacing Prometheus/Grafana for long-term metrics. We keep ~1h in memory (24h+ once SQLite lands).
- Deep packet inspection. "Protocol" means *which app is moving the bytes*, attributed from app APIs.
- Multi-user accounts / RBAC. LAN + Tailscale only, optional shared token.

---

## 2. Source of truth: NetBox

The dashboard knows nothing about a particular network. **NetBox** supplies the devices, how
they're cabled (traced through patch panels), LAG bonds, wireless backhaul, the internet circuit
and its plan speed, and which services get a tile. Tags on devices (`snmp`, `glances`) create the
collectors that measure them. `lab.yaml` keeps only credentials, collectors NetBox can't infer, and
optional overrides. NetBox is re-read every few minutes and the map updates in place; the last
good result is cached for when NetBox is down. The modelling conventions are in
[NETBOX.md](NETBOX.md).

Panels exist only for what the lab actually has: no storage source, no storage panel; no *arr
apps, no "imported" stage; no VPN-tagged service, no VPN chip.

---

## 3. Screens

### 3.1 Overview (`#/`)

| Region | Shows | Derived from |
|---|---|---|
| **Header** | title, `N attention` pill, `Live · 1s ago`, date, big clock, view menu | open incidents, SSE freshness |
| **Status strip** | host pills, `VPN up` (when a service uses one), LAN ↓↑ | hosts, VPN collector, edge switch ports |
| **Hero carousel** | dots switch between *Network Map* and *Lab Live*; auto-rotates in kiosk mode | topology + link rates |
| **Network Map** | left→right tree from NetBox: Internet → router → core → access switches → device column; access points along the bottom. Cable colour = medium, bonds as twin strands, Wi-Fi dotted; particle density = measured throughput, particle colour = protocol mix. Footer: busiest cables | §6.1, §6.2 |
| **Media pipeline** (only with download clients) | one row per release; stage dots for what the lab can evidence (requested → grabbed → downloading → downloaded → imported → in Plex, minus stages with no source); dot style = verified / inferred / no evidence / failed | §6.3 |
| **Hosts** | CPU gauge, memory bar, temp, uptime | Glances |
| **Services** | `7/7` grid of NetBox-tagged services, dot per app, tags like `MANUAL START`, `PAUSED` | Docker state + HTTP check |
| **Storage** (only with a storage source) | per volume: % used, free, one pip per disk coloured by health | NAS collector (phase 2) |
| **Incidents** | open first, then recently recovered | §6.4 |
| **Cameras** (only with a camera source) | recent motion/person events | camera collector (phase 3) |
| **Network** | internet RTT + sparkline, router RTT, avg ↓↑ this hour, today's totals, Internet/VPN/Tailscale chips, Wi-Fi summary | ping, collectors |

### 3.2 Lab Live (hero slide)

Schematic: Internet on top, router, then the hosts on an arc (Plex clients to the side when Plex is a service).
Beams carry particles proportional to throughput. Under each host: its containers, grouped into
*through the VPN* vs *outside it*; under a NAS: its volumes. Up to five hosts, those running the most services.

### 3.3 Network (`#/network`)

- **KPI tiles**: Internet ↓↑, total LAN throughput, active devices, top protocol (all with sparklines).
- **Topology tree** (vertical): Internet → router → core switch → access switches with every port
  as a row (name, model, link speed, live rate, mini sparkline, `VOL`/`APP` tag), Wi-Fi mesh column, info
  cards (core switch, internet health).
- **Selected device**: Overview / Traffic / Details tabs — 1h throughput chart, top protocols,
  device details (model, IP, link, uptime, CPU, memory, temp), live links.
- **VPN tunnel** card, **traffic by protocol** (stacked area, 1h), **busiest right now**, **link utilization**.

---

## 4. Architecture

```
 ┌──────────────── collectors (one per source, own interval) ────────────────┐
 │ snmp · unifi · ping · docker · glances · sabnzbd · qbittorrent · slskd      │
 │ sonarr/radarr/lidarr · seerr · plex · gluetun · tailscale · simulator         │
 └──────────────┬─────────────────────────────────────────────────────────────┘
                │  normalized FACTS (counters, queues, history, health…)
                ▼
        ┌──────────────┐   rates (counter deltas, EWMA)    ┌───────────────┐
        │  Fact store  │ ────────────────────────────────▶ │  Derivations  │
        └──────────────┘   ring-buffer history (10s, 1h)   │ links·mix·    │
                ▲                                          │ pipeline·     │
   NetBox (devices, cables, circuit, tagged services)     │ incidents     │
   + lab.yaml (credentials, overrides, extra collectors)
                                                           └──────┬────────┘
                                                                  ▼
                                                        Snapshot (every 2s)
                                                  /api/snapshot · /api/stream (SSE)
                                                  /api/history?key=…
                                                                  ▼
                                                  React UI (Vite) — SVG + canvas particles
```

**Key decisions**

1. **Facts, not views.** Collectors never compute UI values. They write raw-ish facts
   (interface octet counters, download queues, *arr history…). One `buildSnapshot()` turns facts
   into what the UI renders. The **simulator writes facts too** — it routes synthetic flows over the
   configured topology and increments the same port counters SNMP would. So demo mode exercises rate
   math, protocol attribution, pipeline correlation and incident rules for real.
2. **NetBox is the topology.** Devices, traced cable paths, LAGs, wireless links and the internet
   circuit become nodes and links; the switch-side interface of each cable is the port that measures
   it, with the far end as fallback. The YAML can override by id. (Pure YAML topology still works
   for the demo.)
3. **One Node/TypeScript process**, no framework on the server (plain `http`), SSE instead of
   WebSockets (one-way, auto-reconnect, proxy-friendly). Shared types in `shared/model.ts`.
4. **History**: in-memory ring buffers (10s resolution, 1h) in v0; SQLite with rollups
   (10s→1m→1h) in v2 for "today" totals that survive restarts and 24h/7d charts.
5. **Missing data is a first-class state.** Every metric is `number | null`; each collector reports
   its own health in `sources`, and a failing source raises an info incident instead of silently
   freezing numbers.

**Deployment**: one container (`docker compose up -d`) on a host with LAN reach (not inside a VPN
container's network namespace). `network_mode: host` (or `NET_RAW`) for ICMP/SNMP.
Mount `/var/run/docker.sock` read-only per host, or point the Docker collector at a socket proxy.

---

## 5. Data sources

| Source | Protocol / endpoint | Gives us | Auth | Interval | Phase |
|---|---|---|---|---|---|
| NetBox | REST `dcim/devices`, `dcim/interfaces` (traced `connected_endpoints`), `circuits/circuits`, `virtualization/virtual-machines`, `ipam/services` | topology, services, collector targets | read-only API token | 5 min | ✓ |
| Switches (any SNMP) | SNMP IF-MIB `ifHCInOctets/ifHCOutOctets/ifHighSpeed/ifOperStatus` | per-port counters → link rates | SNMPv3 read-only user | 5s | ✓ |
| UniFi switches | Network app `GET /proxy/network/api/s/default/stat/device` | `port_table[]` rx/tx bytes, speed, up | local admin (read-only) | 10s | ✓ |
| Ping | ICMP to `1.1.1.1` + gateway | RTT, jitter, loss | — | 5s | 1 |
| Docker | Engine API `GET /containers/json?all=1` (socket or socket-proxy) | container state/health per service | socket access | 15s | 1 |
| Glances | `GET /api/4/{cpu,mem,sensors,uptime}` | host CPU/mem/temp/uptime | — | 10s | 1 |
| NAS / storage | depends on the NAS (SNMP, its API, or a host agent) | volumes, disks, health | — | 60s | 2 |
| SABnzbd | `api?mode=queue|history&output=json` | queue, speed, history (failed/completed) | API key | 5s | 1 |
| qBittorrent | `/api/v2/transfer/info`, `/api/v2/torrents/info` | speeds, torrents | cookie login | 5s | 1 |
| Sonarr/Radarr/Lidarr | `/api/v3/queue`, `/api/v3/history`, `/api/v3/health` | grab/import events w/ `downloadId`, stuck items, health | API key | 15s | 1 |
| Seerr | `/api/v1/request` | requests (requested stage) | API key | 60s | 2 |
| Plex | `/status/sessions`, `/library/recentlyAdded` | streams + bandwidth, newly available media | `X-Plex-Token` | 10s | 1 |
| slskd | `/api/v0/transfers/downloads` | Soulseek rates | API key | 10s | 2 |
| Gluetun | control server `/v1/publicip/ip`, `/v1/vpn/status` | tunnel up, exit IP/country | optional | 15s | 1 |
| Tailscale | `tailscale status --json` / local API | up, peers online | — | 30s | 2 |
| Cameras | depends on the system | motion/person events | — | push | 3 |

---

## 6. Derivations

### 6.1 Link rates & utilization

- Each link is measured at exactly one port (`measure: device/ifName`). If the port belongs to the
  link's downstream device, *in* = down / *out* = up; on the upstream device it's the reverse.
- Rate = Δoctets·8 / Δt with 64-bit counters; negative deltas (reset/wrap) drop that sample.
  Smoothed with an EWMA (α≈0.5) so particles don't strobe.
- Utilization = max(down, up) / negotiated speed. Links with no counter render as dotted with `—`.
- Internet: the router interface cabled to the ISP circuit in NetBox; utilization is against the circuit's port speed (the plan), not the NIC.

### 6.2 Protocol attribution ("Usenet 47% of traffic")

App APIs report their own throughput: SABnzbd → **Usenet**, qBittorrent → **Torrent**, slskd →
**Soulseek**, Plex sessions → **Plex**. Each app flow is placed on the topology (host it runs on ↔
internet, or Plex host ↔ client) and its rate is added to every link on that path, capped at the
link's measured rate. Whatever is left is **Other**. This yields per-link mix (particle colours),
the stacked protocol chart, top protocol and the "busiest right now" table — no DPI required.

### 6.3 Media pipeline correlation

The join key is the download client id that the *arr apps record as `downloadId`
(SABnzbd `nzo_id`, qBittorrent info-hash).

| Stage | Verified when |
|---|---|
| requested | a Seerr request exists for the same media key |
| grabbed | *arr history `grabbed` or *arr queue entry with that `downloadId` |
| downloading | download client queue has the item (shows %) |
| downloaded | client history `Completed` (or `Failed` → red) |
| imported | *arr history `downloadFolderImported` for that `downloadId` |
| in Plex | Plex `recentlyAdded` has the media key after the import time |

A stage with no evidence but a later verified stage is **inferred** (dashed ring). Media key =
`tv:tvdb:<id>:s<NN>e<NN>` or `movie:tmdb:<id>` so Sonarr/Radarr ids can be matched to Plex guids.

### 6.4 Incidents

Rules run on every snapshot and return findings `{key, severity, title, detail}`. The engine keeps
the lifecycle: new key → **open** (optional "for N seconds" debounce), key gone → **recovered**
(kept 24h). `attention` = open warning + critical. Initial rules:

- service/container down (unless marked `manual` or `paused`), host unreachable
- VPN down (critical — also the trigger for the kill-switch automation), internet down / RTT spike
- disk or enclosure health ≠ good, volume > 90%
- download failed (recovers when the same media key is later imported)
- items stuck in an *arr queue (`importBlocked`, e.g. "release name didn't match")
- *arr `/health` warnings, collector source unreachable, link > 90% for 5 min

---

## 7. Automation (phase 3)

- **Notifications**: ntfy / Pushover / Discord webhook on incident open/recover, with quiet hours and
  per-rule severity floor.
- **Actions catalog** (button on incident / service tile): restart container, pause/resume SABnzbd
  queue, retry failed download (*arr: remove + blocklist + search), open manual import, Wake-on-LAN.
- **Reactive rules**: *VPN down → pause SABnzbd + qBittorrent*; *volume > 95% → pause downloads*;
  *Plex streams > N → throttle SABnzbd*.
- **Guardrails**: allow-list per action in config, confirm-to-run in UI, dry-run in demo mode,
  rate-limit, audit log of every action with who/when/result.

---

## 8. Security

- Bind to LAN/Tailscale only; optional `DASHBOARD_TOKEN` for the API and for any action.
- Secrets only via env vars (`${SONARR_API_KEY}` in `lab.yaml`), never committed. `config/lab.yaml`
  and `.env` are git-ignored.
- Read-only credentials wherever the device supports it (SNMPv3 read-only, UniFi view-only admin).
- Docker via a socket proxy that only allows `GET /containers` until actions ship.

---

## 9. Roadmap

| Phase | Scope |
|---|---|
| **0 — done** | spec, shared model, fact store, rate math, protocol attribution, pipeline correlation, incident engine, topology-aware simulator, SSE API, Overview + Lab Live + Network UI, collectors with fixture tests, Docker packaging |
| **1 — NetBox (done)** | NetBox as source of truth: topology, LAGs, wireless, circuit, service tiles, collector targets from tags; refresh + cache; bootstrap/export scripts; a pinned Docker deployment with one-command setup, backup and restore; a YAML inventory importer; tested against NetBox 4.7.5 |
| **2 — wire it up** | model the lab in NetBox, tag devices, `mode: mixed`; verify each collector against the real gear; NAS/storage and Wi-Fi sources for whatever the lab actually uses; SQLite history + daily totals |
| **3 — automate** | notifications, actions, reactive rules; optionally write back to NetBox (e.g. discovered LLDP neighbours as proposed cables) |
| **4 — polish** | kiosk mode (auto-rotate hero, burn-in shift), light theme, mobile layout pass, PWA |

---

## 10. Open questions

1. Is NetBox already running with the lab modelled, and which version?
2. Which switches and access points are there, and how can their port counters be read (SNMP, UniFi, other)?
3. Where should the dashboard run?
4. Is there a NAS, cameras, or a VPN worth a panel — and how are they reachable?
5. Preferred notification channel (ntfy, Pushover, Discord, Home Assistant…)?
