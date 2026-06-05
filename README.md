# PostgreSQL Logical Replication Manager

A web-based GUI for setting up, managing and monitoring **PostgreSQL logical replication** between a source (publisher) and destination (subscriber) instance — no command-line required.

![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-336791?logo=postgresql&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10--3.12-3776AB?logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What is PostgreSQL Logical Replication?

PostgreSQL logical replication streams row-level changes (INSERT, UPDATE, DELETE, TRUNCATE) from a **publisher** database to one or more **subscriber** databases in near real-time. Unlike physical (streaming) replication it is:

- **Selective** — replicate specific tables or entire schemas, not the whole cluster
- **Cross-version** — replicate between different PostgreSQL major versions (e.g. PG 14 → PG 16)
- **Non-exclusive** — subscribers can have their own data and indexes alongside replicated tables
- **Built-in** — no plugins required, available since PostgreSQL 10

Common use cases: live migrations, reporting replicas, data warehousing, zero-downtime upgrades, multi-region read replicas.

---

## Features

| Category | Capability |
|---|---|
| **Connection management** | Separate Admin DSN (superuser) and Replication DSN (replicator user); connection profiles saved on server |
| **Pre-flight checks** | Validates `wal_level = logical`, `REPLICATION` attribute, `LOGIN`, `SELECT` on all published tables, `CREATE` on destination DB, `pg_create_subscription` role (PG 16+), `max_replication_slots` / `max_wal_senders` headroom, pg_hba.conf replication channel |
| **Database analysis** | Schema/table tree with sizes, row estimates, `REPLICA IDENTITY` badges; search, expand all, select all |
| **Publication setup** | Create/update/drop publications for individual tables or entire schemas (PG 15+ schema-level publications) |
| **Subscription setup** | Create/update/drop subscriptions with `copy_data` toggle; verifies target tables exist on destination before applying |
| **Live monitoring** | Per-table sync progress (`pg_subscription_rel` states), replication slot lag, `pg_stat_subscription` worker health, `pg_stat_replication` write/flush/replay lag |
| **Conflict handling** | Detect disabled subscriptions, show replication origin LSN, skip conflicting transaction via `ALTER SUBSCRIPTION … SKIP` |
| **Workspace persistence** | Named workspaces (profiles) stored in Docker volume or local `data/` directory; remembers table selection, last used timestamp |
| **Reset replication** | Drop and recreate subscription + slot from scratch with one click and confirmation dialog |
| **Refresh publication** | `ALTER SUBSCRIPTION … REFRESH PUBLICATION` without full resync |
| **Stats interval** | Configurable auto-refresh interval for status page |

---

## Requirements

### Source (Publisher)
- PostgreSQL 10+ (schema-level publications require PG 15+)
- `wal_level = logical` in `postgresql.conf`
- An admin user able to `CREATE PUBLICATION`
- A replication user with `REPLICATION` attribute and `SELECT` on published tables
- `pg_hba.conf` entry: `host replication <repl_user> <subscriber_ip>/32 md5`

### Destination (Subscriber)
- PostgreSQL 10+
- An admin user with `CREATE` privilege on the target database (or `pg_create_subscription` role on PG 16+)
- Tables already created (schema is **not** replicated automatically — see [Schema sync](#schema-synchronization))

---

## Quick Start — Docker

```bash
git clone https://github.com/youruser/postgres-sync.git
cd postgres-sync
cp .env.example .env          # optional: pre-fill DSNs
docker compose up -d
```

Open **http://localhost:3000**

Data (connection config, workspace profiles) is stored in the `pg_sync_data` Docker volume and survives container restarts.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SOURCE_DSN` | _(empty)_ | Pre-fill source admin DSN (can also be set in the UI) |
| `DEST_DSN` | _(empty)_ | Pre-fill destination admin DSN |
| `CONFIG_PATH` | `/data/config.json` | Active connection config path inside the container |
| `PROFILES_PATH` | `/data/profiles.json` | Workspace profiles path inside the container |

---

## Quick Start — Local (no Docker)

### Linux / macOS

```bash
./start-linux.sh
```

Requires Python 3.10–3.12 and Node.js 18+. Creates `.venv` and installs all dependencies on first run. Opens the browser automatically.

```bash
# macOS — install correct Python version if needed:
brew install python@3.12
```

### Windows

Double-click **`start.bat`** or run from cmd:

```bat
start.bat
```

Requires Python 3.10–3.12 ([python.org](https://python.org), tick *Add to PATH*) and Node.js 18+ ([nodejs.org](https://nodejs.org)).

The script creates a `.venv`, installs pip and npm dependencies on first run, starts backend and frontend in separate windows, and opens the browser.

---

## Schema Synchronization

PostgreSQL logical replication does **not** replicate DDL (table definitions, indexes, sequences). Before starting replication you must create matching tables on the destination:

```bash
# Copy schema only (no data) from source to destination
pg_dump --schema-only -n public source_db | psql destination_db

# For specific schemas:
pg_dump --schema-only -n schema1 -n schema2 source_db | psql destination_db
```

The UI shows a reminder and the `pg_dump` command before the Apply step.

> **Sequences** (serial / identity columns) are not replicated. After failover, reset sequences manually or use `pg_dump --schema-only` to copy current values.

---

## Architecture

```
┌─────────────────────────────────────┐
│  Browser  (React 18 + Vite)         │
│  • Workspace picker                 │
│  • Schema / table tree              │
│  • Replication setup wizard         │
│  • Live status dashboard            │
└──────────────┬──────────────────────┘
               │ REST  /api/*
┌──────────────▼──────────────────────┐
│  Backend  (FastAPI + asyncpg)        │
│  • /api/connections  — connect/test  │
│  • /api/analysis     — schema sizes  │
│  • /api/replication  — pub/sub/slots │
│  • /api/profiles     — workspaces    │
└──────┬───────────────────┬──────────┘
       │ asyncpg           │ asyncpg
┌──────▼──────┐    ┌───────▼──────┐
│   Source DB  │    │  Destination │
│  (Publisher) │    │  (Subscriber)│
└─────────────┘    └──────────────┘
```

**Stack:** Python 3.12 · FastAPI · asyncpg · Pydantic v2 · React 18 · TypeScript · Vite · Tailwind CSS · TanStack Query · Docker / docker compose v2

---

## API Reference

Interactive docs available at **http://localhost:8000/docs** (Swagger UI) when running.

Key endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/connections/connect` | Connect to source + destination, run pre-flight checks |
| `GET` | `/api/analysis/schemas` | List schemas, tables, sizes, replica identity |
| `POST` | `/api/replication/publication` | Create or update publication |
| `POST` | `/api/replication/subscription` | Create or update subscription |
| `GET` | `/api/replication/progress` | Per-table sync status |
| `GET` | `/api/replication/worker-stats` | `pg_stat_subscription` — worker health |
| `GET` | `/api/replication/source-stats` | `pg_stat_replication` — lag details |
| `GET` | `/api/replication/conflicts` | Disabled subscriptions + replication origins |
| `POST` | `/api/replication/skip-lsn` | Skip conflicting LSN |
| `POST` | `/api/replication/reset/{name}` | Drop and recreate subscription from scratch |
| `GET` | `/api/profiles` | List saved workspace profiles |
| `POST` | `/api/profiles` | Save new workspace profile |

---

## Troubleshooting

### `wal_level` is not `logical`
```sql
-- postgresql.conf
wal_level = logical
-- then restart PostgreSQL
```

### Replication user lacks REPLICATION attribute
```sql
ALTER USER replicator REPLICATION;
```

### `pg_hba.conf` blocks replication channel
```
# /etc/postgresql/*/main/pg_hba.conf
host  replication  replicator  <subscriber_ip>/32  md5
# then: SELECT pg_reload_conf();
```

### Tables missing on destination
Run `pg_dump --schema-only` before creating the subscription (see [Schema sync](#schema-synchronization)).

### Slot lag growing / disk full on source
If the subscriber becomes unreachable, the replication slot retains WAL indefinitely. Drop the slot from the UI (Slots tab → Drop) or:
```sql
SELECT pg_drop_replication_slot('slot_name');
```

### Conflict stops replication
Find the LSN in the subscription worker logs, then use the UI (Status → Conflicts → Skip LSN) or:
```sql
ALTER SUBSCRIPTION my_sub SKIP (LSN '0/1234ABCD');
```

---

## Security Notes

- DSN passwords are stored in `data/config.json` and `data/profiles.json` on the server volume — protect volume access accordingly
- The API has no authentication layer; run behind a reverse proxy with access control when exposing beyond localhost
- Column lists in publications do not prevent a replication user from reading unpublished columns via other means

---

## License

MIT
