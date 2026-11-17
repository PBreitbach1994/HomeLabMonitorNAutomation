# NetBox

A pinned NetBox 4.7 stack (netbox-docker 5.1.2: NetBox, worker, Postgres 18, Valkey) with a
one-command setup that generates its own secrets and prepares NetBox for the dashboard.

## 1. Stand it up (home lab)

You need a Linux machine or VM with Docker Engine and the Compose plugin, about 2 CPUs, 4 GB RAM
and 10 GB of disk. Give it a fixed IP or DHCP reservation. Don't put it inside a VPN container's
network.

```bash
git clone -b claude/homelab-control https://github.com/PBreitbach1994/HomeLabMonitorNAutomation
cd HomeLabMonitorNAutomation/deploy/netbox
./setup.sh
```

The first start runs every database migration and takes a few minutes (longer on a Pi or slow
disk). When it finishes it prints the URL, by default `http://<this machine>:8000`.

- Log in as `admin`. The generated password is in `secrets/admin.env`; move it to your password
  manager, or change it in NetBox under your user menu.
- `secrets/dashboard.env` holds `NETBOX_URL` and a **read-only** token for the dashboard. A
  separate `dashboard` user owns it and can view everything but change nothing.
- To change the port or bind address, put `NETBOX_PORT=8000` or `NETBOX_BIND=127.0.0.1` in
  `deploy/netbox/.env`, then run `./setup.sh` again.

`setup.sh` is safe to re-run. It keeps existing secrets, users and tokens, and only fills in what's
missing.

## 2. Put your lab in it

Clicking in hundreds of interfaces and cables is the slow part. Describe the lab in one YAML file
instead and import it. The format is shown in full in
[`examples/demo-lab.inventory.yaml`](../../examples/demo-lab.inventory.yaml): devices, interfaces
(`port[1-8]` ranges), LAGs, patch panels, cables, Wi-Fi backhaul, the ISP circuit, and the services
you want as tiles.

1. In NetBox, create a token that can write: *Admin → API Tokens → Add*, user `admin`, with
   *Write enabled* ticked.
2. From any machine with Node 22 and this repo (`npm install` once):
   ```bash
   cp examples/demo-lab.inventory.yaml ~/my-lab.yaml   # keep it private: it lists IPs and devices
   # edit it to match your lab, then:
   export NETBOX_URL=http://<netbox-host>:8000 NETBOX_TOKEN=<write token>
   npm run netbox:import -- ~/my-lab.yaml --dry-run    # shows what it would create
   npm run netbox:import -- ~/my-lab.yaml
   npm run netbox:export -- --site <your site slug>    # what the dashboard will see
   ```
3. Revoke the write token when you're done, or keep it only where you run imports.

Re-running the import after editing the file only adds what's new. It also fixes small drift
(role, model, tags, interface type). It never deletes anything, and it won't re-cable a port that
NetBox already shows connected elsewhere; that shows up as a warning instead.

Modelling conventions the dashboard relies on are in [docs/NETBOX.md](../../docs/NETBOX.md).

## 3. Point the dashboard at it

Copy the two lines from `secrets/dashboard.env` into the repository's `.env`, copy
`config/lab.example.yaml` to `config/lab.yaml`, and start the dashboard (see the main README). Begin
with `mode: demo` to check the map against your real topology.

## Day-to-day

| Task | Command |
|---|---|
| Back up (database, media, secrets) | `./backup.sh`. Schedule it nightly (`crontab -e`: `15 3 * * * /path/to/deploy/netbox/backup.sh`) and set `BACKUP_DIR` to somewhere off this machine. |
| Restore | `./restore.sh backups/netbox-db-<timestamp>.sql.gz`. On a new machine, first restore `env/` and `secrets/` from the matching `netbox-config-*.tar.gz`. |
| Upgrade | Read the NetBox release notes, `./backup.sh`, set `NETBOX_VERSION=v4.x.y-<netbox-docker version>` in `.env`, then `./setup.sh`. Migrations run on start. |
| New dashboard token | `./setup.sh --new-dashboard-token` (the old one stops working) |
| Logs | `docker compose logs -f netbox` |
| Stop / start | `docker compose stop` / `docker compose up -d` |

Keep `env/` and `secrets/` private. `env/netbox.env` holds the database password, the secret key
and the token pepper. Without the pepper, every API token stops working after a restore.

## Doing this at work

The same stack works. These are the differences to plan for:

- **Where it runs.** A VM the infrastructure team owns, with snapshots and monitoring. Give it about
  4 CPUs and 8 GB RAM. Postgres can move to a managed database by pointing `DB_HOST`/`DB_*` in
  `env/netbox.env` at it and removing the `postgres` service.
- **HTTPS and hostname.** Put it behind the company reverse proxy or load balancer, and set
  `NETBOX_BIND=127.0.0.1` if the proxy is on the same machine. In `env/netbox.env` add
  `ALLOWED_HOSTS=netbox.example.com` and `CSRF_TRUSTED_ORIGINS=https://netbox.example.com`.
  Then run `./setup.sh` again.
- **Sign-in.** Use company SSO rather than local accounts: OIDC (Entra ID, Okta) or LDAP. The
  commented settings in netbox-docker's `env/netbox.env` show the variables. LDAP settings go in
  `extra.py` or the env file, per netbox-docker's LDAP guide. Login is already required by
  default in this image.
- **Permissions.** Map directory groups to NetBox groups: read-only for most people, edit rights
  for the network team. The dashboard keeps its own read-only `dashboard` user, as at home.
- **Getting data in.** For more than a few dozen devices, typing an inventory gets old. Import
  device types from the NetBox community device-type library, so port names match what switches
  report. Then pull devices and cables from the network itself: LLDP/CDP neighbours over SNMP,
  or NetBox Labs' discovery agent. The inventory importer still works for anything discovery
  can't see.
- **Governance.** NetBox becomes a record of internal network topology. Check where it may be
  hosted and who may see it, and keep backups under the company's retention rules. Set
  `CHANGELOG_RETENTION=365` (days) in `env/netbox.env` so edits stay auditable for a year.
- **Don't** run `npm run netbox:seed-demo` against it. It creates a fictional site.
