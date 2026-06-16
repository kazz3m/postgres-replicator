# PostgreSQL Logical Replication Manager

A web-based GUI for setting up, managing and monitoring **PostgreSQL logical replication** between a source (publisher) and destination (subscriber) instance — no command-line required.

![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-336791?logo=postgresql&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10--3.12-3776AB?logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

---

<!-- Screenshots: drag PNG files onto a new GitHub Issue to get hosted URLs, then replace the placeholders below -->
<!--
![Status Page](docs/screenshots/status.png)
![Schema Dump](docs/screenshots/schema_dump.png)
-->

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
| **Database analysis** | Three-level lazy tree (cluster → databases → schemas → tables) with sizes, row estimates, `REPLICA IDENTITY` badges; search, hide-empty-schemas toggle, per-schema publication badges showing table count (clickable → Setup tab) |
| **Publications panel** | Per-database collapsible panel listing all found publications with their tables; "Manage" button opens any publication in Setup tab |
| **Publication setup** | Create/update/drop publications for individual tables or entire schemas (PG 15+ schema-level publications); pub/sub names follow `{8chars}_{pub|sub}_{label}` pattern with 63-byte PG limit enforced |
| **Multi-publication workspace** | Independently manage multiple publications per workspace; saved configs keyed by pub name with quick-switch buttons |
| **Subscription setup** | Create/update/drop subscriptions with `copy_data` toggle; multi-database schema check (queries each DB separately); live step-by-step progress modal with **retry from failed step** (skips already-completed steps); `CREATE SUBSCRIPTION` timeout 120 s |
| **Schema synchronization** | Inline schema diff and auto-create missing tables on destination before applying replication; no manual `pg_dump` required; full support for **partitioned tables**; multi-database selections query each database independently |
| **Roles & grants migration** | `pg_dumpall --globals-only` compatible: generates and applies `CREATE ROLE`, `ALTER ROLE`, membership grants, schema grants, table grants and default privileges; Cloud SQL aware (strips `SUPERUSER`/`NOSUPERUSER`) |
| **Live monitoring** | Per-subscription rows in aligned columns: name, status badges, DB badge, copy progress (GB / GB · % · bar), WAL lag + bar, copy speed (10-sample rolling avg), ETA; header shows aggregate copied/total, overall ETA, active copy count; `pg_stat_replication.state` badge; internal sync worker slots hidden; table sizes via `pg_class.relpages` (lock-free) |
| **Table copy states** | Four states for `sub_state=d`: **copying** (blue, active `pg_stat_progress_copy`), **slot pending** (orange, `CREATE_REPLICATION_SLOT` blocked on source), **locked** (red, sync worker has ungranted lock on dest), **waiting** (yellow, queued for sync worker slot) |
| **Source capacity widget** | WAL senders, replication slots and `max_sync_workers_per_subscription` shown in header with colour-coded mini progress bars; click workers value to change it via `ALTER SYSTEM SET` (Cloud SQL: shows GCP Console instructions) |
| **Subscription diagnostics** | Debug modal: apply worker activity (`pg_stat_activity`), apply throughput (LSN delta), processes blocking apply worker on dest, long-running transactions (>30 s) across all databases, all logical replication workers |
| **Conflict handling** | Detect disabled subscriptions, show replication origin LSN, skip conflicting transaction via `ALTER SUBSCRIPTION … SKIP` |
| **Sequence sync** | Detect and synchronise sequence values between source and destination after replication completes |
| **Index sync** | Create missing indexes on destination that exist on source |
| **Workspace persistence** | Named workspaces (profiles) stored in Docker volume or local `data/` directory; remembers table selection, last used timestamp, all publication configs |
| **Subscription lifecycle** | Pause / Resume / Stop / Reset / Drop sub / Drop pub — all with per-database routing; **Truncate** button (`TRUNCATE` + `VACUUM FULL` on dest tables) available when slot is dropped |
| **Reset replication** | Drop and recreate subscription + slot from scratch with one click and confirmation dialog |
| **Refresh publication** | `ALTER SUBSCRIPTION … REFRESH PUBLICATION` without full resync |
| **REPLICA IDENTITY streaming** | Set `REPLICA IDENTITY FULL` on hundreds of tables via NDJSON stream — live progress bar, no HTTP timeout |
| **Stats interval** | Configurable auto-refresh interval for status page; copy-progress queries all destination databases in parallel |

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

- **Header** — aggregate copied / total bytes with progress bar; total copy speed (10-sample rolling avg); total ETA in `Xd Xh Xm` format; active copy count (`N tables copying`)
- **Source capacity pills** — WAL senders, replication slots and sync workers limit shown with colour-coded mini progress bars (green < 70 %, yellow 70–90 %, red ≥ 90 %); click sync workers pill to change `max_sync_workers_per_subscription` via `ALTER SYSTEM SET`
- **Per-subscription row** (table-aligned columns) — name, status badges (`active`/`inactive`, `streaming`/`catchup`), DB badge, tables synced counter, aggregate copy progress (`X GB / Y GB · Z%`), progress bar, per-subscription copy speed + ETA, WAL lag with mini bar, `N to analyze` button, debug button
- **Per-table detail** (expandable) — table state badge (`copying` / `slot pending` / `locked` / `waiting` / `synced` / `ready`), destination heap size, source heap size, rows copied, byte-level progress bar, last ANALYZE timestamp with one-click Analyze button
- Internal PostgreSQL worker slots (`pg_NNN_sync_NNN_…`) are automatically filtered out and not shown
- All status page queries that require per-database connections run **in parallel** for fast initial load

### Copy speed and ETA

Copy speed is computed client-side from the delta of destination heap bytes between consecutive polls. A **10-sample rolling average** is maintained per subscription to smooth out spikes from lock waits or network jitter. ETA is `remaining_bytes / avg_speed` and is shown both per subscription and as an aggregate total in the header. The estimate becomes reliable after ~3–4 poll intervals (30–40 s at the default 10 s interval).

Source table sizes are fetched **once per database** (not on every poll) to avoid blocking the UI. They use `pg_class.relpages * block_size` instead of `pg_relation_size()` — the latter acquires `AccessShareLock` and can block indefinitely when a long-running transaction holds a lock on the table. `relpages` is lock-free and updated by `VACUUM`/`ANALYZE`, so values may be slightly stale but are always available immediately. Destination table sizes use `pg_relation_size()` (polled each cycle) so that bytes written during the initial COPY snapshot are tracked accurately in real time.

### Table states

| State | `srsubstate` | Colour | Meaning |
|---|---|---|---|
| initializing | `i` | gray | Slot created, copy not started |
| copying | `d` | blue | Active COPY process visible in `pg_stat_progress_copy` |
| slot pending | `d` | orange | Sync worker wants to start but `CREATE_REPLICATION_SLOT` is blocked on source by another lock |
| locked | `d` | red | Sync worker running but blocked on an ungranted lock on destination |
| waiting | `d` | yellow | Slot assigned, no active COPY — queued behind `max_sync_workers_per_subscription` limit |
| catching up | `f` | yellow | COPY done, replaying WAL delta from copy window |
| synced | `s` | green | WAL caught up, pending confirmation round-trip |
| ready | `r` | green | Fully live — all changes replicated in real time |
| error | `e` | red | Sync error — check subscriber logs |

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

**Connections**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/connections/connect` | Connect to source + destination, run pre-flight checks |
| `GET` | `/api/connections/status` | Current connection state |

**Analysis**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/analysis/databases` | List databases with sizes and dest existence flag |
| `GET` | `/api/analysis/database-schema-list` | Lazy-load schemas for a database |
| `GET` | `/api/analysis/schema-tables` | Lazy-load tables for a schema |
| `GET` | `/api/analysis/published-tables` | Tables grouped by publication name |
| `POST` | `/api/analysis/ensure-database` | Create database on destination if missing |

**Publications & Subscriptions**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/replication/publication` | Create or update publication |
| `DELETE` | `/api/replication/publication/{name}` | Drop publication on source (`?database=`) |
| `GET` | `/api/replication/publications` | List all publications |
| `GET` | `/api/replication/publication-config` | Full pub config including subscriptions (`?name=&database=`) |
| `POST` | `/api/replication/publication/{pub}/add-table` | Add table to publication |
| `DELETE` | `/api/replication/publication/{pub}/table` | Remove table from publication |
| `POST` | `/api/replication/publication/{pub}/refresh-subscriptions` | `ALTER SUBSCRIPTION … REFRESH PUBLICATION` |
| `POST` | `/api/replication/subscription` | Create subscription |
| `DELETE` | `/api/replication/subscription/{name}` | Drop subscription + slot (`?database=`) |
| `GET` | `/api/replication/subscriptions` | List subscriptions |
| `POST` | `/api/replication/subscription/{name}/pause` | `ALTER SUBSCRIPTION DISABLE` (`?database=`) |
| `POST` | `/api/replication/subscription/{name}/resume` | `ALTER SUBSCRIPTION ENABLE` (`?database=`) |
| `POST` | `/api/replication/subscription/{name}/stop` | Disable + detach + drop slot (`?database=`) |
| `POST` | `/api/replication/subscription/{name}/set-workers` | Set `max_sync_workers_per_subscription` via `ALTER SYSTEM` (`?database=`) |
| `POST` | `/api/replication/subscription/{name}/vacuum-truncate` | `TRUNCATE` + `VACUUM FULL` all dest tables (`?database=`) |
| `GET` | `/api/replication/subscription/{name}/tables` | List tables tracked by subscription (`?database=`) |
| `POST` | `/api/replication/reset/{name}` | Drop and recreate subscription from scratch |

**Slots**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/replication/slots` | List replication slots on source |
| `DELETE` | `/api/replication/slot/{name}` | Drop replication slot on source |

**Monitoring & Diagnostics**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/replication/copy-progress` | Per-subscription copy progress with table states (parallel per-DB queries) |
| `GET` | `/api/replication/progress` | Per-table sync status (legacy) |
| `GET` | `/api/replication/capacity` | WAL senders, slots, sync workers utilisation from source |
| `GET` | `/api/replication/worker-stats` | `pg_stat_subscription` — apply/sync worker health |
| `GET` | `/api/replication/source-table-sizes` | Lock-free table sizes via `relpages * block_size` (`?database=`) |
| `GET` | `/api/replication/debug-table` | Per-table diagnostics: locks, copy progress, schema diff, blockers |
| `GET` | `/api/replication/debug-subscription` | Per-subscription diagnostics: apply worker, WAL lag, blockers, long-running tx |
| `GET` | `/api/replication/conflicts` | Replication conflicts from `pg_stat_subscription_stats` |
| `POST` | `/api/replication/skip-lsn` | `ALTER SUBSCRIPTION … SKIP (LSN '…')` |
| `POST` | `/api/replication/publication-readd-table` | Drop + re-add table to publication (forces fresh copy) |

**Schema**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/replication/schema-check` | Diff tables between source and destination (multi-DB aware) |
| `POST` | `/api/replication/schema-sync` | Create missing tables on destination |
| `POST` | `/api/replication/schema-drop-recreate` | Drop and recreate incompatible tables |
| `GET` | `/api/replication/schema-indexes` | List indexes for a publication |
| `POST` | `/api/replication/schema/create-indexes` | Create indexes on destination |
| `POST` | `/api/replication/schema-fix-not-null` | Add `NOT NULL` constraints (`strategy: not_valid\|direct`) |
| `POST` | `/api/replication/set-replica-identity-full` | `ALTER TABLE … REPLICA IDENTITY FULL` (batch) |
| `POST` | `/api/replication/set-replica-identity-full-stream` | Same, streaming NDJSON — no timeout for large sets |

**Sequences, Roles & Profiles**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/replication/sequences` | Sequence drift between source and destination |
| `POST` | `/api/replication/sequences/sync` | Align sequence values on destination |
| `GET` | `/api/roles/diff` | Generate role/grant DDL statements (pg_dumpall compatible) |
| `POST` | `/api/roles/apply` | Apply selected role/grant statements on destination |
| `GET` | `/api/profiles` | List saved workspace profiles |
| `POST` | `/api/profiles` | Save new workspace profile |
| `PATCH` | `/api/profiles/{id}` | Update workspace profile |

---

## Subscription Lifecycle

Each subscription in the **Subscriptions** table has the following actions:

| Action | When available | What it does |
|---|---|---|
| **Pause** | Slot active | `ALTER SUBSCRIPTION … DISABLE` — stops the apply worker, slot preserved, resume any time |
| **Resume** | Slot active, sub disabled | `ALTER SUBSCRIPTION … ENABLE` — restarts from last confirmed LSN |
| **Stop** | Sub enabled | Disable + `SET slot_name = NONE` + drop slot on source — graceful stop, data preserved |
| **Reset** | Any | Drop + recreate subscription and slot from scratch — full resync |
| **Drop sub** | Any | `DROP SUBSCRIPTION` on destination |
| **Drop pub** | Any | `DROP PUBLICATION` on source |
| **Truncate** | Slot dropped | `TRUNCATE` + `VACUUM FULL` all destination tables — removes all rows and reclaims disk space; use before re-syncing from source |

All actions that modify a subscription route to the correct destination database automatically, even in multi-database setups.

---

## Diagnosing Replication Lag

The **Debug Subscription** modal (click `debug` on any subscription row) provides:

| Section | What it shows |
|---|---|
| Replication slot (source) | WAL lag, active PID, confirmed flush LSN |
| `pg_stat_replication` | State (`streaming`/`catchup`), sent/write/flush/replay LSN, lag intervals |
| Apply worker activity | State, wait event (red if `Lock`), state age, current query |
| Apply throughput | MB/s computed from `latest_end_lsn` delta between refreshes |
| Apply worker blockers | Who holds locks preventing the apply worker from proceeding |
| Long-running transactions | All transactions >30 s on destination cluster (any database) — frequent cause of lag |
| All replication workers | Full `pg_stat_activity` for every logical replication worker |
| Error counts | `apply_error_count` / `sync_error_count` from `pg_stat_subscription_stats` |

### `out of memory` in WAL stream (`context "Tuples"`)

Apply worker crashes with `ERROR: out of memory DETAIL: Failed on request of size N in memory context "Tuples"` when a single WAL transaction is too large to decode in memory. Common with tables that have `REPLICA IDENTITY FULL` and no primary key.

**Fix 1 — increase `logical_decoding_work_mem` on source (no restart needed):**
```sql
ALTER SYSTEM SET logical_decoding_work_mem = '256MB';  -- default 64 MB
SELECT pg_reload_conf();
```

**Fix 2 — upgrade PostgreSQL source to 14.14+:**  
PG 14.14 contains a critical fix that reduces memory block size for tuple data in logical decoding, directly addressing OOM failures with large transactions.

**Fix 3 — remove `REPLICA IDENTITY FULL` from insert-only tables:**  
Tables that only receive `INSERT` don't need `FULL` — `DEFAULT` is sufficient and much smaller in WAL.

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
