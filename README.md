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
| **Database analysis** | Three-level lazy tree (cluster → databases → schemas → tables) with sizes, row estimates, `REPLICA IDENTITY` badges; search, expand-all, per-schema select-all |
| **Publication badges** | Tables already in a publication show a clickable badge; click opens that publication's config directly in Setup tab |
| **Publications panel** | Per-database collapsible panel listing all found publications with their tables; "Manage" button opens any publication in Setup tab |
| **Publication setup** | Create/update/drop publications for individual tables or entire schemas (PG 15+ schema-level publications); pub/sub names follow `{8chars}_{pub|sub}_{label}` pattern with 63-byte PG limit enforced |
| **Multi-publication workspace** | Independently manage multiple publications per workspace; saved configs keyed by pub name with quick-switch buttons |
| **Subscription setup** | Create/update/drop subscriptions with `copy_data` toggle; verifies target tables exist on destination before applying; live step-by-step progress modal; auto-cleans orphaned replication slot on retry |
| **Schema synchronization** | Inline schema diff and auto-create missing tables on destination before applying replication; no manual `pg_dump` required; full support for **partitioned tables** (detects `relkind='p'` parents and child partitions, correct DDL order, indexes propagated from parent) |
| **Roles & grants migration** | `pg_dumpall --globals-only` compatible: generates and applies `CREATE ROLE`, `ALTER ROLE`, membership grants, schema grants, table grants and default privileges; Cloud SQL aware (strips `SUPERUSER`/`NOSUPERUSER`) |
| **Live monitoring** | Per-subscription progress grouped by database; per-table states with human labels (`copying` / `catching up` / `synced` / `ready`); `pg_stat_replication.state` badge (streaming / catchup); aggregate copy progress bar (GB copied / total GB with %) per subscription; replication slot WAL lag; worker health via `pg_stat_subscription`; internal `pg_NNN_sync_NNN` worker slots automatically hidden; table sizes read from `pg_class.relpages` (no lock) — never blocks on long-running transactions |
| **Conflict handling** | Detect disabled subscriptions, show replication origin LSN, skip conflicting transaction via `ALTER SUBSCRIPTION … SKIP` |
| **Sequence sync** | Detect and synchronise sequence values between source and destination after replication completes |
| **Index sync** | Create missing indexes on destination that exist on source |
| **Workspace persistence** | Named workspaces (profiles) stored in Docker volume or local `data/` directory; remembers table selection, last used timestamp, all publication configs |
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
- PostgreSQL 10+ (including Cloud SQL for PostgreSQL)
- An admin user with `CREATE` privilege on the target database (or `pg_create_subscription` role on PG 16+)
- Tables created automatically by the built-in schema sync, or manually before starting replication

---

## Quick Start — Docker

```bash
git clone https://github.com/kazz3m/postgres-replicator.git
cd postgres-replicator
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

## Typical Workflow

1. **Connect** — enter source admin DSN, source replication DSN, and destination admin DSN
2. **Analyse** — browse the database tree; select tables or schemas to replicate
3. **Sync roles** _(optional)_ — open *Roles & Grants Migration* in the Status tab to migrate users and permissions to destination
4. **Setup replication** — choose a publication label, verify schema diff, create missing tables, then click *Apply Replication*
5. **Monitor** — watch per-table progress, slot lag and worker health in the Status tab
6. **Post-migration** — use *Sequence Sync* and *Index Sync* panels to finish the migration

---

## Schema Synchronization

The UI performs an inline schema diff before applying replication and can create missing tables on the destination automatically — no manual `pg_dump` required.

### Partitioned tables

Partitioned tables are fully supported:

- Parent tables (`relkind = 'p'`) are created first with the correct `PARTITION BY` clause
- Child partitions are detected (`relispartition = true`) and created with `CREATE TABLE … PARTITION OF … FOR VALUES …` — no column list needed
- Indexes are created on the **parent** before data sync (they propagate automatically to all child partitions)
- Tables are processed in the correct order: parents → plain tables → child partitions

### Mixed-case identifiers

Column names and table names with upper-case letters or special characters are quoted automatically in all generated DDL.

### Incompatible tables

When a table exists on destination with a different schema (e.g. wrong column type), a **Drop & recreate** button lets you drop the conflicting table and recreate it from source in one click — with a confirmation prompt.

For complex scenarios (views, triggers, custom types) use:

```bash
pg_dump --schema-only -n public source_db | psql destination_db
```

> **Sequences** (serial / identity columns) are not replicated. After migration use the *Sequence Sync* panel (Status tab) to align sequence values.

---

## Monitoring

The **Replication Progress** panel (Status tab) shows a live view refreshed every N seconds (configurable):

- **Per-subscription row** — subscription name, `active`/`inactive` slot state, `pg_stat_replication` state badge (green `streaming`, yellow `catchup`), destination database badge, tables synced counter, aggregate copy progress (`X GB / Y GB · Z%` with progress bar), WAL lag
- **Per-table detail** (expandable) — table state badge (`copying` / `catching up` / `synced` / `ready` / `error`), destination heap size, source heap size, rows copied, byte-level progress bar, last ANALYZE timestamp with one-click Analyze button
- Internal PostgreSQL worker slots (`pg_NNN_sync_NNN_…`) are automatically filtered out and not shown

Source table sizes are fetched **once per database** (not on every poll) to avoid blocking the UI. They use `pg_class.relpages * block_size` instead of `pg_relation_size()` — the latter acquires `AccessShareLock` and can block indefinitely when a long-running transaction holds a lock on the table. `relpages` is lock-free and updated by `VACUUM`/`ANALYZE`, so values may be slightly stale but are always available immediately. Destination table sizes use `pg_relation_size()` (polled each cycle) so that bytes written during the initial COPY snapshot are tracked accurately in real time.

### Table states

| State | Label | Meaning |
|---|---|---|
| `i` | initializing | Slot created, copy not started |
| `d` | copying | Active COPY in progress |
| `f` | catching up | COPY done, replaying WAL delta from copy window |
| `s` | synced | WAL caught up, pending confirmation round-trip |
| `r` | ready | Fully live — all changes replicated in real time |
| `e` | error | Sync error — check subscriber logs |

## Roles & Grants Migration

The **Roles & Grants Migration** panel (Status tab) generates `pg_dumpall --globals-only` compatible SQL and applies it on the destination:

- `CREATE ROLE` / `ALTER ROLE` for all non-system roles
- Role membership grants (`GRANT role TO member`)
- Per-database schema grants, table grants and `ALTER DEFAULT PRIVILEGES`
- Password hashes (when accessible — unavailable on Cloud SQL / RDS, commented out with a warning)
- **Cloud SQL aware** — `SUPERUSER` / `NOSUPERUSER` options are automatically stripped when the destination is detected as Cloud SQL

All statements are shown for review before applying. Individual statements can be deselected, and the full SQL can be copied to the clipboard.

---

## Publication & Subscription Naming

Names follow the pattern:

```
{8 random chars}_pub_{label}   e.g.  a3f9b2c1_pub_mydb_public
{8 random chars}_sub_{label}   e.g.  a3f9b2c1_sub_mydb_public
```

- Label is user-defined, sanitised to `[a-zA-Z0-9_]`, max **50 characters** (PostgreSQL `NAMEDATALEN = 63` minus 13 chars overhead)
- Live character counter with colour feedback (yellow > 80 %, red at limit)
- Legacy formats (`pg_sync_pub_label`) are recognised and round-trip correctly

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
│ Backend  (FastAPI + asyncpg)        │
│ • /api/connections  — connect/test  │
│ • /api/analysis     — schema/tables │
│ • /api/replication  — pub/sub/slots │
│ • /api/roles        — roles/grants  │
│ • /api/profiles     — workspaces    │
└──────┬───────────────────┬──────────┘
       │ asyncpg           │ asyncpg
┌──────▼──────┐    ┌───────▼───────┐
│ Source DB   │    │  Destination  │
│ (Publisher) │    │  (Subscriber) │
└─────────────┘    └───────────────┘
```

**Stack:** Python 3.12 · FastAPI · asyncpg · Pydantic v2 · React 18 · TypeScript · Vite · Tailwind CSS · TanStack Query · Docker / docker compose v2

---

## API Reference

Interactive docs available at **http://localhost:8000/docs** (Swagger UI) when running.

Key endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/connections/connect` | Connect to source + destination, run pre-flight checks |
| `GET` | `/api/analysis/databases` | List databases with sizes and dest existence flag |
| `GET` | `/api/analysis/database-schema-list` | Lazy-load schemas for a database |
| `GET` | `/api/analysis/schema-tables` | Lazy-load tables for a schema |
| `GET` | `/api/analysis/published-tables` | Tables grouped by publication name |
| `POST` | `/api/replication/publication` | Create or update publication |
| `POST` | `/api/replication/subscription` | Create or update subscription |
| `GET` | `/api/replication/publication-config` | Full publication config including subscriptions |
| `POST` | `/api/replication/schema-check` | Diff tables between source and destination |
| `POST` | `/api/replication/schema-sync` | Create missing tables on destination |
| `GET` | `/api/replication/progress` | Per-table sync status |
| `GET` | `/api/replication/worker-stats` | `pg_stat_subscription` — worker health |
| `GET` | `/api/replication/sequences` | Sequence drift between source and destination |
| `POST` | `/api/replication/sequences/sync` | Align sequence values on destination |
| `POST` | `/api/replication/reset/{name}` | Drop and recreate subscription from scratch |
| `GET` | `/api/roles/diff` | Generate role/grant DDL statements (pg_dumpall compatible) |
| `POST` | `/api/roles/apply` | Apply selected role/grant statements on destination |
| `GET` | `/api/profiles` | List saved workspace profiles |
| `POST` | `/api/profiles` | Save new workspace profile |
| `PATCH` | `/api/profiles/{id}` | Update workspace profile |

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
Use the built-in schema sync (Setup tab → schema diff panel) to create missing tables automatically before applying replication.

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

### Cloud SQL — roles migration fails with permission error
Cloud SQL does not expose `pg_authid.rolpassword`. Password statements are automatically commented out in the Roles & Grants panel. Apply the remaining statements and set passwords manually on destination.

### Status page shows `unknown` table status (Windows)
asyncpg on Windows returns single-character columns (like `srsubstate`) as `bytes` instead of `str`. The backend normalises these automatically — no action needed. If you see `unknown` after upgrading, restart the backend.

### Table sync progress shows `unknown` database
This can happen when no `pg_subscription` rows are visible (e.g. connecting to the wrong database). The backend queries each destination database independently to discover subscriptions — ensure the destination DSN points to the cluster default database (`postgres`), not a specific application database.

### Replication slot lag keeps growing after initial copy
Once initial copy is done, check that the subscription is enabled (`subenabled = true`) and the worker is running (`pg_stat_subscription`). If the slot shows `inactive` for more than a few minutes, use *Reset replication* to drop and recreate the subscription from scratch.

---

## Security Notes

- DSN passwords are stored encrypted in `data/config.json` and `data/profiles.json` on the server volume — protect volume access accordingly
- The API has no authentication layer; run behind a reverse proxy with access control when exposing beyond localhost
- Column lists in publications do not prevent a replication user from reading unpublished columns via other means

---

## License

MIT
