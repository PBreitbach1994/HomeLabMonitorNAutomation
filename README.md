# Home Lab Control

A live, glanceable dashboard for a home lab: an animated network map whose particles follow
**measured** throughput, hosts, services, incidents, and (when the lab has them) downloads, storage
and cameras — plus a drill-down Network page.

**NetBox is the source of truth.** Devices, cabling (through patch panels), LAG bonds, Wi-Fi
backhaul, the internet circuit and which services get a tile all come from NetBox; tags on devices
decide what gets polled. See **[docs/NETBOX.md](docs/NETBOX.md)**. The design is in
[docs/SPEC.md](docs/SPEC.md).

## Quick start (demo)

```bash
npm install
npm run dev          # API on :8787 + Vite on :5173 → open http://localhost:5173
```

With no `config/lab.yaml`, it runs `config/demo.yaml`: a fictional lab driven by a simulator that
writes the same raw facts real collectors do, so everything on screen goes through the real rate
math, traffic attribution, pipeline correlation and incident rules. Add `?demo` to the URL to run
the whole thing in the browser with no server.

## Your lab, from NetBox

No NetBox yet? `deploy/netbox/setup.sh` stands one up in Docker with fresh secrets, the dashboard's
tags and a read-only token. Then describe your lab in one YAML file and load it with
`npm run netbox:import`. See [deploy/netbox/README.md](deploy/netbox/README.md).

```bash
cp config/lab.example.yaml config/lab.yaml
cp .env.example .env                       # NETBOX_URL, NETBOX_TOKEN (read-only), collector secrets
NETBOX_URL=… NETBOX_TOKEN=<write token> npm run netbox:bootstrap   # tags + custom fields, once
npm run netbox:export -- --site <slug>     # see what the dashboard derives, and any warnings
npm run build && npm start                 # or: docker compose up -d --build
```

Start in `mode: demo` (your real topology, simulated traffic), then `mixed` as collectors come
online, then `live`. The ⋯ menu lists every source with its last success, error, or NetBox advice.

## Layout

```
shared/model.ts            Snapshot types shared by server and UI
server/
  netbox/                  NetBox client, inventory → topology/services/collectors, refresh + cache
  facts.ts                 FactStore — what collectors write (counters, queues, history…)
  derive/                  link rates + bonds + attribution, media pipeline, incident rules
  snapshot.ts              facts → Snapshot (every 2s), ring-buffer history
  collectors/              simulator + real collectors (network/, media/)
  http.ts, index.ts        SSE stream, history API, static UI
web/src/                   React UI (SVG + canvas particles)
config/                    demo.yaml (fictional lab), lab.example.yaml (NetBox-driven)
scripts/                   netbox-import, netbox-bootstrap, netbox-export
deploy/netbox/             NetBox stack: setup.sh, backup.sh, restore.sh
examples/                  demo-lab.inventory.yaml (the inventory format, by example)
```

## API

| Endpoint | |
|---|---|
| `GET /api/stream` | Server-sent events, `snapshot` every 2s |
| `GET /api/snapshot` | Latest snapshot as JSON |
| `GET /api/history?key=link:<device>-up&n=360` | 10s samples (`link:<id>[:down|:up]`, `internet:rtt`, `proto:<p>`, `host:<id>:cpu`, …) |
| `GET /api/health` | Liveness |

Set `DASHBOARD_TOKEN` to require `Authorization: Bearer …` (or `?token=` for the UI).

## Checks

```bash
npm run typecheck && npm test && npm run build
```
