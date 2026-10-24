# Home Lab Control

A live, glanceable dashboard for the home lab: an animated network map whose particles follow
**measured** throughput, a media pipeline that traces each release from request to Plex, hosts,
services, storage health, incidents and cameras — plus a drill-down Network page.

The design rationale, data sources and roadmap are in **[docs/SPEC.md](docs/SPEC.md)**.

## Quick start

```bash
npm install
npm run dev          # API on :8787 + Vite on :5173 → open http://localhost:5173
```

Out of the box it runs in **demo mode**: a topology-aware simulator drives every panel over the
topology in `config/lab.example.yaml`. The simulator writes the same raw facts real collectors do
(port counters, SABnzbd queues, Sonarr history, …), so everything you see goes through the real
rate math, protocol attribution, pipeline correlation and incident rules.

Production-style:

```bash
npm run build && npm start      # serves UI + API on :8787
# or
cp .env.example .env && cp config/lab.example.yaml config/lab.yaml
docker compose up -d --build
```

Add `?demo` to the URL to run the whole pipeline in the browser with no server (that's also how the
static demo build works: `VITE_STATIC_DEMO=1 npm run build`). Add `?kiosk` to auto-rotate the hero.

## Going live

1. `cp config/lab.example.yaml config/lab.yaml` and describe your topology: each node's `parent`,
   the cable `medium`, and the switch port that measures it (`measure: flex-a/3`).
2. Put secrets in `.env` (see `.env.example`); reference them in YAML as `${NAME}`.
3. Set `mode: mixed`, flip `enabled: true` on collectors one at a time. Real data replaces simulated
   data per domain/port as each collector comes up; the header shows **PARTLY SIMULATED** until
   you switch to `mode: live`.
4. The ⋯ menu lists every source with its last success or error.

## Layout

```
shared/model.ts            Snapshot types shared by server and UI
server/
  facts.ts                 FactStore — what collectors write (counters, queues, history…)
  derive/                  topology + rates + attribution, media pipeline, incident rules
  snapshot.ts              facts → Snapshot (every 2s), ring-buffer history
  collectors/              simulator + real collectors (network/, media/)
  http.ts, index.ts        SSE stream, history API, static UI
web/src/                   React UI (SVG + canvas particles), no UI framework
config/lab.example.yaml    topology, services, collectors
```

## API

| Endpoint | |
|---|---|
| `GET /api/stream` | Server-sent events, `snapshot` every 2s |
| `GET /api/snapshot` | Latest snapshot as JSON |
| `GET /api/history?key=link:switchyard-up&n=360` | 10s samples (`link:<id>[:down|:up]`, `internet:rtt`, `proto:usenet`, `host:<id>:cpu`, …) |
| `GET /api/health` | Liveness |

Set `DASHBOARD_TOKEN` to require `Authorization: Bearer …` (or `?token=` for the UI).

## Checks

```bash
npm run typecheck && npm test && npm run build
```
