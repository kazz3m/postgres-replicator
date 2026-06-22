import asyncio
import re
from fastapi import APIRouter, HTTPException
from typing import List, Optional
from ..models.schemas import (
    PublicationConfig, SubscriptionConfig, ReplicationStatus,
    ReplicationSlotInfo, SubscriptionStatus, TableReplicationProgress,
    SequenceInfo, TableSchemaDiff, ColumnDiff, IndexDiff, SequenceDiff, TriggerDiff, ConstraintDiff, SchemaSyncResult,
    IndexInfo, IndexCreateResult, TableCopyProgress, CopyProgressResponse,
    SubscriptionProgress,
)
from ..db import get_source_pool, get_dest_pool, dsn_for_database
from .. import state

router = APIRouter(prefix="/api/replication", tags=["replication"])


def _require_connection():
    if not state.source_dsn or not state.dest_dsn:
        raise HTTPException(400, "Not connected. Call /api/connections/connect first.")


# ── Publications ──────────────────────────────────────────────────────────────

@router.post("/publication")
async def create_or_update_publication(config: PublicationConfig):
    _require_connection()
    import asyncpg as _asyncpg
    # Use a dedicated connection to the correct source database.
    # get_source_pool() caches by identity — passing a different DSN is ignored
    # if the pool already exists. Direct connect is the only safe option here.
    src_dsn = dsn_for_database(state.source_dsn, config.database) if config.database else state.source_dsn
    conn = await _asyncpg.connect(src_dsn, timeout=15)
    try:
        version_num = await conn.fetchval("SELECT current_setting('server_version_num')::int")
        major = version_num // 10000

        exists = await conn.fetchval(
            "SELECT 1 FROM pg_publication WHERE pubname = $1", config.publication_name
        )

        if config.target.schemas and major < 15:
            raise HTTPException(
                400,
                f"Schema-level publications require PostgreSQL 15+. Current: {major}."
            )

        if exists:
            await conn.execute(f'DROP PUBLICATION IF EXISTS "{config.publication_name}"')

        if config.target.schemas:
            valid = await conn.fetch(
                "SELECT quote_ident(nspname) AS safe_name "
                "FROM pg_namespace WHERE nspname = ANY($1)",
                list(config.target.schemas),
            )
            if len(valid) != len(set(config.target.schemas)):
                raise HTTPException(400, "One or more schemas do not exist on source.")
            schemas_sql = ", ".join(r["safe_name"] for r in valid)
            await conn.execute(
                f'CREATE PUBLICATION "{config.publication_name}" FOR TABLES IN SCHEMA {schemas_sql}'
            )
        elif config.target.tables:
            valid = await conn.fetch(
                "SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) AS safe_name "
                "FROM information_schema.tables "
                "WHERE table_schema||'.'||table_name = ANY($1)",
                list(config.target.tables),
            )
            if len(valid) != len(set(config.target.tables)):
                raise HTTPException(400, "One or more tables do not exist on source.")
            tables_sql = ", ".join(r["safe_name"] for r in valid)
            await conn.execute(
                f'CREATE PUBLICATION "{config.publication_name}" FOR TABLE {tables_sql}'
            )
        else:
            raise HTTPException(400, "Specify at least one schema or table.")
    finally:
        await conn.close()

    return {"status": "ok", "publication_name": config.publication_name, "updated": bool(exists)}


@router.delete("/publication/{name}")
async def drop_publication(name: str, database: str | None = None):
    _require_connection()
    import asyncpg as _asyncpg
    src_dsn = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    conn = await _asyncpg.connect(src_dsn, timeout=10)
    try:
        await conn.execute(f'DROP PUBLICATION IF EXISTS "{name}"')
    finally:
        await conn.close()
    return {"status": "dropped", "name": name}


@router.get("/publication-config")
async def get_publication_config(name: str, database: str | None = None):
    """
    Load full configuration for an existing publication: tables/schemas it covers,
    plus all linked subscriptions on destination. Used by UI to pre-fill Setup page.
    database: source database where the publication lives (required for non-default databases).
    """
    _require_connection()
    import asyncpg as _asyncpg

    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn

    src_conn  = await _asyncpg.connect(src_dsn,  timeout=15)
    dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)
    try:
        version_num = await src_conn.fetchval("SELECT current_setting('server_version_num')::int")
        major = version_num // 10000
        if not database:
            database = await src_conn.fetchval("SELECT current_database()")

        pub = await src_conn.fetchrow(
            "SELECT pubname, puballtables FROM pg_publication WHERE pubname = $1", name
        )
        if not pub:
            await src_conn.close(); await dest_conn.close()
            raise HTTPException(404, f"Publication '{name}' not found on source.")

        tables = await src_conn.fetch(
            "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1 ORDER BY schemaname, tablename",
            name,
        )

        schemas: list[str] = []
        if major >= 15:
            schema_rows = await src_conn.fetch("""
                SELECT pn.nspname
                FROM pg_publication_namespace ppn
                JOIN pg_namespace pn ON pn.oid = ppn.pnnspid
                JOIN pg_publication p ON p.oid = ppn.pnpubid
                WHERE p.pubname = $1
            """, name)
            schemas = [r["nspname"] for r in schema_rows]

        subs = []
        try:
            subs = await dest_conn.fetch(
                "SELECT subname, subenabled, subslotname "
                "FROM pg_subscription WHERE $1 = ANY(subpublications)",
                name,
            )
        except Exception:
            try:
                subs = await dest_conn.fetch(
                    "SELECT s.subname, true AS subenabled, NULL::text AS subslotname "
                    "FROM pg_stat_subscription s "
                    "WHERE s.subname IS NOT NULL "
                    "GROUP BY s.subname",
                )
            except Exception:
                subs = []

        result = {
            "pub_name": name,
            "database": database,
            "puballtables": pub["puballtables"],
            "tables": [f"{r['schemaname']}.{r['tablename']}" for r in tables],
            "schemas": schemas,
            "subscriptions": [
                {"sub_name": r["subname"], "enabled": r["subenabled"], "slot_name": r["subslotname"]}
                for r in subs
            ],
        }
    finally:
        await src_conn.close()
        await dest_conn.close()

    return result


@router.get("/unused-publications")
async def list_unused_publications():
    """
    Return publications on source that have no matching subscription on destination.
    Scans ALL non-template databases on the source cluster, not only the DSN default.
    """
    _require_connection()
    import asyncpg as _asyncpg

    # Collect used publication names from dest.
    # pg_subscription requires superuser on Cloud SQL — fall back to pg_stat_subscription.
    dest_conn = await _asyncpg.connect(state.dest_dsn, timeout=15)
    try:
        dest_sub_rows = await dest_conn.fetch("SELECT subpublications FROM pg_subscription")
        used_pubs: set[str] = set()
        for row in dest_sub_rows:
            for p in (row["subpublications"] or []):
                used_pubs.add(p)
    finally:
        await dest_conn.close()

    # Get list of all user databases on source
    src_conn = await _asyncpg.connect(state.source_dsn, timeout=15)
    try:
        version_num = await src_conn.fetchval("SELECT current_setting('server_version_num')::int")
        major = version_num // 10000
        db_rows = await src_conn.fetch(
            "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname"
        )
        databases = [r["datname"] for r in db_rows]
    finally:
        await src_conn.close()

    result = []
    for database in databases:
        db_dsn = dsn_for_database(state.source_dsn, database)
        try:
            db_conn = await _asyncpg.connect(db_dsn, timeout=10)
        except Exception:
            continue  # skip databases we can't connect to (e.g. no access)
        try:
            if major >= 15:
                pub_rows = await db_conn.fetch("""
                    SELECT p.pubname,
                           array_agg(DISTINCT pt.schemaname||'.'||pt.tablename)
                               FILTER (WHERE pt.tablename IS NOT NULL) AS tables,
                           array_agg(DISTINCT pn.nspname)
                               FILTER (WHERE pn.nspname IS NOT NULL) AS schemas
                    FROM pg_publication p
                    LEFT JOIN pg_publication_tables pt ON pt.pubname = p.pubname
                    LEFT JOIN pg_publication_namespace ppn ON ppn.pnpubid = p.oid
                    LEFT JOIN pg_namespace pn ON pn.oid = ppn.pnnspid
                    GROUP BY p.pubname
                """)
            else:
                pub_rows = await db_conn.fetch("""
                    SELECT p.pubname,
                           array_agg(DISTINCT pt.schemaname||'.'||pt.tablename)
                               FILTER (WHERE pt.tablename IS NOT NULL) AS tables,
                           NULL::text[] AS schemas
                    FROM pg_publication p
                    LEFT JOIN pg_publication_tables pt ON pt.pubname = p.pubname
                    GROUP BY p.pubname
                """)
        except Exception:
            pub_rows = []
        finally:
            await db_conn.close()

        for row in pub_rows:
            if row["pubname"] in used_pubs:
                continue
            tables = list(row["tables"] or [])
            schemas = list(row["schemas"] or [])
            result.append({
                "pub_name": row["pubname"],
                "database": database,
                "table_count": len(tables),
                "tables": sorted(tables),
                "schemas": sorted(schemas),
            })

    return result


@router.get("/publications")
async def list_publications():
    _require_connection()
    pool = await get_source_pool(state.source_dsn)
    async with pool.acquire() as conn:
        # pg_publication_namespace only exists in PG15+
        version_num = await conn.fetchval("SELECT current_setting('server_version_num')::int")
        major = version_num // 10000
        if major >= 15:
            rows = await conn.fetch("""
                SELECT p.pubname, p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete,
                       array_agg(DISTINCT pt.schemaname||'.'||pt.tablename) FILTER (WHERE pt.tablename IS NOT NULL) AS tables,
                       array_agg(DISTINCT pn.nspname) FILTER (WHERE pn.nspname IS NOT NULL) AS schemas
                FROM pg_publication p
                LEFT JOIN pg_publication_tables pt ON pt.pubname = p.pubname
                LEFT JOIN pg_publication_namespace ppn ON ppn.pnpubid = p.oid
                LEFT JOIN pg_namespace pn ON pn.oid = ppn.pnnspid
                GROUP BY p.pubname, p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete
            """)
        else:
            rows = await conn.fetch("""
                SELECT p.pubname, p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete,
                       array_agg(DISTINCT pt.schemaname||'.'||pt.tablename) FILTER (WHERE pt.tablename IS NOT NULL) AS tables,
                       NULL::text[] AS schemas
                FROM pg_publication p
                LEFT JOIN pg_publication_tables pt ON pt.pubname = p.pubname
                GROUP BY p.pubname, p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete
            """)
    return [dict(r) for r in rows]


# ── Subscriptions ─────────────────────────────────────────────────────────────

@router.post("/subscription")
async def create_or_update_subscription(config: SubscriptionConfig):
    _require_connection()

    if config.slot_name and not re.fullmatch(r"[a-z0-9_]{1,63}", config.slot_name):
        raise HTTPException(
            400,
            "Replication slot name must contain only lowercase letters, numbers, and underscores (max 63 characters)."
        )

    # Use dedicated replication DSN if provided, otherwise fall back to admin DSN.
    # If a specific database is requested, replace the database in the DSN so the
    # subscriber connects to the correct source database (not the DSN default).
    conn_dsn = state.source_repl_dsn if state.source_repl_dsn else config.source_dsn
    if config.database:
        conn_dsn = dsn_for_database(conn_dsn, config.database)


    # Validate DSN format and prevent dollar-quoting escape
    if not re.match(r'^postgres(ql)?://', conn_dsn):
        raise HTTPException(400, "Connection DSN must start with postgresql:// or postgres://")
    if "$conn_str$" in conn_dsn:
        raise HTTPException(400, "Connection DSN contains an illegal sequence.")

    import asyncpg as _asyncpg_sub
    src_dsn_db  = dsn_for_database(state.source_dsn, config.database) if config.database else state.source_dsn
    dest_dsn_db = dsn_for_database(state.dest_dsn,   config.database) if config.database else state.dest_dsn

    # Fix #1: hard-block when wal_level != logical on source
    src_pool = await get_source_pool(state.source_dsn)
    async with src_pool.acquire() as src_conn:
        wal_level = await src_conn.fetchval("SELECT current_setting('wal_level')")
        if wal_level != "logical":
            raise HTTPException(
                400,
                f"wal_level is '{wal_level}' on source. Must be 'logical'. "
                f"Set wal_level = logical in postgresql.conf and restart PostgreSQL."
            )

    # Check publication exists in the correct database on source
    src_db_conn = await _asyncpg_sub.connect(src_dsn_db, timeout=15)
    try:
        pub_tables = await src_db_conn.fetch(
            "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1",
            config.publication_name,
        )
    finally:
        await src_db_conn.close()

    if not pub_tables:
        raise HTTPException(
            400,
            f"Publication '{config.publication_name}' does not exist on source or contains no tables."
        )

    # Verify every published table exists on destination (correct database)
    dest_db_conn = await _asyncpg_sub.connect(dest_dsn_db, timeout=15)
    try:
        missing = []
        for row in pub_tables:
            exists_on_dest = await dest_db_conn.fetchval(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = $1 AND table_name = $2",
                row["schemaname"], row["tablename"],
            )
            if not exists_on_dest:
                missing.append(f"{row['schemaname']}.{row['tablename']}")

        if missing:
            raise HTTPException(
                400,
                f"Tables missing on destination (apply schema DDL first): {', '.join(missing)}"
            )

        existing_sub = await dest_db_conn.fetchrow(
            "SELECT subslotname FROM pg_subscription WHERE subname = $1", config.subscription_name
        )
        exists = bool(existing_sub)

        if config.slot_name:
            src_slot_conn = await _asyncpg_sub.connect(src_dsn_db, timeout=15)
            try:
                slot = await src_slot_conn.fetchrow(
                    """
                    SELECT slot_name, plugin, slot_type, active
                    FROM pg_replication_slots
                    WHERE slot_name = $1
                    """,
                    config.slot_name,
                )
            finally:
                await src_slot_conn.close()

            if not slot:
                raise HTTPException(
                    400,
                    f"Replication slot '{config.slot_name}' does not exist in the source database."
                )
            if slot["slot_type"] != "logical" or slot["plugin"] != "pgoutput":
                raise HTTPException(
                    400,
                    f"Replication slot '{config.slot_name}' must be a logical slot using the pgoutput plugin."
                )
            slot_belongs_to_existing_sub = (
                existing_sub and existing_sub["subslotname"] == config.slot_name
            )
            if slot["active"] and not slot_belongs_to_existing_sub:
                raise HTTPException(
                    400,
                    f"Replication slot '{config.slot_name}' is active and cannot be attached."
                )

        if existing_sub:
            await dest_db_conn.execute(
                f'ALTER SUBSCRIPTION "{config.subscription_name}" DISABLE'
            )
            if config.slot_name and existing_sub["subslotname"] == config.slot_name:
                await dest_db_conn.execute(
                    f'ALTER SUBSCRIPTION "{config.subscription_name}" SET (slot_name = NONE)'
                )
            await dest_db_conn.execute(
                f'DROP SUBSCRIPTION IF EXISTS "{config.subscription_name}"'
            )
    finally:
        await dest_db_conn.close()

    # CREATE SUBSCRIPTION uses a dedicated connection (not shared pool) with a
    # statement_timeout. The command makes destination PG connect back to source —
    # if unreachable it blocks for the full OS TCP timeout and poisons pool connections.
    import asyncpg as _asyncpg

    async def _drop_orphaned_slot(slot_name: str) -> None:
        """Drop a replication slot on source that was left behind by a failed CREATE SUBSCRIPTION."""
        src_pool = await get_source_pool(state.source_dsn)
        async with src_pool.acquire() as src_conn:
            exists = await src_conn.fetchval(
                "SELECT 1 FROM pg_replication_slots WHERE slot_name = $1", slot_name
            )
            if exists:
                await src_conn.execute("SELECT pg_drop_replication_slot($1)", slot_name)

    async def _get_pg_major(dsn: str) -> int:
        c = await _asyncpg.connect(dsn, timeout=10)
        try:
            v = await c.fetchval("SELECT current_setting('server_version_num')::int")
            return v // 10000
        finally:
            await c.close()

    src_major, dest_major = await asyncio.gather(
        _get_pg_major(src_dsn_db),
        _get_pg_major(dest_dsn_db),
    )
    use_streaming_parallel = src_major >= 15 and dest_major >= 15

    async def _do_create_subscription() -> None:
        dedicated_conn = None
        try:
            dedicated_conn = await _asyncpg.connect(dest_dsn_db, timeout=30)
            copy_data_sql = "true" if config.copy_data else "false"
            slot_sql = (
                f", create_slot = false, slot_name = '{config.slot_name}'"
                if config.slot_name else ""
            )
            streaming_sql = ", streaming = parallel" if use_streaming_parallel else ""
            await dedicated_conn.execute("SET statement_timeout = '120s'")
            await dedicated_conn.execute(f"""
                CREATE SUBSCRIPTION "{config.subscription_name}"
                CONNECTION $conn_str${conn_dsn}$conn_str$
                PUBLICATION "{config.publication_name}"
                WITH (copy_data = {copy_data_sql}{slot_sql}{streaming_sql})
            """)
        finally:
            if dedicated_conn:
                try:
                    await dedicated_conn.close()
                except Exception:
                    pass

    if config.truncate_dest and pub_tables:
        trunc_conn = await _asyncpg.connect(dest_dsn_db, timeout=30)
        try:
            tables_sql = ", ".join(
                f'"{r["schemaname"]}"."{r["tablename"]}"' for r in pub_tables
            )
            await trunc_conn.execute(f"TRUNCATE {tables_sql}")
        finally:
            await trunc_conn.close()

    try:
        await _do_create_subscription()
    except Exception as e:
        err = str(e)
        # Orphaned slot from a previous failed attempt — drop it and retry once
        if not config.slot_name and "replication slot" in err and "already exists" in err:
            try:
                await _drop_orphaned_slot(config.subscription_name)
                await _do_create_subscription()
                return {"status": "created", "subscription_name": config.subscription_name}
            except Exception as e2:
                err = str(e2)
        if "could not connect to the publisher" in err or "Connection timed out" in err or "Connection refused" in err or "statement timeout" in err:
            raise HTTPException(
                400,
                f"Destination PostgreSQL could not reach the source at "
                f"{conn_dsn.split('@')[-1] if '@' in conn_dsn else conn_dsn}. "
                f"Verify network connectivity and that the source allows connections from the destination host. "
                f"Detail: {err}"
            )
        if "password authentication failed" in err or "pg_hba.conf" in err:
            raise HTTPException(
                400,
                f"Replication DSN authentication failed. "
                f"Ensure the replication user has the REPLICATION attribute and "
                f"pg_hba.conf allows 'host replication <user> <dest_ip>/32' on source. "
                f"Detail: {err}"
            )
        raise HTTPException(400, f"CREATE SUBSCRIPTION failed: {err}")

    return {"status": "ok", "subscription_name": config.subscription_name, "updated": bool(exists)}


@router.delete("/subscription/{name}")
async def drop_subscription(
    name: str,
    database: str | None = None,
    preserve_slot: bool = False,
):
    _require_connection()
    import asyncpg as _asyncpg
    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn
    src_pool = await get_source_pool(state.source_dsn)

    conn = await _asyncpg.connect(dest_dsn, timeout=10)
    try:
        row = await conn.fetchrow(
            "SELECT subslotname, subenabled FROM pg_subscription WHERE subname = $1", name
        )
        if not row:
            raise HTTPException(404, f"Subscription '{name}' not found.")
        slot_name = row["subslotname"]

        if row["subenabled"]:
            try:
                await conn.execute(f'ALTER SUBSCRIPTION "{name}" DISABLE')
            except Exception as e:
                raise HTTPException(500,
                    f"Could not disable subscription '{name}' before dropping: {e}.")
        if preserve_slot and slot_name:
            await conn.execute(f'ALTER SUBSCRIPTION "{name}" SET (slot_name = NONE)')
        await conn.execute(f'DROP SUBSCRIPTION IF EXISTS "{name}"')
    finally:
        await conn.close()

    # Drop orphaned slot on source if DROP SUBSCRIPTION didn't clean it up
    if slot_name and not preserve_slot:
        async with src_pool.acquire() as conn:
            still_exists = await conn.fetchval(
                "SELECT 1 FROM pg_replication_slots WHERE slot_name = $1", slot_name
            )
            if still_exists:
                try:
                    await conn.execute("SELECT pg_drop_replication_slot($1)", slot_name)
                except Exception:
                    pass

    return {
        "status": "dropped",
        "name": name,
        "slot_name": slot_name,
        "slot_preserved": bool(slot_name and preserve_slot),
    }


@router.get("/subscriptions")
async def list_subscriptions():
    """
    List all subscriptions with their source database derived from subconninfo.
    pg_subscription is a shared catalog — query it once, extract dbname from the
    connection string stored in subconninfo.
    """
    _require_connection()
    import asyncpg as _asyncpg
    import re as _re

    conn = await _asyncpg.connect(state.dest_dsn, timeout=15)
    try:
        await conn.execute("SET statement_timeout = '10s'")
        max_sync_workers = await conn.fetchval(
            "SELECT current_setting('max_sync_workers_per_subscription')::int"
        )
        # subconninfo is blocked on Cloud SQL — read only the safe columns.
        # Database is derived from pg_replication_slots on source (slot fallback below).
        rows = await conn.fetch("""
            SELECT subname, subenabled, subpublications, subslotname,
                   NULL::text AS subconninfo
            FROM pg_subscription
        """)
    finally:
        await conn.close()

    def _extract_dbname(conninfo: str | None) -> str | None:
        """Extract dbname= value from a libpq conninfo string."""
        if not conninfo:
            return None
        m = _re.search(r'\bdbname=(\S+)', conninfo)
        if m:
            return m.group(1)
        m = _re.search(r'^postgres(?:ql)?://[^/]+/([^?]+)', conninfo)
        if m:
            return m.group(1) or None
        return None

    # Build slot → source database map as fallback for Cloud SQL where subconninfo is NULL
    slot_to_db: dict[str, str] = {}
    try:
        src_conn = await _asyncpg.connect(state.source_dsn, timeout=10)
        try:
            slot_rows = await src_conn.fetch(
                "SELECT slot_name, database FROM pg_replication_slots WHERE slot_type = 'logical'"
            )
            for sr in slot_rows:
                slot_to_db[sr["slot_name"]] = sr["database"]
        finally:
            await src_conn.close()
    except Exception:
        pass

    result = []
    for r in rows:
        entry = dict(r)
        db = _extract_dbname(r["subconninfo"])
        if not db and r["subslotname"]:
            db = slot_to_db.get(r["subslotname"])
        entry["database"] = db
        entry.pop("subconninfo", None)
        entry["max_sync_workers"] = max_sync_workers
        result.append(entry)

    return result


@router.post("/subscription/{name}/refresh")
async def refresh_subscription(name: str):
    """ALTER SUBSCRIPTION name REFRESH PUBLICATION"""
    _require_connection()
    pool = await get_dest_pool(state.dest_dsn)
    async with pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_subscription WHERE subname = $1", name
        )
        if not exists:
            raise HTTPException(404, f"Subscription '{name}' not found.")
        await conn.execute(f'ALTER SUBSCRIPTION "{name}" REFRESH PUBLICATION')
    return {"status": "refreshed", "subscription_name": name}


# ── Slots ─────────────────────────────────────────────────────────────────────

@router.get("/slots", response_model=List[ReplicationSlotInfo])
async def list_slots(database: str | None = None):
    _require_connection()
    import asyncpg as _asyncpg
    src_dsn = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    conn = await _asyncpg.connect(src_dsn, timeout=10)
    try:
        # pg_replication_slots is a cluster-wide view visible from any database.
        # Filter by database only when a specific database was requested.
        db_filter = "WHERE database = current_database()" if database else ""
        rows = await conn.fetch(f"""
            SELECT slot_name, plugin, slot_type, active,
                   restart_lsn::text, confirmed_flush_lsn::text,
                   COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0) AS lag_bytes
            FROM pg_replication_slots
            {db_filter}
            ORDER BY slot_name
        """)
    finally:
        await conn.close()
    return [ReplicationSlotInfo(
        slot_name=r["slot_name"],
        plugin=r["plugin"] or "",
        slot_type=r["slot_type"],
        active=r["active"],
        restart_lsn=r["restart_lsn"],
        confirmed_flush_lsn=r["confirmed_flush_lsn"],
        lag_bytes=r["lag_bytes"],
    ) for r in rows]


@router.delete("/slot/{name}")
async def drop_slot(name: str):
    _require_connection()
    pool = await get_source_pool(state.source_dsn)
    async with pool.acquire() as conn:
        await conn.execute("SELECT pg_drop_replication_slot($1)", name)
    return {"status": "dropped", "name": name}


@router.get("/subscription/{name}/dead-sync-slots")
async def get_dead_sync_slots(name: str, database: str | None = None):
    """
    Return inactive sync replication slots on source for a given subscription.
    These are pg_NNN_sync_NNN slots left behind by crashed sync workers.
    Also returns the corresponding table OIDs so frontend can show which tables
    need cleanup on destination.
    """
    _require_connection()
    import asyncpg as _asyncpg
    src_dsn = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    src_conn = await _asyncpg.connect(src_dsn, timeout=15)
    try:
        # Subscription OID — sync slots are named pg_{suboid}_sync_{reloid}_{...}
        sub_oid = await src_conn.fetchval(
            "SELECT oid FROM pg_subscription WHERE subname = $1", name
        )
        if sub_oid is None:
            # Try on dest (subscription lives on dest)
            await src_conn.close()
            dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn
            dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)
            try:
                sub_oid = await dest_conn.fetchval(
                    "SELECT oid FROM pg_subscription WHERE subname = $1", name
                )
            finally:
                await dest_conn.close()
            src_conn = await _asyncpg.connect(src_dsn, timeout=15)

        prefix = f"pg_{sub_oid}_sync_" if sub_oid else None

        rows = await src_conn.fetch("""
            SELECT slot_name,
                   active,
                   active_pid,
                   restart_lsn::text,
                   pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_pretty,
                   pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes
            FROM pg_replication_slots
            WHERE slot_name LIKE $1
              AND active = false
            ORDER BY lag_bytes DESC NULLS LAST
        """, f"{prefix}%" if prefix else "pg_%_sync_%")

        slots = []
        for r in rows:
            # Extract table OID from slot name: pg_{suboid}_sync_{reloid}_{...}
            parts = r["slot_name"].split("_")
            rel_oid = None
            if len(parts) >= 4:
                try:
                    rel_oid = int(parts[3])
                except ValueError:
                    pass
            slots.append({
                "slot_name": r["slot_name"],
                "active": r["active"],
                "restart_lsn": r["restart_lsn"],
                "lag_pretty": r["lag_pretty"],
                "lag_bytes": r["lag_bytes"],
                "rel_oid": rel_oid,
            })
    finally:
        await src_conn.close()

    return {"slots": slots, "sub_oid": sub_oid}


@router.post("/subscription/{name}/drop-dead-sync-slots")
async def drop_dead_sync_slots(name: str, body: dict):
    """
    Drop specified inactive sync slots on source, optionally TRUNCATE the
    corresponding tables on destination so they get re-synced cleanly.
    body: { "slot_names": [...], "truncate_tables": true/false,
            "rel_oids": [123, 456], "database": "dbname" }
    """
    _require_connection()
    import asyncpg as _asyncpg
    slot_names: list[str] = body.get("slot_names", [])
    truncate_tables: bool = body.get("truncate_tables", False)
    rel_oids: list[int] = body.get("rel_oids", [])
    database: str | None = body.get("database")

    if not slot_names:
        raise HTTPException(400, "slot_names required")

    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn
    src_conn = await _asyncpg.connect(src_dsn, timeout=15)
    results = []

    try:
        for slot in slot_names:
            try:
                await src_conn.execute("SELECT pg_drop_replication_slot($1)", slot)
                results.append({"slot": slot, "ok": True, "action": "dropped"})
            except Exception as e:
                results.append({"slot": slot, "ok": False, "error": str(e).split("\n")[0]})
    finally:
        await src_conn.close()

    truncate_results = []
    if truncate_tables and rel_oids:
        dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)
        try:
            for oid in rel_oids:
                try:
                    # Resolve OID → schema.table on destination
                    row = await dest_conn.fetchrow(
                        "SELECT n.nspname, c.relname FROM pg_class c "
                        "JOIN pg_namespace n ON n.oid = c.relnamespace "
                        "WHERE c.oid = $1", oid
                    )
                    if row:
                        qualified = f'"{row["nspname"]}"."{row["relname"]}"'
                        await dest_conn.execute(f"TRUNCATE {qualified}")
                        truncate_results.append({"oid": oid, "table": f"{row['nspname']}.{row['relname']}", "ok": True})
                    else:
                        truncate_results.append({"oid": oid, "table": None, "ok": False, "error": "Table not found on dest"})
                except Exception as e:
                    truncate_results.append({"oid": oid, "ok": False, "error": str(e).split("\n")[0]})
        finally:
            await dest_conn.close()

    return {"dropped": results, "truncated": truncate_results}


# ── Progress ──────────────────────────────────────────────────────────────────

@router.get("/progress", response_model=List[TableReplicationProgress])
async def replication_progress():
    _require_connection()
    pool = await get_dest_pool(state.dest_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT
                n.nspname AS schema_name,
                c.relname AS table_name,
                CASE sr.srsubstate
                    WHEN 'i' THEN 'initializing'
                    WHEN 'd' THEN 'copying'
                    WHEN 'f' THEN 'synced'
                    WHEN 's' THEN 'synced'
                    WHEN 'r' THEN 'ready'
                    WHEN 'e' THEN 'error'
                    ELSE 'unknown'
                END AS status,
                COALESCE(c.reltuples::bigint, 0) AS total_rows
            FROM pg_subscription_rel sr
            JOIN pg_class c ON c.oid = sr.srrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            ORDER BY n.nspname, c.relname
        """)
    return [TableReplicationProgress(
        schema_name=r["schema_name"],
        table_name=r["table_name"],
        status=r["status"],
        copied_rows=None,
        total_rows=max(0, r["total_rows"]),
        progress_pct=100.0 if r["status"] in ("synced", "ready") else None,
    ) for r in rows]


# ── Copy + WAL progress ───────────────────────────────────────────────────────

@router.get("/copy-progress", response_model=CopyProgressResponse)
async def copy_progress():
    """
    Per-subscription progress: tables grouped by subscription with database info.
    Filters out internal pg_sync_* worker slots.
    """
    _require_connection()
    import asyncpg as _asyncpg

    dest_pool = await get_dest_pool(state.dest_dsn)
    src_pool  = await get_source_pool(state.source_dsn)

    import asyncpg as _asyncpg

    import re as _re
    _sync_worker_slot = _re.compile(r'^pg_\d+_sync_\d+')

    # WAL lag + active state per logical slot from source.
    # Exclude internal table-sync worker slots (pg_<pid>_sync_<reloid>).
    async with src_pool.acquire() as src_conn:
        slot_rows = await src_conn.fetch("""
            SELECT slot_name, active,
                   COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0) AS lag_bytes
            FROM pg_replication_slots
            WHERE slot_type = 'logical'
            ORDER BY slot_name
        """)
        # pg_stat_replication: state per application_name (= slot_name for logical subs)
        repl_rows = await src_conn.fetch("""
            SELECT application_name, state
            FROM pg_stat_replication
        """)
        # Detect which table OIDs have their CREATE_REPLICATION_SLOT blocked on source.
        # Sync worker slot names: pg_<suboid>_sync_<reloid>_<random>
        # Blocked = walsender PID waiting for a lock (ungranted in pg_locks).
        try:
            blocked_slot_rows = await src_conn.fetch("""
                SELECT a.query
                FROM pg_stat_activity a
                JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
                WHERE a.query ILIKE '%CREATE_REPLICATION_SLOT%'
                   OR a.query ILIKE '%create replication slot%'
            """)
            # Extract reloid from slot name pattern pg_NNN_sync_RELOID_NNN
            import re as _re2
            _slot_re = _re2.compile(r'pg_\d+_sync_(\d+)_\d+')
            blocked_table_oids: set[int] = set()
            for row in blocked_slot_rows:
                q = row["query"] or ""
                m = _slot_re.search(q)
                if m:
                    blocked_table_oids.add(int(m.group(1)))
        except Exception:
            blocked_table_oids = set()
    repl_state_map = {r["application_name"]: r["state"] for r in repl_rows}

    # Only keep real subscription slots (exclude worker sync slots)
    slot_map = {
        r["slot_name"]: r for r in slot_rows
        if not _sync_worker_slot.match(r["slot_name"])
    }

    import asyncio as _asyncio

    # Fetch all dest databases once
    dest_pool_default = await get_dest_pool(state.dest_dsn)
    async with dest_pool_default.acquire() as _dc:
        dest_db_names = [r["datname"] for r in await _dc.fetch("""
            SELECT datname FROM pg_database
            WHERE datistemplate = false AND datname NOT IN ('postgres', 'template0', 'template1', 'cloudsqladmin')
            ORDER BY datname
        """)]

    # Query sync workers + main progress from ALL databases IN PARALLEL
    async def _query_db(db_name: str):
        db_dsn = dsn_for_database(state.dest_dsn, db_name)
        try:
            db_conn = await _asyncpg.connect(db_dsn, timeout=10)
        except Exception:
            return db_name, [], []
        try:
            sync_rows = await db_conn.fetch("""
                SELECT subname, COUNT(*) AS sync_count
                FROM pg_stat_subscription
                WHERE relid IS NOT NULL AND pid IS NOT NULL
                GROUP BY subname
            """)
            main_rows = await db_conn.fetch(MAIN_QUERY)
            return db_name, list(sync_rows), list(main_rows)
        except Exception:
            return db_name, [], []
        finally:
            await db_conn.close()

    sync_worker_counts: dict[str, int] = {}

    state_label = {'i':'initializing','d':'copying','f':'catching up','s':'synced','r':'ready','e':'error'}
    state_label_waiting      = {**state_label, 'd': 'waiting'}
    state_label_locked       = {**state_label, 'd': 'locked'}
    state_label_slot_pending = {**state_label, 'd': 'slot pending'}

    def _decode_state(v) -> str:
        """Normalize srsubstate — asyncpg may return bytes on Windows."""
        if isinstance(v, (bytes, bytearray)):
            return v.decode()
        return v or ""

    # Per-database query: subscription + tables + copy progress in one shot.
    # pg_subscription JOIN is preferred; Cloud SQL fallback uses pg_stat_subscription.
    # Main query — pg_subscription without subconninfo (accessible on Cloud SQL),
    # current_database() gives us the correct database name since we connect per-DB.
    MAIN_QUERY = """
        SELECT
            s.subname,
            s.subenabled,
            COALESCE(s.subslotname, s.subname) AS slot_name,
            current_database() AS database,
            n.nspname  AS schema_name,
            c.relname  AS table_name,
            c.oid      AS table_oid,
            sr.srsubstate AS sub_state,
            COALESCE(cp.tuples_processed, 0)             AS tuples_done,
            COALESCE(NULLIF(c.reltuples::bigint, -1), 0) AS tuples_total,
            COALESCE(cp.bytes_processed, 0)              AS bytes_processed,
            CASE
                WHEN cp.pid IS NOT NULL AND cp.bytes_processed > 0
                THEN cp.bytes_processed
                ELSE (c.relpages::bigint + COALESCE(ct.relpages, 0)::bigint)
                         * current_setting('block_size')::bigint
            END                                          AS table_size_bytes,
            GREATEST(psu.last_analyze, psu.last_autoanalyze) AS last_analyze,
            (cp.pid IS NOT NULL)                         AS copy_active,
            sw.pid                                       AS sync_worker_pid,
            -- sync worker has an ungranted lock = blocked waiting for table lock
            EXISTS(
                SELECT 1 FROM pg_locks l
                WHERE l.pid = sw.pid AND NOT l.granted
            )                                            AS sync_worker_blocked
        FROM pg_subscription_rel sr
        JOIN pg_subscription s   ON s.oid  = sr.srsubid
        JOIN pg_class       c    ON c.oid  = sr.srrelid
        JOIN pg_namespace   n    ON n.oid  = c.relnamespace
        LEFT JOIN pg_class               ct  ON ct.oid   = c.reltoastrelid
        LEFT JOIN pg_stat_progress_copy cp  ON cp.relid  = c.oid
        LEFT JOIN pg_stat_user_tables   psu ON psu.relid = c.oid
        LEFT JOIN pg_stat_subscription  sw  ON sw.subid  = s.oid
                                            AND sw.relid  = c.oid
                                            AND sw.pid IS NOT NULL
        ORDER BY s.subname, n.nspname, c.relname
    """

    # Run all DB queries in parallel
    db_results = await _asyncio.gather(*[_query_db(db) for db in dest_db_names])

    # Collect sync worker counts
    for _db_name, sync_rows, _main_rows in db_results:
        for sr in sync_rows:
            n = sr["subname"]
            sync_worker_counts[n] = sync_worker_counts.get(n, 0) + int(sr["sync_count"])

    # Group rows by sub_name -> SubscriptionProgress
    subs_by_name: dict[str, SubscriptionProgress] = {}
    global_copying = False

    for _db_name, _sync_rows, rows in db_results:
        for r in rows:
            sub_name = r["subname"]
            slot_name = r["slot_name"] or sub_name
            slot_info = slot_map.get(slot_name)

            if sub_name not in subs_by_name:
                subs_by_name[sub_name] = SubscriptionProgress(
                    sub_name=sub_name,
                    slot_name=slot_name,
                    database=r["database"],
                    lag_bytes=slot_info["lag_bytes"] if slot_info else 0,
                    slot_active=slot_info["active"] if slot_info else False,
                    enabled=bool(r["subenabled"]),
                    sync_workers=sync_worker_counts.get(slot_name, 0),
                    repl_state=repl_state_map.get(slot_name),
                    tables=[],
                    copying_active=False,
                )

            sub_state = _decode_state(r["sub_state"])
            copy_active = bool(r["copy_active"]) if sub_state == 'd' else False
            sync_blocked = bool(r["sync_worker_blocked"]) if sub_state == 'd' and not copy_active else False
            tuples_done, tuples_total = r["tuples_done"], r["tuples_total"]
            copy_pct: Optional[float] = None
            if sub_state == 'd' and copy_active and tuples_done > 0 and tuples_total > 0:
                copy_pct = min(100.0, tuples_done / tuples_total * 100)
            elif sub_state in ('f', 's', 'r'):
                copy_pct = 100.0
            if sub_state == 'd' and copy_active:
                subs_by_name[sub_name].copying_active = True
                global_copying = True
            # 'd' status priority: copying > slot_pending > locked > waiting
            table_oid = r["table_oid"]
            if copy_active:
                label_map = state_label
            elif table_oid and int(table_oid) in blocked_table_oids:
                label_map = state_label_slot_pending
            elif sync_blocked:
                label_map = state_label_locked
            else:
                label_map = state_label_waiting
            last_analyze = r["last_analyze"]
            subs_by_name[sub_name].tables.append(TableCopyProgress(
                schema_name=r["schema_name"], table_name=r["table_name"],
                table_oid=r["table_oid"],
                row_estimate=tuples_total if tuples_total and tuples_total > 0 else None,
                sub_state=sub_state, status=label_map.get(sub_state, 'unknown'),
                tuples_done=tuples_done if sub_state == 'd' and copy_active else None,
                tuples_total=tuples_total if sub_state == 'd' and copy_active else None,
                bytes_processed=r["bytes_processed"] if sub_state == 'd' and copy_active else None,
                table_size_bytes=r["table_size_bytes"],
                source_size_bytes=None,  # filled in below
                copy_pct=copy_pct,
                last_analyze=last_analyze.isoformat() if last_analyze else None,
            ))

    # Also add subscriptions that have no tables yet (newly created)
    for slot_name, slot_info in slot_map.items():
        # Match slot to subscription name (our convention: slot_name == sub_name)
        if slot_name not in subs_by_name:
            subs_by_name[slot_name] = SubscriptionProgress(
                sub_name=slot_name,
                slot_name=slot_name,
                database=None,
                lag_bytes=slot_info["lag_bytes"],
                slot_active=slot_info["active"],
                enabled=slot_info["active"],  # best guess when no subscription row
                sync_workers=sync_worker_counts.get(slot_name, 0),
                repl_state=repl_state_map.get(slot_name),
                tables=[],
                copying_active=False,
            )

    subscriptions = sorted(subs_by_name.values(), key=lambda s: s.sub_name)

    return CopyProgressResponse(subscriptions=subscriptions, copying_active=global_copying)


# ── Debug subscription ────────────────────────────────────────────────────────

@router.get("/debug-subscription")
async def debug_subscription(sub_name: str, database: str):
    """
    Diagnostic info for a subscription (apply worker health, WAL lag, conflicts).
    Queries both source and destination.
    """
    _require_connection()
    import asyncpg as _asyncpg

    result: dict = {}

    # ── Destination side ──────────────────────────────────────────────────────
    # Use the subscription's database for pg_subscription / pg_stat_subscription queries.
    # Use the default dest DSN for cluster-wide views (pg_stat_activity, pg_locks) —
    # these are visible from any database so no need to switch.
    dest_dsn = dsn_for_database(state.dest_dsn, database)
    dest_dsn_default = state.dest_dsn  # cluster-wide queries
    try:
        dc = await _asyncpg.connect(dest_dsn, timeout=10)
    except Exception as e:
        result["dest_error"] = str(e)
        dc = None

    if dc:
        # pg_stat_subscription — apply worker + sync workers
        try:
            sub_stat_rows = await dc.fetch("""
                SELECT pid, relid::regclass::text AS rel_name,
                       received_lsn::text, last_msg_send_time::text,
                       last_msg_receipt_time::text,
                       latest_end_lsn::text, latest_end_time::text
                FROM pg_stat_subscription
                WHERE subname = $1
                ORDER BY relid NULLS FIRST
            """, sub_name)
            result["stat_subscription"] = [dict(r) for r in sub_stat_rows]
        except Exception as e:
            result["stat_subscription_error"] = str(e)

        # pg_subscription — enabled state, publications, slot name
        try:
            sub_row = await dc.fetchrow("""
                SELECT subname, subenabled, subslotname, subpublications
                FROM pg_subscription
                WHERE subname = $1
            """, sub_name)
            result["subscription"] = dict(sub_row) if sub_row else None
        except Exception as e:
            result["subscription_error"] = str(e)

        # pg_replication_origin_status — last applied LSN
        # Cloud SQL does not grant access to this view — skip silently
        try:
            is_cloud_sql = await dc.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = 'cloudsqladmin'"
            )
            if is_cloud_sql:
                result["replication_origin"] = []
            else:
                origin_rows = await dc.fetch("""
                    SELECT external_id, remote_lsn::text, local_lsn::text
                    FROM pg_replication_origin_status
                """)
                result["replication_origin"] = [dict(r) for r in origin_rows]
        except Exception as e:
            result["replication_origin_error"] = str(e)

        # pg_stat_subscription_stats — error counts (PG 15+)
        try:
            stats_row = await dc.fetchrow("""
                SELECT apply_error_count, sync_error_count
                FROM pg_stat_subscription_stats
                WHERE subname = $1
            """, sub_name)
            result["error_counts"] = dict(stats_row) if stats_row else None
        except Exception:
            result["error_counts"] = None

        await dc.close()

    # ── Destination cluster-wide queries (pg_stat_activity, pg_locks) ──────────
    # These views are cluster-wide — connect via default DSN, not per-database.
    apply_pids = [r["pid"] for r in result.get("stat_subscription", []) if r.get("pid") and not r.get("rel_name")]
    try:
        dc2 = await _asyncpg.connect(dest_dsn_default, timeout=10)
    except Exception as e:
        result["dest_cluster_error"] = str(e)
        dc2 = None

    if dc2:
        # pg_stat_activity for apply worker
        try:
            if apply_pids:
                activity_rows = await dc2.fetch("""
                    SELECT pid, state, wait_event_type, wait_event,
                           LEFT(query, 200) AS query,
                           EXTRACT(EPOCH FROM (now() - state_change))::int AS state_age_s,
                           EXTRACT(EPOCH FROM (now() - query_start))::int AS query_age_s,
                           backend_type
                    FROM pg_stat_activity
                    WHERE pid = ANY($1::int[])
                """, apply_pids)
                result["apply_worker_activity"] = [dict(r) for r in activity_rows]
            else:
                result["apply_worker_activity"] = []
        except Exception as e:
            result["apply_worker_activity_error"] = str(e)

        # locks held by apply worker
        try:
            if apply_pids:
                lock_rows = await dc2.fetch("""
                    SELECT l.pid, l.mode, l.granted, l.locktype,
                           l.relation::regclass::text AS rel_name,
                           a.state, a.wait_event_type, a.wait_event,
                           LEFT(a.query, 120) AS query,
                           EXTRACT(EPOCH FROM (now() - a.query_start))::int AS query_age_s
                    FROM pg_locks l
                    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
                    WHERE l.pid = ANY($1::int[])
                    ORDER BY l.granted, query_age_s DESC NULLS LAST
                """, apply_pids)
                result["apply_worker_locks"] = [dict(r) for r in lock_rows]
            else:
                result["apply_worker_locks"] = []
        except Exception as e:
            result["apply_worker_locks_error"] = str(e)

        # processes blocking apply worker on dest
        try:
            if apply_pids:
                blocker_rows = await dc2.fetch("""
                    WITH blockers AS (
                        SELECT DISTINCT ON (blocked.pid, blocker.pid)
                               blocked.pid AS wait_pid,
                               blocker.pid AS hold_pid,
                               blocker.usename AS hold_user,
                               blocker.application_name AS hold_app,
                               EXTRACT(EPOCH FROM (now() - blocker.xact_start))::int AS xact_age_s,
                               blocker.state AS hold_state,
                               blocker.wait_event_type AS hold_wait_type,
                               blocker.wait_event AS hold_wait_event,
                               LEFT(blocker.query, 200) AS hold_query,
                               wl.mode AS wait_mode,
                               hl.mode AS hold_mode,
                               COALESCE(wl.relation::regclass::text, wl.locktype) AS lock_object
                        FROM pg_stat_activity blocked
                        JOIN pg_locks wl ON wl.pid = blocked.pid AND NOT wl.granted
                        JOIN pg_locks hl ON hl.locktype = wl.locktype
                                         AND hl.granted
                                         AND (hl.relation IS NOT DISTINCT FROM wl.relation)
                                         AND hl.transactionid IS NOT DISTINCT FROM wl.transactionid
                                         AND hl.pid <> wl.pid
                        JOIN pg_stat_activity blocker ON blocker.pid = hl.pid
                        WHERE blocked.pid = ANY($1::int[])
                    ) SELECT * FROM blockers ORDER BY xact_age_s DESC NULLS LAST
                """, apply_pids)
                result["apply_worker_blockers"] = [dict(r) for r in blocker_rows]
            else:
                result["apply_worker_blockers"] = []
        except Exception as e:
            result["apply_worker_blockers_error"] = str(e)

        # long-running transactions on dest cluster (any database)
        try:
            long_tx_rows = await dc2.fetch("""
                SELECT pid, usename, application_name, datname, state,
                       wait_event_type, wait_event,
                       EXTRACT(EPOCH FROM (now() - xact_start))::int AS xact_age_s,
                       EXTRACT(EPOCH FROM (now() - query_start))::int AS query_age_s,
                       LEFT(query, 200) AS query
                FROM pg_stat_activity
                WHERE xact_start IS NOT NULL
                  AND state <> 'idle'
                  AND EXTRACT(EPOCH FROM (now() - xact_start)) > 30
                ORDER BY xact_start ASC
                LIMIT 15
            """)
            result["long_running_tx"] = [dict(r) for r in long_tx_rows]
        except Exception as e:
            result["long_running_tx_error"] = str(e)

        # All logical replication workers for this subscription (PG15 fallback for last error)
        # application_name for apply worker = sub_name
        try:
            worker_rows = await dc2.fetch("""
                SELECT pid, datname, usename, application_name,
                       state, wait_event_type, wait_event, backend_type,
                       LEFT(query, 500) AS query,
                       EXTRACT(EPOCH FROM (now() - state_change))::int AS state_age_s,
                       EXTRACT(EPOCH FROM (now() - query_start))::int AS query_age_s
                FROM pg_stat_activity
                WHERE backend_type = 'logical replication worker'
                   OR application_name = $1
                ORDER BY pid
            """, sub_name)
            result["all_replication_workers"] = [dict(r) for r in worker_rows]
        except Exception as e:
            result["all_replication_workers_error"] = str(e)

        await dc2.close()

    # ── Source side ───────────────────────────────────────────────────────────
    src_dsn = dsn_for_database(state.source_dsn, database)
    try:
        sc = await _asyncpg.connect(src_dsn, timeout=10)
    except Exception as e:
        result["source_error"] = str(e)
        sc = None

    if sc:
        # Replication slot state
        try:
            slot_row = await sc.fetchrow("""
                SELECT slot_name, active, active_pid,
                       pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes,
                       confirmed_flush_lsn::text,
                       pg_current_wal_lsn()::text AS current_wal_lsn,
                       restart_lsn::text
                FROM pg_replication_slots
                WHERE slot_name = $1
            """, sub_name)
            result["replication_slot"] = dict(slot_row) if slot_row else None
        except Exception as e:
            result["replication_slot_error"] = str(e)

        # pg_stat_replication — apply worker connection state
        try:
            repl_row = await sc.fetchrow("""
                SELECT pid, application_name, client_addr::text,
                       state, sent_lsn::text, write_lsn::text,
                       flush_lsn::text, replay_lsn::text,
                       write_lag::text, flush_lag::text, replay_lag::text,
                       sync_state,
                       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS send_replay_diff
                FROM pg_stat_replication
                WHERE application_name = $1
            """, sub_name)
            result["stat_replication"] = dict(repl_row) if repl_row else None
        except Exception as e:
            result["stat_replication_error"] = str(e)

        # WAL sender blocking locks on source
        try:
            walsender_pid = result.get("replication_slot", {}) or {}
            active_pid = walsender_pid.get("active_pid") if isinstance(walsender_pid, dict) else None
            if active_pid:
                blocker_rows = await sc.fetch("""
                    WITH blockers AS (
                        SELECT DISTINCT ON (blocked.pid)
                               blocked.pid AS wait_pid, blocked.usename AS wait_user,
                               blocker.pid AS hold_pid, blocker.usename AS hold_user,
                               EXTRACT(EPOCH FROM (now() - blocked.query_start))::int AS wait_age_s,
                               LEFT(blocked.query, 120) AS wait_stmt,
                               LEFT(blocker.query, 120) AS hold_stmt
                        FROM pg_stat_activity blocked
                        JOIN pg_locks wl ON wl.pid = blocked.pid AND NOT wl.granted
                        JOIN pg_locks hl ON hl.locktype = wl.locktype AND hl.granted
                                         AND (hl.relation IS NOT DISTINCT FROM wl.relation)
                                         AND hl.pid <> wl.pid
                        JOIN pg_stat_activity blocker ON blocker.pid = hl.pid
                        WHERE blocked.pid = $1
                    ) SELECT * FROM blockers
                """, active_pid)
                result["walsender_blockers"] = [dict(r) for r in blocker_rows]
            else:
                result["walsender_blockers"] = []
        except Exception as e:
            result["walsender_blockers_error"] = str(e)

        # Tables without PK or with problematic REPLICA IDENTITY in this subscription.
        # We get publication names from the dest subscription row (already fetched).
        # Querying pg_subscription directly on source can fail on Cloud SQL.
        try:
            pub_names: list[str] = []
            sub_info = result.get("subscription")
            if isinstance(sub_info, dict) and sub_info.get("subpublications"):
                pub_names = list(sub_info["subpublications"])
            if not pub_names:
                # fallback: slot name == sub name == pub name prefix heuristic
                pub_names = [sub_name.replace("_sub_", "_pub_")]

            ri_rows = await sc.fetch("""
                SELECT n.nspname || '.' || c.relname AS qualified,
                       CASE c.relreplident
                           WHEN 'd' THEN 'default'
                           WHEN 'f' THEN 'full'
                           WHEN 'i' THEN 'index'
                           WHEN 'n' THEN 'nothing'
                           ELSE c.relreplident::text
                       END AS replica_identity,
                       EXISTS (
                           SELECT 1 FROM pg_index i
                           WHERE i.indrelid = c.oid AND i.indisprimary
                       ) AS has_pk
                FROM pg_publication_tables pt
                JOIN pg_class c ON c.relname = pt.tablename
                JOIN pg_namespace n ON n.nspname = pt.schemaname AND n.oid = c.relnamespace
                WHERE pt.pubname = ANY($1::text[])
                ORDER BY n.nspname, c.relname
            """, pub_names)
            all_tables = [dict(r) for r in ri_rows]
            result["replica_identity_issues"] = [
                r for r in all_tables
                if not r["has_pk"] or r["replica_identity"] in ("nothing", "full")
            ]
            result["replica_identity_all"] = all_tables
        except Exception as e:
            result["replica_identity_error"] = str(e)

        await sc.close()

    return result


# ── Re-add table to publication (drop + add + refresh) ───────────────────────

@router.post("/publication-readd-table")
async def publication_readd_table(body: dict):
    """
    Remove a table from a publication and add it back, then refresh subscription.
    This forces a fresh initial copy, bypassing any stuck WAL transactions.
    body: { "pub_name": "...", "sub_name": "...", "table": "schema.table", "database": "dbname" }
    """
    _require_connection()
    import asyncpg as _asyncpg

    pub_name: str = body.get("pub_name", "")
    sub_name: str = body.get("sub_name", "")
    table: str    = body.get("table", "")
    database: str | None = body.get("database")

    if not pub_name or not table:
        raise HTTPException(400, "pub_name and table are required.")
    if "." not in table:
        raise HTTPException(400, "table must be schema.table")

    schema, tname = table.split(".", 1)
    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn

    steps = []
    try:
        src_conn = await _asyncpg.connect(src_dsn, timeout=15)
        try:
            await src_conn.execute(
                f'ALTER PUBLICATION "{pub_name}" DROP TABLE "{schema}"."{tname}"'
            )
            steps.append({"step": f'DROP TABLE {table} from publication', "ok": True})
        except Exception as e:
            steps.append({"step": f'DROP TABLE {table} from publication', "ok": False, "error": str(e)})
            await src_conn.close()
            return {"ok": False, "steps": steps}

        try:
            await src_conn.execute(
                f'ALTER PUBLICATION "{pub_name}" ADD TABLE "{schema}"."{tname}"'
            )
            steps.append({"step": f'ADD TABLE {table} to publication', "ok": True})
        except Exception as e:
            steps.append({"step": f'ADD TABLE {table} to publication', "ok": False, "error": str(e)})
            await src_conn.close()
            return {"ok": False, "steps": steps}

        await src_conn.close()
    except Exception as e:
        return {"ok": False, "steps": steps, "error": str(e)}

    # Refresh subscription on dest so it picks up the table again
    if sub_name:
        try:
            dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)
            await dest_conn.execute(
                f'ALTER SUBSCRIPTION "{sub_name}" REFRESH PUBLICATION'
            )
            await dest_conn.close()
            steps.append({"step": f'REFRESH PUBLICATION on subscription {sub_name}', "ok": True})
        except Exception as e:
            steps.append({"step": f'REFRESH PUBLICATION on subscription {sub_name}', "ok": False, "error": str(e)})
            return {"ok": False, "steps": steps}

    return {"ok": True, "steps": steps}


# ── Set REPLICA IDENTITY FULL ────────────────────────────────────────────────

@router.post("/set-replica-identity-full")
async def set_replica_identity_full(body: dict):
    """
    ALTER TABLE ... REPLICA IDENTITY FULL on specified tables on source.
    body: { "tables": ["schema.table", ...], "database": "dbname" }
    """
    _require_connection()
    import asyncpg as _asyncpg

    tables: list[str] = body.get("tables", [])
    database: str = body.get("database", "")
    if not tables:
        raise HTTPException(400, "No tables specified.")

    src_dsn = dsn_for_database(state.source_dsn, database)
    results = []
    try:
        conn = await _asyncpg.connect(src_dsn, timeout=15)
        for qualified in tables:
            if "." not in qualified:
                results.append({"table": qualified, "ok": False, "error": "Invalid table name"})
                continue
            schema, table = qualified.split(".", 1)
            try:
                await conn.execute(f'ALTER TABLE "{schema}"."{table}" REPLICA IDENTITY FULL')
                results.append({"table": qualified, "ok": True})
            except Exception as e:
                results.append({"table": qualified, "ok": False, "error": str(e)})
        await conn.close()
    except Exception as e:
        raise HTTPException(502, f"Cannot connect to source database '{database}': {e}")

    failed = [r for r in results if not r["ok"]]
    return {"results": results, "applied": len(results) - len(failed), "failed": len(failed)}


# ── Set REPLICA IDENTITY FULL streaming ──────────────────────────────────────

@router.post("/set-replica-identity-full-stream")
async def set_replica_identity_full_stream(body: dict):
    """
    Streaming version — yields NDJSON progress per table so the UI can show live results.
    body: { "tables": ["schema.table", ...], "database": "dbname" }
    """
    from fastapi.responses import StreamingResponse
    import asyncpg as _asyncpg
    import json as _json

    _require_connection()
    tables: list[str] = body.get("tables", [])
    database: str = body.get("database", "")
    if not tables:
        raise HTTPException(400, "No tables specified.")

    src_dsn = dsn_for_database(state.source_dsn, database)

    async def generate():
        try:
            conn = await _asyncpg.connect(src_dsn, timeout=15)
        except Exception as e:
            yield _json.dumps({"error": str(e)}) + "\n"
            return
        applied = 0
        failed = 0
        try:
            for i, qualified in enumerate(tables):
                if "." not in qualified:
                    row = {"table": qualified, "ok": False, "error": "Invalid table name",
                           "index": i, "total": len(tables), "applied": applied, "failed": failed + 1}
                    failed += 1
                    yield _json.dumps(row) + "\n"
                    continue
                schema, table = qualified.split(".", 1)
                try:
                    await conn.execute(f'ALTER TABLE "{schema}"."{table}" REPLICA IDENTITY FULL')
                    applied += 1
                    row = {"table": qualified, "ok": True,
                           "index": i, "total": len(tables), "applied": applied, "failed": failed}
                except Exception as e:
                    failed += 1
                    row = {"table": qualified, "ok": False, "error": str(e),
                           "index": i, "total": len(tables), "applied": applied, "failed": failed}
                yield _json.dumps(row) + "\n"
        finally:
            await conn.close()
        yield _json.dumps({"done": True, "applied": applied, "failed": failed}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ── Debug table ──────────────────────────────────────────────────────────────

@router.get("/debug-table")
async def debug_table(schema: str, table: str, database: str, sub_name: str):
    """
    Diagnostic info for a specific table in a subscription.
    Queries both source and destination without any locking operations.
    """
    _require_connection()
    import asyncpg as _asyncpg

    result: dict = {}

    # ── Destination side ─────────────────────────────────────────────────────
    dest_dsn = dsn_for_database(state.dest_dsn, database)
    try:
        dest_conn = await _asyncpg.connect(dest_dsn, timeout=10)
    except Exception as e:
        result["dest_error"] = str(e)
        dest_conn = None

    if dest_conn:
        try:
            sub_rel = await dest_conn.fetchrow("""
                SELECT sr.srsubstate, sr.srsublsn::text
                FROM pg_subscription_rel sr
                JOIN pg_subscription s  ON s.oid = sr.srsubid
                JOIN pg_class c         ON c.oid = sr.srrelid
                JOIN pg_namespace n     ON n.oid = c.relnamespace
                WHERE s.subname = $1 AND n.nspname = $2 AND c.relname = $3
            """, sub_name, schema, table)
            result["subscription_rel"] = dict(sub_rel) if sub_rel else None
        except Exception as e:
            result["subscription_rel_error"] = str(e)

        try:
            copy_progress = await dest_conn.fetchrow("""
                SELECT pid, command, type,
                       bytes_processed, bytes_total,
                       tuples_processed, tuples_excluded
                FROM pg_stat_progress_copy
                WHERE relid = (
                    SELECT c.oid FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = $1 AND c.relname = $2
                )
            """, schema, table)
            result["copy_progress"] = dict(copy_progress) if copy_progress else None
        except Exception as e:
            result["copy_progress_error"] = str(e)

        try:
            lock_rows = await dest_conn.fetch("""
                SELECT l.pid, l.mode, l.granted, l.locktype,
                       a.state, a.wait_event_type, a.wait_event,
                       LEFT(a.query, 120) AS query,
                       EXTRACT(EPOCH FROM (now() - a.query_start))::int AS query_age_s
                FROM pg_locks l
                JOIN pg_class c ON c.oid = l.relation
                JOIN pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_stat_activity a ON a.pid = l.pid
                WHERE n.nspname = $1 AND c.relname = $2
                ORDER BY l.granted DESC, query_age_s DESC NULLS LAST
            """, schema, table)
            result["locks"] = [dict(r) for r in lock_rows]
        except Exception as e:
            result["locks_error"] = str(e)

        try:
            table_info = await dest_conn.fetchrow("""
                SELECT c.oid, c.relpages, c.reltuples::bigint AS reltuples,
                       pg_relation_size(c.oid)
                           + COALESCE(pg_relation_size(c.reltoastrelid), 0) AS size_bytes,
                       c.relkind::text
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2
            """, schema, table)
            result["dest_table"] = dict(table_info) if table_info else None
        except Exception as e:
            result["dest_table_error"] = str(e)

        try:
            worker = await dest_conn.fetchrow("""
                SELECT pid, received_lsn::text, last_msg_receipt_time::text,
                       latest_end_lsn::text, latest_end_time::text
                FROM pg_stat_subscription
                WHERE subname = $1
            """, sub_name)
            result["subscription_worker"] = dict(worker) if worker else None
        except Exception as e:
            result["subscription_worker_error"] = str(e)

        await dest_conn.close()

    # ── Source side ──────────────────────────────────────────────────────────
    src_dsn = dsn_for_database(state.source_dsn, database)
    try:
        src_conn = await _asyncpg.connect(src_dsn, timeout=10)

        # table existence + size on source
        src_table = await src_conn.fetchrow("""
            SELECT c.oid, c.relpages,
                   pg_relation_size(c.oid)
                       + COALESCE(pg_relation_size(c.reltoastrelid), 0) AS size_bytes,
                   c.reltuples::bigint AS reltuples,
                   c.relkind::text, c.relispartition,
                   pg_get_partkeydef(c.oid) AS partkeydef,
                   pg_get_expr(c.relpartbound, c.oid) AS partbound
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2
        """, schema, table)
        result["source_table"] = dict(src_table) if src_table else None

        # publication membership
        pub_rows = await src_conn.fetch("""
            SELECT p.pubname, pt.schemaname, pt.tablename
            FROM pg_publication p
            JOIN pg_publication_tables pt ON pt.pubname = p.pubname
            WHERE pt.schemaname = $1 AND pt.tablename = $2
        """, schema, table)
        result["publications"] = [dict(r) for r in pub_rows]

        # replica identity + PK columns
        replica_id = await src_conn.fetchrow("""
            SELECT CASE c.relreplident
                WHEN 'd' THEN 'default (PK)'
                WHEN 'f' THEN 'full'
                WHEN 'i' THEN 'index'
                WHEN 'n' THEN 'nothing'
                ELSE c.relreplident::text
            END AS replica_identity,
            EXISTS (
                SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary
            ) AS has_pk
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2
        """, schema, table)
        result["replica_identity"] = replica_id["replica_identity"] if replica_id else None
        result["has_pk"] = replica_id["has_pk"] if replica_id else None

        # PK column names
        pk_cols = await src_conn.fetch("""
            SELECT a.attname AS column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            JOIN pg_class c ON c.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
            ORDER BY a.attnum
        """, schema, table)
        result["pk_columns"] = [r["column_name"] for r in pk_cols]

        # replication slot lag for this subscription
        slot_row = await src_conn.fetchrow("""
            SELECT slot_name, active,
                   pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes,
                   confirmed_flush_lsn::text
            FROM pg_replication_slots
            WHERE slot_name = $1 OR slot_name LIKE $2
            LIMIT 1
        """, sub_name, f"%{sub_name}%")
        result["replication_slot"] = dict(slot_row) if slot_row else None

        # locks on source table (relation-level)
        try:
            src_lock_rows = await src_conn.fetch("""
                SELECT l.pid, l.mode, l.granted, l.locktype,
                       a.usename, a.state, a.wait_event_type, a.wait_event,
                       LEFT(a.query, 200) AS query,
                       EXTRACT(EPOCH FROM (now() - a.query_start))::int AS query_age_s
                FROM pg_locks l
                JOIN pg_class c ON c.oid = l.relation
                JOIN pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_stat_activity a ON a.pid = l.pid
                WHERE n.nspname = $1 AND c.relname = $2
                ORDER BY l.granted DESC, query_age_s DESC NULLS LAST
            """, schema, table)
            result["source_locks"] = [dict(r) for r in src_lock_rows]
        except Exception as e:
            result["source_locks_error"] = str(e)

        # blocked replication workers on source — processes waiting that are
        # blocking CREATE_REPLICATION_SLOT / walsender / replication users.
        # pg_locks WHERE granted=false covers global waits (relation IS NULL)
        # that don't appear in the per-table lock query above.
        try:
            repl_blockers = await src_conn.fetch("""
                WITH blockers AS (
                    SELECT DISTINCT ON (blocked.pid)
                           blocked.pid          AS wait_pid,
                           blocked.usename      AS wait_user,
                           blocker.pid          AS hold_pid,
                           blocker.usename      AS hold_user,
                           EXTRACT(EPOCH FROM (now() - blocked.query_start))::int AS wait_age_s,
                           LEFT(blocked.query, 200)  AS wait_statement,
                           LEFT(blocker.query, 200)  AS hold_statement,
                           blocker.state        AS hold_state
                    FROM pg_stat_activity blocked
                    JOIN pg_locks         wl ON wl.pid = blocked.pid AND NOT wl.granted
                    JOIN pg_locks         hl ON hl.locktype = wl.locktype
                                             AND hl.granted
                                             AND (hl.relation  IS NOT DISTINCT FROM wl.relation)
                                             AND (hl.classid   IS NOT DISTINCT FROM wl.classid)
                                             AND (hl.objid     IS NOT DISTINCT FROM wl.objid)
                                             AND hl.pid <> wl.pid
                    JOIN pg_stat_activity blocker ON blocker.pid = hl.pid
                    WHERE blocked.usename = (
                        SELECT usename FROM pg_stat_activity
                        WHERE pid IN (
                            SELECT active_pid FROM pg_replication_slots
                            WHERE slot_name = $1
                        )
                        LIMIT 1
                    )
                    OR blocked.query ILIKE '%replication_slot%'
                    OR blocked.query ILIKE '%COPY%'
                    ORDER BY blocked.pid, wait_age_s DESC
                )
                SELECT * FROM blockers ORDER BY wait_age_s DESC NULLS LAST
            """, sub_name)
            result["replication_blockers"] = [dict(r) for r in repl_blockers]
        except Exception as e:
            result["replication_blockers_error"] = str(e)

        # column-level schema diff between source and dest
        try:
            src_cols = await src_conn.fetch("""
                SELECT a.attname AS column_name,
                       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                       a.attnotnull AS not_null,
                       a.attnum
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum
            """, schema, table)
            result["source_columns"] = [dict(r) for r in src_cols]
        except Exception as e:
            result["source_columns_error"] = str(e)

        await src_conn.close()
    except Exception as e:
        result["source_error"] = str(e)

    # ── Schema diff (dest columns vs source) ─────────────────────────────────
    if result.get("source_columns") and dest_conn is not None:
        dest_dsn2 = dsn_for_database(state.dest_dsn, database)
        try:
            dc = await _asyncpg.connect(dest_dsn2, timeout=10)
            dest_cols = await dc.fetch("""
                SELECT a.attname AS column_name,
                       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                       a.attnotnull AS not_null,
                       a.attnum
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum
            """, schema, table)
            await dc.close()
            dest_col_map = {r["column_name"]: r for r in dest_cols}
            diff = []
            for sc in result["source_columns"]:  # type: ignore[union-attr]
                col = sc["column_name"]
                dc_row = dest_col_map.get(col)
                diff.append({
                    "column_name": col,
                    "source_type": sc["data_type"],
                    "dest_type": dc_row["data_type"] if dc_row else None,
                    "source_not_null": sc["not_null"],
                    "dest_not_null": dc_row["not_null"] if dc_row else None,
                    "match": dc_row is not None and dc_row["data_type"] == sc["data_type"],
                    "missing_on_dest": dc_row is None,
                })
            # also flag columns on dest not on source
            src_col_names = {sc["column_name"] for sc in result["source_columns"]}  # type: ignore[union-attr]
            for col, dc_row in dest_col_map.items():
                if col not in src_col_names:
                    diff.append({
                        "column_name": col,
                        "source_type": None,
                        "dest_type": dc_row["data_type"],
                        "match": False,
                        "extra_on_dest": True,
                    })
            result["schema_diff"] = diff
        except Exception as e:
            result["schema_diff_error"] = str(e)

    return result


# ── Source table sizes (lazy, fetched once by the frontend) ──────────────────

@router.get("/source-table-sizes")
async def source_table_sizes(database: str):
    """
    Heap sizes for all tables in one source database.
    Intended to be called once per database on first load — not polled.
    Returns { "schema.table": bytes, ... }
    """
    _require_connection()
    import asyncpg as _asyncpg
    src_dsn = dsn_for_database(state.source_dsn, database)
    try:
        conn = await _asyncpg.connect(src_dsn, timeout=15)
        # Use relpages * block_size from pg_class — no lock required.
        # pg_relation_size() acquires AccessShareLock and can block when
        # a long-running lock is held on the table.
        # relpages is updated by VACUUM/ANALYZE so may be slightly stale,
        # but is always available without waiting.
        rows = await conn.fetch("""
            SELECT n.nspname || '.' || c.relname AS qualified,
                   (c.relpages::bigint + COALESCE(ct.relpages, 0)::bigint)
                       * current_setting('block_size')::bigint AS size_bytes,
                   CASE WHEN c.reltuples > 0 THEN c.reltuples::bigint ELSE NULL END AS row_estimate,
                   CASE c.relreplident
                       WHEN 'd' THEN 'default'
                       WHEN 'f' THEN 'full'
                       WHEN 'i' THEN 'index'
                       WHEN 'n' THEN 'nothing'
                       ELSE c.relreplident::text
                   END AS replica_identity,
                   EXISTS (
                       SELECT 1 FROM pg_index i
                       WHERE i.indrelid = c.oid AND i.indisprimary
                   ) AS has_pk,
                   COALESCE(s.n_tup_ins, 0)  AS n_tup_ins,
                   COALESCE(s.n_tup_upd, 0)  AS n_tup_upd,
                   COALESCE(s.n_tup_del, 0)  AS n_tup_del
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_class ct ON ct.oid = c.reltoastrelid
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        """)
        await conn.close()
    except Exception as e:
        raise HTTPException(502, f"Cannot connect to source database '{database}': {e}")
    return {r["qualified"]: {
        "size_bytes": r["size_bytes"],
        "row_estimate": r["row_estimate"],
        "replica_identity": r["replica_identity"],
        "has_pk": r["has_pk"],
        "n_tup_ins": r["n_tup_ins"],
        "n_tup_upd": r["n_tup_upd"],
        "n_tup_del": r["n_tup_del"],
    } for r in rows}


# ── Accurate dest table sizes (pg_relation_size, on-demand) ──────────────────

@router.get("/dest-table-sizes")
async def dest_table_sizes(database: str):
    """
    Accurate heap + TOAST sizes (no indexes) for all tables in one dest database,
    using pg_relation_size() (acquires AccessShareLock — call on demand only).
    Returns { "schema.table": bytes, ... }
    """
    _require_connection()
    import asyncpg as _asyncpg
    dest_dsn = dsn_for_database(state.dest_dsn, database)
    try:
        conn = await _asyncpg.connect(dest_dsn, timeout=15)
        rows = await conn.fetch("""
            SELECT n.nspname || '.' || c.relname AS qualified,
                   pg_relation_size(c.oid)
                   + COALESCE(pg_relation_size(c.reltoastrelid), 0) AS size_bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        """)
        await conn.close()
    except Exception as e:
        raise HTTPException(502, f"Cannot connect to dest database '{database}': {e}")
    return {r["qualified"]: r["size_bytes"] for r in rows}


# ── Analyze ───────────────────────────────────────────────────────────────────

@router.post("/analyze")
async def analyze_tables(body: dict):
    """
    Run ANALYZE on specified tables on destination, streaming NDJSON progress.
    body: { "tables": ["schema.table", ...], "database": "dbname",
            "statistics_target": 100 }   # optional, 1-10000
    Each line: {"table": "schema.table", "ok": true, "done": N, "total": N}
    Last line:  {"done": true}
    """
    _require_connection()
    import asyncpg as _asyncpg
    import json as _json
    from fastapi.responses import StreamingResponse

    tables: list = body.get("tables", [])
    database: str | None = body.get("database")
    statistics_target: int | None = body.get("statistics_target")
    if not tables:
        raise HTTPException(400, "No tables specified.")
    if statistics_target is not None and not (1 <= statistics_target <= 10000):
        raise HTTPException(400, "statistics_target must be 1–10000")

    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn

    async def generate():
        conn = await _asyncpg.connect(dest_dsn, timeout=15)
        total = len(tables)
        try:
            for i, t in enumerate(tables, 1):
                try:
                    parts = t.split(".", 1)
                    if len(parts) != 2:
                        raise ValueError(f"Expected schema.table, got: {t}")
                    schema, table = parts
                    if statistics_target is not None:
                        # Set statistics_target on ALL columns
                        col_names = await conn.fetch(
                            "SELECT attname FROM pg_attribute "
                            "WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped",
                            f'"{schema}"."{table}"'
                        )
                        for col_row in col_names:
                            await conn.execute(
                                f'ALTER TABLE "{schema}"."{table}" '
                                f'ALTER COLUMN "{col_row["attname"]}" SET STATISTICS {statistics_target}'
                            )
                    await conn.execute(f'ANALYZE "{schema}"."{table}"')
                    yield _json.dumps({"table": t, "ok": True, "done": i, "total": total}) + "\n"
                except Exception as e:
                    yield _json.dumps({"table": t, "ok": False, "error": str(e).split("\n")[0], "done": i, "total": total}) + "\n"
        finally:
            await conn.close()
        yield _json.dumps({"done": True, "total": total}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ── Reset ─────────────────────────────────────────────────────────────────────

@router.post("/reset/{subscription_name}")
async def reset_replication(subscription_name: str, database: str | None = None):
    """Drop subscription + slot, TRUNCATE dest tables, then recreate from scratch (destructive)."""
    _require_connection()
    import asyncpg as _asyncpg
    dest_pool = await get_dest_pool(state.dest_dsn)
    src_pool = await get_source_pool(state.source_dsn)

    async with dest_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT subslotname, subpublications FROM pg_subscription WHERE subname = $1",
            subscription_name
        )
        if not row:
            raise HTTPException(404, f"Subscription '{subscription_name}' not found.")
        slot_name = row["subslotname"]
        publications = row["subpublications"]

        try:
            await conn.execute(f'ALTER SUBSCRIPTION "{subscription_name}" DISABLE')
        except Exception as e:
            raise HTTPException(
                500,
                f"Could not disable subscription '{subscription_name}': {e}. "
                f"Cannot proceed with reset."
            )
        await conn.execute(f'DROP SUBSCRIPTION IF EXISTS "{subscription_name}"')

    if slot_name:
        async with src_pool.acquire() as conn:
            try:
                await conn.execute("SELECT pg_drop_replication_slot($1)", slot_name)
            except Exception:
                pass

    # TRUNCATE destination tables listed in the publication(s)
    src_dsn_db = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    pub_tables: list[dict] = []
    try:
        src_conn = await _asyncpg.connect(src_dsn_db, timeout=15)
        try:
            for pub_name in publications:
                rows = await src_conn.fetch(
                    "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1",
                    pub_name
                )
                pub_tables.extend({"schemaname": r["schemaname"], "tablename": r["tablename"]} for r in rows)
        finally:
            await src_conn.close()
    except Exception:
        pass  # if we can't reach source, skip truncate and proceed

    if pub_tables:
        try:
            trunc_conn = await _asyncpg.connect(state.dest_dsn, timeout=30)
            try:
                tables_sql = ", ".join(
                    f'"{r["schemaname"]}"."{r["tablename"]}"' for r in pub_tables
                )
                await trunc_conn.execute(f"TRUNCATE {tables_sql}")
            finally:
                await trunc_conn.close()
        except Exception as e:
            raise HTTPException(500, f"TRUNCATE destination tables failed: {e}")

    conn_dsn = state.source_repl_dsn if state.source_repl_dsn else state.source_dsn
    if not re.match(r'^postgres(ql)?://', conn_dsn):
        raise HTTPException(400, "Replication DSN is missing or invalid. Reconnect and try again.")
    if "$conn_str$" in conn_dsn:
        raise HTTPException(500, "Connection DSN contains illegal sequence, cannot recreate subscription.")

    pub_list = ", ".join(f'"{p}"' for p in publications)
    dedicated_conn = None
    try:
        dedicated_conn = await _asyncpg.connect(state.dest_dsn, timeout=30)
        await dedicated_conn.execute("SET statement_timeout = '120s'")
        await dedicated_conn.execute(f"""
            CREATE SUBSCRIPTION "{subscription_name}"
            CONNECTION $conn_str${conn_dsn}$conn_str$
            PUBLICATION {pub_list}
            WITH (copy_data = true)
        """)
    except Exception as e:
        err = str(e)
        if "could not connect to the publisher" in err or "Connection timed out" in err or "Connection refused" in err or "statement timeout" in err:
            raise HTTPException(400, f"Destination could not reach source at {conn_dsn.split('@')[-1] if '@' in conn_dsn else conn_dsn}: {err}")
        raise HTTPException(400, f"CREATE SUBSCRIPTION failed during reset: {err}")
    finally:
        if dedicated_conn:
            try:
                await dedicated_conn.close()
            except Exception:
                pass

    return {"status": "reset", "subscription_name": subscription_name, "tables_truncated": len(pub_tables)}


# ── Pause / Resume ────────────────────────────────────────────────────────────

@router.post("/subscription/{name}/pause")
async def pause_subscription(name: str, database: str | None = None):
    """ALTER SUBSCRIPTION ... DISABLE — stops apply worker, keeps slot intact."""
    _require_connection()
    import asyncpg as _asyncpg
    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn
    conn = await _asyncpg.connect(dest_dsn, timeout=10)
    try:
        row = await conn.fetchrow(
            "SELECT subenabled FROM pg_subscription WHERE subname = $1", name
        )
        if row is None:
            raise HTTPException(404, f"Subscription '{name}' not found.")
        if not row["subenabled"]:
            return {"status": "already_paused", "subscription_name": name}
        await conn.execute(f'ALTER SUBSCRIPTION "{name}" DISABLE')
    finally:
        await conn.close()
    return {"status": "paused", "subscription_name": name}


@router.post("/subscription/{name}/resume")
async def resume_subscription(name: str, database: str | None = None):
    """ALTER SUBSCRIPTION ... ENABLE — restarts apply worker from where it left off."""
    _require_connection()
    import asyncpg as _asyncpg
    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn
    conn = await _asyncpg.connect(dest_dsn, timeout=10)
    try:
        row = await conn.fetchrow(
            "SELECT subenabled FROM pg_subscription WHERE subname = $1", name
        )
        if row is None:
            raise HTTPException(404, f"Subscription '{name}' not found.")
        if row["subenabled"]:
            return {"status": "already_running", "subscription_name": name}
        await conn.execute(f'ALTER SUBSCRIPTION "{name}" ENABLE')
    finally:
        await conn.close()
    return {"status": "resumed", "subscription_name": name}


# ── Sync workers limit ────────────────────────────────────────────────────────

@router.post("/subscription/{name}/set-workers")
async def set_sync_workers(name: str, body: dict, database: str | None = None):
    """
    Sets max_sync_workers_per_subscription globally on the destination via
    ALTER SYSTEM SET + pg_reload_conf(). This is a cluster-wide GUC, not
    per-subscription. Requires superuser on destination.
    """
    _require_connection()
    import asyncpg as _asyncpg
    workers = body.get("workers")
    if not isinstance(workers, int) or workers < 1 or workers > 32:
        raise HTTPException(400, "workers must be an integer between 1 and 32.")

    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn
    conn = await _asyncpg.connect(dest_dsn, timeout=10)
    try:
        # Detect Cloud SQL — ALTER SYSTEM is not available
        is_cloudsql = await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqladmin')"
        )
        if is_cloudsql:
            raise HTTPException(400,
                "Cloud SQL does not support ALTER SYSTEM. "
                "Change max_sync_workers_per_subscription via GCP Console: "
                "Cloud SQL instance → Edit → Flags → add max_sync_workers_per_subscription, "
                "or use gcloud: gcloud sql instances patch INSTANCE --database-flags "
                "max_sync_workers_per_subscription=N"
            )
        try:
            await conn.execute(f"ALTER SYSTEM SET max_sync_workers_per_subscription = {workers}")
            await conn.execute("SELECT pg_reload_conf()")
        except Exception as e:
            raise HTTPException(400, f"Could not set max_sync_workers_per_subscription: {e}")
        current = await conn.fetchval("SELECT current_setting('max_sync_workers_per_subscription')::int")
    finally:
        await conn.close()
    return {"status": "ok", "max_sync_workers_per_subscription": current}


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats/interval")
async def get_stats_interval():
    return {"interval_seconds": state.stats_refresh_interval}


@router.put("/stats/interval")
async def set_stats_interval(body: dict):
    interval = body.get("interval_seconds", 10)
    if not isinstance(interval, int) or interval < 1 or interval > 3600:
        raise HTTPException(400, "interval_seconds must be an integer between 1 and 3600.")
    state.stats_refresh_interval = interval
    state.persist()
    return {"interval_seconds": state.stats_refresh_interval}


# ── Capacity (wal_senders / slots) ────────────────────────────────────────────

@router.get("/capacity")
async def get_capacity():
    """
    Returns WAL sender and replication slot utilisation from source.
    Used to display headroom info in the UI header.
    """
    _require_connection()
    src_pool = await get_source_pool(state.source_dsn)
    async with src_pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT
                current_setting('max_wal_senders')::int      AS wal_senders_max,
                current_setting('max_replication_slots')::int AS slots_max,
                (SELECT count(*) FROM pg_stat_replication)    AS wal_senders_used,
                (SELECT count(*) FROM pg_replication_slots)   AS slots_used,
                (SELECT count(*) FROM pg_replication_slots WHERE active) AS slots_active
        """)
    return {
        "wal_senders_max":    row["wal_senders_max"],
        "wal_senders_used":   int(row["wal_senders_used"]),
        "slots_max":          row["slots_max"],
        "slots_used":         int(row["slots_used"]),
        "slots_active":       int(row["slots_active"]),
    }


# ── Worker / Replication stats ────────────────────────────────────────────────

@router.get("/worker-stats")
async def worker_stats():
    """Returns pg_stat_subscription from destination."""
    _require_connection()
    pool = await get_dest_pool(state.dest_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT subid, subname, pid, relid,
                   received_lsn::text,
                   last_msg_send_time::text,
                   last_msg_receipt_time::text,
                   latest_end_lsn::text,
                   latest_end_time::text
            FROM pg_stat_subscription
            ORDER BY subname
        """)
    return [dict(r) for r in rows]


@router.get("/source-stats")
async def source_stats():
    """Returns pg_stat_replication from source."""
    _require_connection()
    pool = await get_source_pool(state.source_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT pid, application_name, client_addr::text,
                   state, sent_lsn::text, write_lsn::text,
                   flush_lsn::text, replay_lsn::text,
                   write_lag::text, flush_lag::text, replay_lag::text,
                   sync_state
            FROM pg_stat_replication
            ORDER BY application_name
        """)
    return [dict(r) for r in rows]


# ── Conflicts / LSN skip ──────────────────────────────────────────────────────

@router.get("/conflicts")
async def list_conflicts():
    """Lists disabled subscriptions and replication origin positions (for LSN skip)."""
    _require_connection()
    pool = await get_dest_pool(state.dest_dsn)
    async with pool.acquire() as conn:
        subs = await conn.fetch("""
            SELECT subname, subenabled, subslotname
            FROM pg_subscription
            WHERE subenabled = false
        """)
        origins = await conn.fetch("""
            SELECT external_id, remote_lsn::text, local_lsn::text
            FROM pg_replication_origin_status
        """)
    return {
        "disabled_subscriptions": [dict(r) for r in subs],
        "replication_origins": [dict(r) for r in origins],
    }


@router.post("/skip-lsn")
async def skip_lsn(body: dict):
    """Execute ALTER SUBSCRIPTION sub SKIP (LSN '...')"""
    _require_connection()
    sub_name = body.get("subscription_name")
    lsn = body.get("lsn")
    if not sub_name or not lsn:
        raise HTTPException(400, "subscription_name and lsn required")
    if not re.match(r'^[0-9A-F]+/[0-9A-F]+$', lsn, re.IGNORECASE):
        raise HTTPException(400, "Invalid LSN format. Expected: X/XXXXXXXX")
    pool = await get_dest_pool(state.dest_dsn)
    async with pool.acquire() as conn:
        await conn.execute(f'ALTER SUBSCRIPTION "{sub_name}" SKIP (LSN \'{lsn}\')')
    return {"status": "skipped", "subscription_name": sub_name, "lsn": lsn}


# ── Stop subscription ─────────────────────────────────────────────────────────

@router.post("/subscription/{name}/stop")
async def stop_subscription(name: str, database: str | None = None):
    """
    Stop replication without touching the source slot:
      1. ALTER SUBSCRIPTION ... DISABLE
      2. ALTER SUBSCRIPTION ... SET (slot_name = NONE)   -- detach slot so DROP doesn't try to remove it
      3. DROP SUBSCRIPTION
    Slot on source is preserved — use Drop Slot separately if needed.
    Leaves tables and data intact.
    """
    _require_connection()
    import asyncpg as _asyncpg
    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn

    dest_conn = await _asyncpg.connect(dest_dsn, timeout=10)
    try:
        row = await dest_conn.fetchrow(
            "SELECT subslotname, subenabled FROM pg_subscription WHERE subname = $1", name
        )
        if not row:
            raise HTTPException(404, f"Subscription '{name}' not found.")

        slot_name = row["subslotname"]

        if row["subenabled"]:
            try:
                await dest_conn.execute(f'ALTER SUBSCRIPTION "{name}" DISABLE')
            except Exception as e:
                raise HTTPException(500, f"Could not disable subscription: {e}")

        try:
            await dest_conn.execute(f'ALTER SUBSCRIPTION "{name}" SET (slot_name = NONE)')
        except Exception as e:
            raise HTTPException(500, f"Could not detach slot from subscription: {e}")

        await dest_conn.execute(f'DROP SUBSCRIPTION IF EXISTS "{name}"')
    finally:
        await dest_conn.close()

    return {"status": "stopped", "subscription_name": name, "slot_name": slot_name}


# ── Vacuum truncate ────────────────────────────────────────────────────────────

@router.post("/subscription/{name}/vacuum-truncate")
async def vacuum_truncate_subscription(name: str, database: str | None = None):
    """
    TRUNCATE + VACUUM FULL on all destination tables in the subscription.
    TRUNCATE removes all rows instantly, VACUUM FULL reclaims disk space.
    Only safe when replication is fully stopped (slot dropped).
    """
    _require_connection()
    import asyncpg as _asyncpg
    import urllib.parse

    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn

    # Parse host for informational response
    parsed = urllib.parse.urlparse(dest_dsn)
    dest_host = f"{parsed.hostname}:{parsed.port or 5432}{parsed.path}"

    dest_conn = await _asyncpg.connect(dest_dsn, timeout=10)
    try:
        # Fetch subscription tables from pg_subscription_rel + pg_class
        tables = await dest_conn.fetch("""
            SELECT n.nspname AS schema_name, c.relname AS table_name
            FROM pg_subscription s
            JOIN pg_subscription_rel sr ON sr.srsubid = s.oid
            JOIN pg_class c ON c.oid = sr.srrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE s.subname = $1
            ORDER BY n.nspname, c.relname
        """, name)

        if not tables:
            raise HTTPException(404, f"Subscription '{name}' not found or has no tracked tables.")

        results = []
        for row in tables:
            schema = row["schema_name"]
            table = row["table_name"]
            qualified = f'"{schema}"."{table}"'
            try:
                await dest_conn.execute(f"TRUNCATE {qualified}")
                await dest_conn.execute(f"VACUUM FULL {qualified}")
                results.append({"table": f"{schema}.{table}", "ok": True})
            except Exception as e:
                results.append({"table": f"{schema}.{table}", "ok": False, "error": str(e)})
    finally:
        await dest_conn.close()

    applied = sum(1 for r in results if r["ok"])
    failed = sum(1 for r in results if not r["ok"])
    return {
        "dest_host": dest_host,
        "applied": applied,
        "failed": failed,
        "results": results,
    }


# ── Get subscription tables (for vacuum preview) ───────────────────────────────

@router.get("/subscription/{name}/tables")
async def get_subscription_tables(name: str, database: str | None = None):
    """Returns list of tables tracked by the subscription on destination."""
    _require_connection()
    import asyncpg as _asyncpg
    import urllib.parse

    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn
    parsed = urllib.parse.urlparse(dest_dsn)
    dest_host = f"{parsed.hostname}:{parsed.port or 5432}{parsed.path}"

    dest_conn = await _asyncpg.connect(dest_dsn, timeout=10)
    try:
        tables = await dest_conn.fetch("""
            SELECT n.nspname AS schema_name, c.relname AS table_name
            FROM pg_subscription s
            JOIN pg_subscription_rel sr ON sr.srsubid = s.oid
            JOIN pg_class c ON c.oid = sr.srrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE s.subname = $1
            ORDER BY n.nspname, c.relname
        """, name)
    finally:
        await dest_conn.close()

    return {
        "dest_host": dest_host,
        "tables": [f"{r['schema_name']}.{r['table_name']}" for r in tables],
    }


# ── Add table to publication ──────────────────────────────────────────────────

@router.post("/publication/{pub_name}/add-table")
async def add_table_to_publication(pub_name: str, body: dict):
    """
    ALTER PUBLICATION pub ADD TABLE schema.table
    Then issues ALTER SUBSCRIPTION sub REFRESH PUBLICATION on all subscriptions
    that reference this publication.
    """
    _require_connection()
    import asyncpg as _asyncpg
    table = body.get("table")  # "schema.table"
    database: str | None = body.get("database")
    if not table or "." not in table:
        raise HTTPException(400, "table must be 'schema.table'")

    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn

    src_conn = await _asyncpg.connect(src_dsn, timeout=15)
    try:
        exists = await src_conn.fetchval(
            "SELECT 1 FROM pg_publication WHERE pubname = $1", pub_name
        )
        if not exists:
            raise HTTPException(404, f"Publication '{pub_name}' not found.")

        schema, tname = table.split(".", 1)
        safe = await src_conn.fetchval(
            "SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) "
            "FROM information_schema.tables "
            "WHERE table_schema = $1 AND table_name = $2",
            schema, tname,
        )
        if not safe:
            raise HTTPException(400, f"Table '{table}' does not exist on source.")

        await src_conn.execute(f'ALTER PUBLICATION "{pub_name}" ADD TABLE {safe}')
    finally:
        await src_conn.close()

    # Refresh all subscriptions on dest that reference this publication
    dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)
    refreshed = []
    try:
        try:
            subs = await dest_conn.fetch(
                "SELECT subname FROM pg_subscription WHERE $1 = ANY(subpublications)", pub_name
            )
        except Exception:
            subs = []
        for sub in subs:
            try:
                await dest_conn.execute(f'ALTER SUBSCRIPTION "{sub["subname"]}" REFRESH PUBLICATION')
                refreshed.append(sub["subname"])
            except Exception as e:
                pass  # best-effort refresh
    finally:
        await dest_conn.close()

    return {
        "status": "ok",
        "publication": pub_name,
        "table_added": table,
        "subscriptions_refreshed": refreshed,
    }


@router.delete("/publication/{pub_name}/table")
async def drop_table_from_publication(pub_name: str, table: str, database: str | None = None):
    """
    ALTER PUBLICATION pub DROP TABLE schema.table
    table: query param "schema.table"
    """
    _require_connection()
    import asyncpg as _asyncpg
    if not table or "." not in table:
        raise HTTPException(400, "table must be 'schema.table'")
    schema, tname = table.split(".", 1)

    src_dsn = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    conn = await _asyncpg.connect(src_dsn, timeout=15)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_publication WHERE pubname = $1", pub_name)
        if not exists:
            raise HTTPException(404, f"Publication '{pub_name}' not found.")
        await conn.execute(f'ALTER PUBLICATION "{pub_name}" DROP TABLE "{schema}"."{tname}"')
    finally:
        await conn.close()

    return {"status": "ok", "publication": pub_name, "table_dropped": table}


@router.post("/publication/{pub_name}/refresh-subscriptions")
async def refresh_publication_subscriptions(pub_name: str, database: str | None = None):
    """
    ALTER SUBSCRIPTION ... REFRESH PUBLICATION for all subscriptions referencing this publication.
    """
    _require_connection()
    import asyncpg as _asyncpg
    dest_dsn = dsn_for_database(state.dest_dsn, database) if database else state.dest_dsn
    conn = await _asyncpg.connect(dest_dsn, timeout=15)
    refreshed = []
    errors = []
    try:
        try:
            subs = await conn.fetch(
                "SELECT subname FROM pg_subscription WHERE $1 = ANY(subpublications)", pub_name
            )
        except Exception:
            subs = await conn.fetch(
                "SELECT subname FROM pg_stat_subscription WHERE subname IS NOT NULL GROUP BY subname"
            )
        for sub in subs:
            try:
                await conn.execute(f'ALTER SUBSCRIPTION "{sub["subname"]}" REFRESH PUBLICATION')
                refreshed.append(sub["subname"])
            except Exception as e:
                errors.append({"sub": sub["subname"], "error": str(e)})
    finally:
        await conn.close()

    return {"status": "ok", "refreshed": refreshed, "errors": errors}


# ── Sequence sync ─────────────────────────────────────────────────────────────

@router.get("/sequences", response_model=List[SequenceInfo])
async def list_sequences():
    """
    Read current sequence values from source using the most reliable method:
    pg_sequences.last_value is NOT reliable (may lag due to caching), so we
    use MAX(column) from the table as the authoritative high-water mark, then
    fall back to last_value for sequences that have no owning table/column.

    For SERIAL / IDENTITY columns: pg_get_serial_sequence() + MAX(col).
    For plain sequences: pg_sequences.last_value (best available without nextval()).
    """
    _require_connection()
    src_pool = await get_source_pool(state.source_dsn)
    dest_pool = await get_dest_pool(state.dest_dsn)

    async with src_pool.acquire() as src_conn:
        # Gather all sequences with their owning table/column if any
        seq_rows = await src_conn.fetch("""
            SELECT
                n.nspname || '.' || s.relname AS seq_fqn,
                d.refobjid::regclass::text AS owner_table,
                a.attname AS owner_column
            FROM pg_class s
            JOIN pg_namespace n ON n.oid = s.relnamespace
            LEFT JOIN pg_depend d ON d.objid = s.oid
                AND d.classid = 'pg_class'::regclass
                AND d.refclassid = 'pg_class'::regclass
                AND d.deptype = 'a'
            LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
            WHERE s.relkind = 'S'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            ORDER BY seq_fqn
        """)

        results: list[SequenceInfo] = []
        for row in seq_rows:
            seq_fqn = row["seq_fqn"]
            owner_table = row["owner_table"]
            owner_col = row["owner_column"]

            if owner_table and owner_col:
                # Most reliable: MAX of the actual data column
                try:
                    max_val = await src_conn.fetchval(
                        f"SELECT COALESCE(MAX({owner_col}), 0) FROM {owner_table}"
                    )
                    source_value = int(max_val)
                    table_ref = owner_table
                    col_ref = owner_col
                except Exception:
                    # Fall back to last_value from pg_sequences
                    lv = await src_conn.fetchval(
                        "SELECT last_value FROM pg_sequences "
                        "WHERE schemaname || '.' || sequencename = $1", seq_fqn
                    )
                    source_value = int(lv or 0)
                    table_ref = seq_fqn
                    col_ref = "last_value"
            else:
                # Plain sequence with no owning column — use last_value
                lv = await src_conn.fetchval(
                    "SELECT last_value FROM pg_sequences "
                    "WHERE schemaname || '.' || sequencename = $1", seq_fqn
                )
                source_value = int(lv or 0)
                table_ref = seq_fqn
                col_ref = "last_value (no owning column)"

            # Read dest value
            dest_value: Optional[int] = None
            async with dest_pool.acquire() as dest_conn:
                dest_lv = await dest_conn.fetchval(
                    "SELECT last_value FROM pg_sequences "
                    "WHERE schemaname || '.' || sequencename = $1", seq_fqn
                )
                if dest_lv is not None:
                    dest_value = int(dest_lv)

            results.append(SequenceInfo(
                sequence_name=seq_fqn,
                table_name=table_ref,
                column_name=col_ref,
                source_value=source_value,
                dest_value=dest_value,
                needs_sync=dest_value is None or dest_value < source_value,
            ))

    return results


@router.post("/sequences/sync")
async def sync_sequences(body: dict):
    """
    Set sequence values on destination to match source high-water marks.
    Uses setval(seq, value, true) — next nextval() returns value+1.
    Accepts optional list of sequence names to sync; defaults to all that need sync.
    """
    _require_connection()
    only = set(body.get("sequences", []))  # empty = sync all that need it

    sequences = await list_sequences()
    to_sync = [
        s for s in sequences
        if s.needs_sync and (not only or s.sequence_name in only)
    ]

    if not to_sync:
        return {"synced": [], "message": "All sequences are already up to date."}

    dest_pool = await get_dest_pool(state.dest_dsn)
    synced = []
    errors = []

    async with dest_pool.acquire() as conn:
        for seq in to_sync:
            try:
                # setval(seq, value, true): last_value = value, is_called = TRUE
                # → next nextval() returns value + increment (usually +1)
                await conn.execute(
                    "SELECT setval($1, $2, true)", seq.sequence_name, seq.source_value
                )
                synced.append({
                    "sequence": seq.sequence_name,
                    "set_to": seq.source_value,
                    "was": seq.dest_value,
                })
            except Exception as e:
                errors.append({"sequence": seq.sequence_name, "error": str(e)})

    return {"synced": synced, "errors": errors}


# ── Schema DDL sync ───────────────────────────────────────────────────────────

async def _diff_table_list(table_pairs: list[tuple[str, str]], database: str | None = None) -> list[TableSchemaDiff]:
    """Core diff logic — accepts list of (schema, table) pairs.
    database: if provided, connects to that specific database on BOTH source and destination.
    Logical replication requires matching database names on both sides.
    """
    import asyncpg as _asyncpg
    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn
    src_conn  = await _asyncpg.connect(src_dsn,  timeout=15)
    dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)
    results = []
    try:
        for schema_name, table_name in table_pairs:
            fqn = f"{schema_name}.{table_name}"

            # Use pg_catalog for not_null — information_schema.is_nullable misses NOT NULL
            # inherited from partitioned parent tables.
            _col_query = """
                SELECT a.attname AS column_name,
                       t.typname AS data_type,
                       a.attnotnull::bool AS not_null
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_type t ON t.oid = a.atttypid
                WHERE n.nspname = $1 AND c.relname = $2
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum
            """
            src_cols  = await src_conn.fetch(_col_query, schema_name, table_name)
            dest_cols = await dest_conn.fetch(_col_query, schema_name, table_name)
            table_exists = await dest_conn.fetchval(
                    "SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
                    schema_name, table_name,
                )

            dest_col_map = {r["column_name"]: r for r in dest_cols}
            col_diffs = []
            compatible = bool(table_exists)

            for src_col in src_cols:
                cname = src_col["column_name"]
                src_type = src_col["data_type"]
                src_not_null = bool(src_col["not_null"])
                dest_col = dest_col_map.get(cname)
                type_match = bool(dest_col and dest_col["data_type"] == src_type)
                dest_not_null = bool(dest_col["not_null"]) if dest_col else None
                not_null_match = (dest_not_null == src_not_null) if dest_col else True
                match = type_match and not_null_match
                if not match:
                    compatible = False
                col_diffs.append(ColumnDiff(
                    column_name=cname,
                    source_type=src_type,
                    dest_type=dest_col["data_type"] if dest_col else None,
                    match=match,
                    source_not_null=src_not_null,
                    dest_not_null=dest_not_null,
                    not_null_match=not_null_match,
                ))

            # ── Indexes ──────────────────────────────────────────────────
            _idx_query = """
                SELECT ix.relname AS index_name,
                       ix.relname AS index_name,
                       ix.relhastriggers,
                       indisunique AS is_unique,
                       array_agg(a.attname ORDER BY k.ordinality) AS columns
                FROM pg_index i
                JOIN pg_class c ON c.oid = i.indrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_class ix ON ix.oid = i.indexrelid
                JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON k.attnum > 0
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                WHERE n.nspname = $1 AND c.relname = $2
                  AND NOT i.indisprimary
                GROUP BY ix.relname, i.indisunique, ix.relhastriggers
                ORDER BY ix.relname
            """
            src_indexes = await src_conn.fetch(_idx_query, schema_name, table_name)
            dest_indexes = await dest_conn.fetch(_idx_query, schema_name, table_name) if table_exists else []
            dest_idx_map = {r["index_name"]: list(r["columns"]) for r in dest_indexes}

            index_diffs = []
            for idx in src_indexes:
                iname = idx["index_name"]
                src_cols_list = list(idx["columns"])
                dest_cols_list = dest_idx_map.get(iname)
                cols_match = dest_cols_list == src_cols_list if dest_cols_list is not None else True
                if not cols_match:
                    compatible = False
                index_diffs.append(IndexDiff(
                    index_name=iname,
                    columns=src_cols_list,
                    is_unique=bool(idx["is_unique"]),
                    exists_on_dest=iname in dest_idx_map,
                    dest_columns=dest_cols_list,
                    columns_match=cols_match,
                ))
                if iname not in dest_idx_map:
                    compatible = False

            # ── Sequences ────────────────────────────────────────────────
            _seq_query = """
                SELECT s.relname AS sequence_name, a.attname AS column_name
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                JOIN pg_depend d ON d.refobjid = c.oid AND d.refobjsubid = a.attnum
                JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
                WHERE n.nspname = $1 AND c.relname = $2
                ORDER BY s.relname
            """
            src_seqs = await src_conn.fetch(_seq_query, schema_name, table_name)
            dest_seqs = await dest_conn.fetch(_seq_query, schema_name, table_name) if table_exists else []
            dest_seq_names = {r["sequence_name"] for r in dest_seqs}

            sequence_diffs = []
            for seq in src_seqs:
                sname = seq["sequence_name"]
                sequence_diffs.append(SequenceDiff(
                    sequence_name=sname,
                    column_name=seq["column_name"],
                    exists_on_dest=sname in dest_seq_names,
                ))

            # ── Triggers ─────────────────────────────────────────────────
            _trig_query = """
                SELECT t.tgname AS trigger_name,
                       array_to_string(ARRAY[
                           CASE WHEN (t.tgtype & 4) != 0 THEN 'INSERT' END,
                           CASE WHEN (t.tgtype & 8) != 0 THEN 'DELETE' END,
                           CASE WHEN (t.tgtype & 16) != 0 THEN 'UPDATE' END,
                           CASE WHEN (t.tgtype & 32) != 0 THEN 'TRUNCATE' END
                       ], ' OR ') AS event,
                       CASE WHEN (t.tgtype & 2) != 0 THEN 'BEFORE'
                            WHEN (t.tgtype & 64) != 0 THEN 'INSTEAD OF'
                            ELSE 'AFTER' END AS timing
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2
                  AND NOT t.tgisinternal
                ORDER BY t.tgname
            """
            src_trigs = await src_conn.fetch(_trig_query, schema_name, table_name)
            dest_trigs = await dest_conn.fetch(_trig_query, schema_name, table_name) if table_exists else []
            dest_trig_names = {r["trigger_name"] for r in dest_trigs}

            trigger_diffs = []
            for trig in src_trigs:
                trigger_diffs.append(TriggerDiff(
                    trigger_name=trig["trigger_name"],
                    event=trig["event"] or "",
                    timing=trig["timing"],
                    exists_on_dest=trig["trigger_name"] in dest_trig_names,
                ))

            # ── Constraints (CHECK, UNIQUE, FK) ──────────────────────────
            _con_query = """
                SELECT con.conname AS constraint_name,
                       CASE con.contype
                           WHEN 'c' THEN 'CHECK'
                           WHEN 'u' THEN 'UNIQUE'
                           WHEN 'f' THEN 'FOREIGN KEY'
                           WHEN 'p' THEN 'PRIMARY KEY'
                       END AS constraint_type,
                       pg_get_constraintdef(con.oid) AS definition
                FROM pg_constraint con
                JOIN pg_class c ON c.oid = con.conrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2
                  AND con.contype IN ('c','u','f','p')
                ORDER BY con.conname
            """
            src_cons = await src_conn.fetch(_con_query, schema_name, table_name)
            dest_cons = await dest_conn.fetch(_con_query, schema_name, table_name) if table_exists else []
            dest_con_map = {r["constraint_name"]: r["definition"] for r in dest_cons}

            constraint_diffs = []
            for con in src_cons:
                cname = con["constraint_name"]
                src_def = con["definition"]
                dest_def = dest_con_map.get(cname)
                def_match = (dest_def == src_def) if dest_def is not None else True
                if not def_match:
                    compatible = False
                if cname not in dest_con_map and con["constraint_type"] not in ("PRIMARY KEY",):
                    compatible = False
                constraint_diffs.append(ConstraintDiff(
                    constraint_name=cname,
                    constraint_type=con["constraint_type"],
                    definition=src_def,
                    exists_on_dest=cname in dest_con_map,
                    dest_definition=dest_def,
                    definition_match=def_match,
                ))

            results.append(TableSchemaDiff(
                table=fqn,
                exists_on_dest=bool(table_exists),
                columns=col_diffs,
                indexes=index_diffs,
                sequences=sequence_diffs,
                triggers=trigger_diffs,
                constraints=constraint_diffs,
                compatible=compatible,
            ))
    finally:
        await src_conn.close()
        await dest_conn.close()
    return results


@router.get("/schema-diff", response_model=List[TableSchemaDiff])
async def schema_diff(publication: str):
    """Compare table layouts for all tables in a publication."""
    _require_connection()
    src_pool = await get_source_pool(state.source_dsn)
    async with src_pool.acquire() as src_conn:
        pub_tables = await src_conn.fetch(
            "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1",
            publication,
        )
    if not pub_tables:
        raise HTTPException(404, f"Publication '{publication}' not found or has no tables.")
    return await _diff_table_list([(r["schemaname"], r["tablename"]) for r in pub_tables])


@router.post("/schema-check", response_model=List[TableSchemaDiff])
async def schema_check(body: dict):
    """
    Compare table layouts for an explicit list of tables (no publication required).
    Used by Replication Setup before a publication exists.
    body: { "tables": ["schema.table", ...] }
    """
    _require_connection()
    raw_tables: list[str] = body.get("tables", [])
    database: str | None = body.get("database")
    if not raw_tables:
        return []
    pairs = []
    for t in raw_tables:
        if "." not in t:
            continue
        schema, table = t.split(".", 1)
        pairs.append((schema, table))
    return await _diff_table_list(pairs, database=database)


async def _get_table_indexes(src_conn, schema_name: str, table_name: str) -> list[IndexInfo]:
    """Return non-PK, non-constraint indexes for a table on source."""
    rows = await src_conn.fetch("""
        SELECT i.relname AS index_name,
               pg_get_indexdef(ix.indexrelid) AS index_def
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class c ON c.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = $2
          AND NOT ix.indisprimary
          AND NOT EXISTS (
              SELECT 1 FROM pg_constraint con
              WHERE con.conindid = ix.indexrelid
                AND con.contype IN ('p', 'u', 'x')
              LIMIT 1
          )
        ORDER BY i.relname
    """, schema_name, table_name)
    return [
        IndexInfo(
            table=f"{schema_name}.{table_name}",
            index_name=r["index_name"],
            index_def=r["index_def"],
        )
        for r in rows
    ]


async def _add_table_constraints(src_conn, dest_conn, schema_name: str, table_name: str) -> list[dict]:
    """
    Fetch CHECK, UNIQUE, and FK constraints from source and ADD them on dest.
    PRIMARY KEY is already handled inside CREATE TABLE.
    Returns list of {name, ok, error} dicts.
    """
    rows = await src_conn.fetch("""
        SELECT con.conname,
               con.contype,
               pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND con.contype IN ('c', 'u', 'f')
        ORDER BY con.contype, con.conname
    """, schema_name, table_name)

    results = []
    for row in rows:
        cname = row["conname"]
        cdef  = row["definition"]
        try:
            await dest_conn.execute(
                f'ALTER TABLE "{schema_name}"."{table_name}" '
                f'ADD CONSTRAINT "{cname}" {cdef}'
            )
            results.append({"name": cname, "ok": True})
        except Exception as e:
            err = str(e).split("\n")[0]  # first line only
            results.append({"name": cname, "ok": False, "error": err})
    return results


@router.get("/schema-indexes")
async def list_schema_indexes(publication: str):
    """List all non-PK indexes for tables in a publication (so user can create them selectively)."""
    _require_connection()
    src_pool = await get_source_pool(state.source_dsn)

    async with src_pool.acquire() as src_conn:
        pub_tables = await src_conn.fetch(
            "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1",
            publication,
        )
        if not pub_tables:
            raise HTTPException(404, f"Publication '{publication}' not found or has no tables.")

        result = []
        for pt in pub_tables:
            idxs = await _get_table_indexes(src_conn, pt["schemaname"], pt["tablename"])
            result.extend(idxs)

    return result


@router.post("/schema/create-indexes", response_model=List[IndexCreateResult])
async def create_indexes(body: dict):
    """
    Create indexes on destination for the specified tables (or all tables in a publication).
    body: { "publication": "name" } or { "tables": ["schema.table", ...] }
    Only creates non-PK indexes that exist on source but are absent on destination.
    """
    _require_connection()
    publication = body.get("publication")
    tables_filter = set(body.get("tables") or [])

    src_pool = await get_source_pool(state.source_dsn)
    dest_pool = await get_dest_pool(state.dest_dsn)

    async with src_pool.acquire() as src_conn:
        if publication:
            pub_tables = await src_conn.fetch(
                "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1",
                publication,
            )
            table_pairs = [(r["schemaname"], r["tablename"]) for r in pub_tables]
        else:
            table_pairs = [t.split(".", 1) for t in tables_filter if "." in t]

    results: list[IndexCreateResult] = []

    async with src_pool.acquire() as src_conn:
        for schema_name, table_name in table_pairs:
            fqn = f"{schema_name}.{table_name}"
            if tables_filter and fqn not in tables_filter:
                continue
            idxs = await _get_table_indexes(src_conn, schema_name, table_name)
            for idx in idxs:
                async with dest_pool.acquire() as dest_conn:
                    already = await dest_conn.fetchval(
                        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                        "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'i'",
                        schema_name, idx.index_name,
                    )
                    if already:
                        results.append(IndexCreateResult(
                            index_name=idx.index_name, table=fqn, action="already_exists"
                        ))
                        continue
                    try:
                        await dest_conn.execute(idx.index_def)
                        results.append(IndexCreateResult(
                            index_name=idx.index_name, table=fqn, action="created"
                        ))
                    except Exception as e:
                        results.append(IndexCreateResult(
                            index_name=idx.index_name, table=fqn,
                            action="error", detail=str(e)
                        ))

    return results


@router.post("/schema-sync", response_model=List[SchemaSyncResult])
async def schema_sync(body: dict):
    """
    For each table in the publication that is missing on destination:
    1. Export DDL from source using pg_catalog (column definitions only — no sequences,
       no triggers, no policies). Indexes are NOT created — add them manually after sync.
    2. Create schema if missing on destination.
    3. CREATE TABLE on destination.

    Returns per-table action log.
    """
    _require_connection()
    publication = body.get("publication")
    tables_direct: list[str] = body.get("tables", [])
    database: str | None = body.get("database")
    if not publication and not tables_direct:
        raise HTTPException(400, "publication or tables required")
    create_indexes_when: str = body.get("create_indexes", "after")

    if publication:
        diffs = await schema_diff(publication)
    else:
        pairs = [t.split(".", 1) for t in tables_direct if "." in t]
        diffs = await _diff_table_list([(p[0], p[1]) for p in pairs], database=database)
    results = []

    import asyncpg as _asyncpg
    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn
    src_pool_conn  = await _asyncpg.connect(src_dsn,  timeout=15)
    dest_pool_conn = await _asyncpg.connect(dest_dsn, timeout=15)

    # For each missing table, fetch relkind + partition info from source.
    # Build a map: (schema, table) -> {relkind, relispartition, partkeydef, partbound, parent_schema, parent_table}
    missing_tables = [d for d in diffs if not d.exists_on_dest]
    table_meta: dict[tuple[str, str], dict] = {}
    for d in missing_tables:
        s, t = d.table.split(".", 1)
        row = await src_pool_conn.fetchrow("""
            SELECT c.relkind,
                   c.relispartition,
                   pg_get_partkeydef(c.oid)          AS partkeydef,
                   pg_get_expr(c.relpartbound, c.oid) AS partbound,
                   pn.nspname                          AS parent_schema,
                   pc.relname                          AS parent_table
            FROM pg_class c
            JOIN pg_namespace n  ON n.oid = c.relnamespace
            LEFT JOIN pg_inherits  inh ON inh.inhrelid  = c.oid
            LEFT JOIN pg_class  pc  ON pc.oid  = inh.inhparent
            LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2
        """, s, t)
        if row:
            table_meta[(s, t)] = dict(row)

    def _relkind(v) -> str:
        if isinstance(v, (bytes, bytearray)):
            return v.decode()
        return v or ""

    # Sort: partitioned parents first, then plain tables, then child partitions last
    def sort_key(d):
        s, t = d.table.split(".", 1)
        meta = table_meta.get((s, t), {})
        if _relkind(meta.get("relkind")) == "p":  return 0  # partitioned parent
        if meta.get("relispartition"):        return 2  # child partition
        return 1                                        # plain table

    diffs = sorted(diffs, key=sort_key)

    rebuilt_parents: set[tuple[str, str]] = set()  # track parents already rebuilt

    for diff in diffs:
        if diff.exists_on_dest:
            if diff.compatible:
                results.append(SchemaSyncResult(table=diff.table, action="already_exists"))
            else:
                mismatched = [c.column_name for c in diff.columns if not c.match]
                results.append(SchemaSyncResult(
                    table=diff.table,
                    action="incompatible",
                    detail=f"Mismatched or missing columns: {', '.join(mismatched)}",
                ))
            continue

        schema_name, table_name = diff.table.split(".", 1)

        try:
            # Build CREATE TABLE DDL from pg_catalog on source
            src_conn = src_pool_conn
            cols = await src_conn.fetch("""
                    SELECT
                        a.attname AS col,
                        pg_catalog.format_type(a.atttypid, a.atttypmod) AS col_type,
                        a.attnotnull::bool AS not_null,
                        pg_get_expr(d.adbin, d.adrelid) AS col_default,
                        a.attidentity::text AS identity
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE n.nspname = $1
                      AND c.relname = $2
                      AND a.attnum > 0
                      AND NOT a.attisdropped
                    ORDER BY a.attnum
                """, schema_name, table_name)

            pk_cols = await src_conn.fetch("""
                    SELECT a.attname
                    FROM pg_index i
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                    JOIN pg_class c ON c.oid = i.indrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE i.indisprimary
                      AND n.nspname = $1 AND c.relname = $2
                    ORDER BY array_position(i.indkey, a.attnum)
                """, schema_name, table_name)

            # Use pre-fetched partition metadata (avoids redundant queries)
            partition_info = table_meta.get((schema_name, table_name), {})

            def qi(name: str) -> str:
                return '"' + name.replace('"', '""') + '"'

            col_defs = []
            for c in cols:
                col_def = f"  {qi(c['col'])} {c['col_type']}"
                if c["identity"] == "a":
                    col_def += " GENERATED ALWAYS AS IDENTITY"
                elif c["identity"] == "d":
                    col_def += " GENERATED BY DEFAULT AS IDENTITY"
                elif c["col_default"] and "nextval" not in (c["col_default"] or ""):
                    col_def += f" DEFAULT {c['col_default']}"
                if c["not_null"] and not c["identity"]:
                    col_def += " NOT NULL"
                col_defs.append(col_def)

            is_partitioned = partition_info and _relkind(partition_info.get("relkind")) == "p"
            is_partition   = partition_info and partition_info["relispartition"]

            if is_partitioned:
                # Partitioned table — no PK in parent, add PARTITION BY
                partkeydef = partition_info["partkeydef"]
                ddl = (
                    f'CREATE TABLE IF NOT EXISTS "{schema_name}"."{table_name}" (\n'
                    + ",\n".join(col_defs)
                    + f"\n) PARTITION BY {partkeydef};"
                )
            elif is_partition:
                # Child partition — PARTITION OF syntax, no column list needed
                parent_schema = partition_info["parent_schema"]
                parent_table  = partition_info["parent_table"]
                partbound     = partition_info["partbound"]
                ddl = (
                    f'CREATE TABLE IF NOT EXISTS "{schema_name}"."{table_name}" '
                    f'PARTITION OF "{parent_schema}"."{parent_table}" {partbound};'
                )
            else:
                if pk_cols:
                    pk_list = ", ".join(qi(r["attname"]) for r in pk_cols)
                    col_defs.append(f"  PRIMARY KEY ({pk_list})")
                ddl = (
                    f'CREATE TABLE IF NOT EXISTS "{schema_name}"."{table_name}" (\n'
                    + ",\n".join(col_defs)
                    + "\n);"
                )

            await dest_pool_conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema_name}"')

            # If this is a partition, verify the parent table on dest is actually partitioned.
            # If not (e.g. created incorrectly as a plain table), drop and recreate it.
            if is_partition and partition_info.get("parent_schema") and partition_info.get("parent_table"):
                ps, pt = partition_info["parent_schema"], partition_info["parent_table"]
                if (ps, pt) not in rebuilt_parents:
                    rebuilt_parents.add((ps, pt))  # mark before any work to prevent repeat
                    parent_relkind = await dest_pool_conn.fetchval("""
                        SELECT c.relkind FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = $1 AND c.relname = $2
                    """, ps, pt)
                    if _relkind(parent_relkind) != 'p':
                        # Parent exists but is not partitioned — rebuild
                        await dest_pool_conn.execute(f'DROP TABLE IF EXISTS "{ps}"."{pt}" CASCADE')
                        parent_cols = await src_pool_conn.fetch("""
                            SELECT a.attname AS col,
                                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS col_type,
                                   a.attnotnull AS not_null,
                                   pg_get_expr(d.adbin, d.adrelid) AS col_default,
                                   a.attidentity AS identity
                            FROM pg_attribute a
                            JOIN pg_class c ON c.oid = a.attrelid
                            JOIN pg_namespace n ON n.oid = c.relnamespace
                            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                            WHERE n.nspname = $1 AND c.relname = $2
                              AND a.attnum > 0 AND NOT a.attisdropped
                            ORDER BY a.attnum
                        """, ps, pt)
                        parent_partkey = await src_pool_conn.fetchval(
                            "SELECT pg_get_partkeydef(c.oid) FROM pg_class c "
                            "JOIN pg_namespace n ON n.oid = c.relnamespace "
                            "WHERE n.nspname = $1 AND c.relname = $2", ps, pt)
                        if parent_partkey:
                            p_col_defs = [f"  {qi(c['col'])} {c['col_type']}" for c in parent_cols]
                            parent_ddl = (f'CREATE TABLE "{ps}"."{pt}" (\n'
                                          + ",\n".join(p_col_defs)
                                          + f"\n) PARTITION BY {parent_partkey};")
                            await dest_pool_conn.execute(parent_ddl)

            await dest_pool_conn.execute(ddl)
            # Child partitions are NOT created here — they appear as separate
            # entries in diffs (sorted after their parent) and are created
            # individually. Creating them here would duplicate work and cause
            # the second partition to be dropped when rebuilding the parent.

            # Index strategy:
            # - Partitioned parent (relkind='p'): always create indexes immediately —
            #   PostgreSQL automatically propagates them to all child partitions,
            #   so they must exist before data arrives via replication.
            # - Child partition (relispartition=True): skip — indexes are inherited
            #   from the parent; creating them separately causes duplicates.
            # - Plain table: respect create_indexes_when setting.
            index_results: list[IndexInfo] = []
            should_create_indexes = (
                is_partitioned or  # always before for partitioned parents
                (not is_partition and create_indexes_when == "before")
            )
            if should_create_indexes and not is_partition:
                idx_list = await _get_table_indexes(src_pool_conn, schema_name, table_name)
                for idx in idx_list:
                    try:
                        await dest_pool_conn.execute("SET statement_timeout = '300s'")
                        await dest_pool_conn.execute(idx.index_def)
                        index_results.append(idx)
                    except Exception:
                        pass

            # Add CHECK, UNIQUE, FK constraints (PK already in CREATE TABLE)
            con_results = []
            if not is_partition:
                con_results = await _add_table_constraints(src_pool_conn, dest_pool_conn, schema_name, table_name)
            con_failed = [r for r in con_results if not r["ok"]]
            con_ok     = [r for r in con_results if r["ok"]]

            base_detail = (
                f"Partitioned table created with {len(index_results)} index(es) (propagated to partitions)."
                if is_partitioned and index_results
                else f"Table created with {len(index_results)} index(es)."
                if index_results
                else "Table created (no additional indexes on source)."
                if is_partition or create_indexes_when == "before"
                else "Table created. Indexes NOT created — use 'Create indexes' after replication completes."
            )
            if con_ok:
                base_detail += f" Constraints added: {', '.join(r['name'] for r in con_ok)}."
            if con_failed:
                base_detail += f" Constraints FAILED: " + "; ".join(f"{r['name']}: {r.get('error','?')}" for r in con_failed) + "."

            results.append(SchemaSyncResult(
                table=diff.table,
                action="created",
                detail=base_detail,
                indexes=index_results,
            ))

        except Exception as e:
            import logging as _log
            _log.getLogger("uvicorn.error").error(f"schema_sync error for {diff.table}: {e}")
            results.append(SchemaSyncResult(
                table=diff.table,
                action="error",
                detail=str(e),
            ))

    await src_pool_conn.close()
    await dest_pool_conn.close()
    return results


@router.post("/schema-drop-recreate", response_model=List[SchemaSyncResult])
async def schema_drop_recreate(body: dict):
    """
    Drop and recreate tables on destination that exist but have incompatible columns.
    body: { "tables": ["schema.table", ...], "database": "dbname" }
    USE WITH CAUTION — drops existing destination tables.
    """
    _require_connection()
    tables_direct: list[str] = body.get("tables", [])
    database: str | None = body.get("database")
    if not tables_direct:
        raise HTTPException(400, "tables required")

    pairs = [t.split(".", 1) for t in tables_direct if "." in t]
    # Run diff to get current state
    diffs = await _diff_table_list([(p[0], p[1]) for p in pairs], database=database)

    import asyncpg as _asyncpg
    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn
    src_conn  = await _asyncpg.connect(src_dsn,  timeout=15)
    dest_conn_dr = await _asyncpg.connect(dest_dsn, timeout=15)
    results = []

    try:
        for diff in diffs:
            if not diff.exists_on_dest:
                results.append(SchemaSyncResult(table=diff.table, action="already_exists", detail="Table does not exist on dest — use schema-sync instead"))
                continue
            schema_name, table_name = diff.table.split(".", 1)
            try:
                # Drop on destination
                await dest_conn_dr.execute(f'DROP TABLE IF EXISTS "{schema_name}"."{table_name}" CASCADE')

                # Recreate — reuse same DDL logic as schema_sync
                cols = await src_conn.fetch("""
                    SELECT a.attname AS col,
                           pg_catalog.format_type(a.atttypid, a.atttypmod) AS col_type,
                           a.attnotnull::bool AS not_null,
                           pg_get_expr(d.adbin, d.adrelid) AS col_default,
                           a.attidentity::text AS identity
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE n.nspname = $1 AND c.relname = $2
                      AND a.attnum > 0 AND NOT a.attisdropped
                    ORDER BY a.attnum
                """, schema_name, table_name)

                pk_cols = await src_conn.fetch("""
                    SELECT a.attname
                    FROM pg_index i
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                    JOIN pg_class c ON c.oid = i.indrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2
                    ORDER BY array_position(i.indkey, a.attnum)
                """, schema_name, table_name)

                def _qi(n: str) -> str:
                    return '"' + n.replace('"', '""') + '"'

                def _relkind(v) -> str:
                    if isinstance(v, (bytes, bytearray)): return v.decode()
                    return v or ""

                col_defs = []
                for c in cols:
                    col_def = f"  {_qi(c['col'])} {c['col_type']}"
                    if c["identity"] == "a":
                        col_def += " GENERATED ALWAYS AS IDENTITY"
                    elif c["identity"] == "d":
                        col_def += " GENERATED BY DEFAULT AS IDENTITY"
                    elif c["col_default"] and "nextval" not in (c["col_default"] or ""):
                        col_def += f" DEFAULT {c['col_default']}"
                    if c["not_null"] and not c["identity"]:
                        col_def += " NOT NULL"
                    col_defs.append(col_def)

                # Check if table is a partitioned parent or child partition on source
                part_row = await src_conn.fetchrow("""
                    SELECT c.relkind, c.relispartition,
                           pg_get_partkeydef(c.oid) AS partkeydef,
                           pg_get_expr(c.relpartbound, c.oid) AS partbound,
                           pn.nspname AS parent_schema, pc.relname AS parent_table
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid
                    LEFT JOIN pg_class pc ON pc.oid = inh.inhparent
                    LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                    WHERE n.nspname = $1 AND c.relname = $2
                """, schema_name, table_name)

                rk = _relkind(part_row["relkind"]) if part_row else "r"
                is_part_parent = rk == "p"
                is_part_child  = bool(part_row and part_row["relispartition"])

                if is_part_child:
                    ps = part_row["parent_schema"]
                    pt = part_row["parent_table"]
                    pb = part_row["partbound"]
                    ddl = (f'CREATE TABLE "{schema_name}"."{table_name}" '
                           f'PARTITION OF "{ps}"."{pt}" {pb};')
                elif is_part_parent:
                    pkdef = part_row["partkeydef"]
                    ddl = (f'CREATE TABLE "{schema_name}"."{table_name}" (\n'
                           + ",\n".join(col_defs)
                           + f"\n) PARTITION BY {pkdef};")
                else:
                    if pk_cols:
                        col_defs.append(f"  PRIMARY KEY ({', '.join(_qi(r['attname']) for r in pk_cols)})")
                    ddl = (f'CREATE TABLE "{schema_name}"."{table_name}" (\n'
                           + ",\n".join(col_defs) + "\n);")

                await dest_conn_dr.execute(ddl)

                # Add CHECK, UNIQUE, FK constraints (PK already in CREATE TABLE)
                con_results = []
                if not is_part_child:
                    con_results = await _add_table_constraints(src_conn, dest_conn_dr, schema_name, table_name)
                con_failed = [r for r in con_results if not r["ok"]]
                con_ok     = [r for r in con_results if r["ok"]]
                detail = "Dropped and recreated."
                if con_ok:
                    detail += f" Constraints added: {', '.join(r['name'] for r in con_ok)}."
                if con_failed:
                    detail += f" Constraints FAILED: " + "; ".join(f"{r['name']}: {r.get('error','?')}" for r in con_failed) + "."

                results.append(SchemaSyncResult(table=diff.table, action="created", detail=detail))
            except Exception as e:
                results.append(SchemaSyncResult(table=diff.table, action="error", detail=str(e)))
    finally:
        await src_conn.close()
        await dest_conn_dr.close()

    return results


# ── Fix NOT NULL constraints ──────────────────────────────────────────────────

@router.post("/schema-fix-not-null")
async def schema_fix_not_null(body: dict):
    """
    Alter columns on destination to match NOT NULL constraints from source.
    body: {
      "tables": ["schema.table", ...],
      "database": "dbname",
      "strategy": "not_valid" | "direct"   (default: "not_valid")
    }

    Strategies:
      not_valid — ADD CHECK (col IS NOT NULL) NOT VALID
                  No table scan, no long lock. Enforces constraint for new data only.
                  Safe for large tables (400 GB+). Can be validated later.
      direct    — ALTER COLUMN SET NOT NULL
                  Scans entire table, holds AccessExclusiveLock. Only for small tables.
    """
    _require_connection()
    import asyncpg as _asyncpg

    tables: list[str] = body.get("tables", [])
    database: str | None = body.get("database")
    strategy: str = body.get("strategy", "not_valid")
    if not tables:
        raise HTTPException(400, "No tables specified.")
    if strategy not in ("not_valid", "direct"):
        raise HTTPException(400, "strategy must be 'not_valid' or 'direct'")

    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn
    src_conn  = await _asyncpg.connect(src_dsn,  timeout=15)
    dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)

    fix_results = []
    try:
        for qualified in tables:
            if "." not in qualified:
                fix_results.append({"table": qualified, "ok": False, "error": "Invalid table name", "changes": []})
                continue
            schema, table = qualified.split(".", 1)

            src_cols = await src_conn.fetch("""
                SELECT column_name, is_nullable = 'NO' AS not_null
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position
            """, schema, table)

            dest_cols = await dest_conn.fetch("""
                SELECT column_name, is_nullable = 'NO' AS not_null
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position
            """, schema, table)

            # Also fetch existing CHECK constraints to avoid duplicates
            existing_checks = await dest_conn.fetch("""
                SELECT conname FROM pg_constraint
                JOIN pg_class c ON c.oid = conrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2 AND contype = 'c'
            """, schema, table)
            existing_check_names = {r["conname"] for r in existing_checks}

            dest_map = {r["column_name"]: bool(r["not_null"]) for r in dest_cols}
            changes = []
            errors = []

            for sc in src_cols:
                col = sc["column_name"]
                src_nn = bool(sc["not_null"])
                dest_nn = dest_map.get(col)
                if dest_nn is None or src_nn == dest_nn:
                    continue

                if src_nn:
                    # Need to add NOT NULL
                    if strategy == "not_valid":
                        # CHECK (col IS NOT NULL) NOT VALID — no scan, no long lock
                        cname = f"{table}_{col}_not_null"[:63]
                        if cname in existing_check_names:
                            changes.append({"column": col, "action": "CHECK NOT VALID (already exists)", "ok": True})
                            continue
                        sql = (f'ALTER TABLE "{schema}"."{table}" '
                               f'ADD CONSTRAINT "{cname}" CHECK ("{col}" IS NOT NULL) NOT VALID')
                        action_label = f"ADD CHECK ({col} IS NOT NULL) NOT VALID"
                    else:
                        sql = f'ALTER TABLE "{schema}"."{table}" ALTER COLUMN "{col}" SET NOT NULL'
                        action_label = "SET NOT NULL"
                else:
                    # Need to drop NOT NULL — always direct (fast, no scan needed)
                    sql = f'ALTER TABLE "{schema}"."{table}" ALTER COLUMN "{col}" DROP NOT NULL'
                    action_label = "DROP NOT NULL"

                try:
                    await dest_conn.execute(sql)
                    changes.append({"column": col, "action": action_label, "ok": True})
                except Exception as e:
                    changes.append({"column": col, "action": action_label, "ok": False, "error": str(e)})
                    errors.append(str(e))

            fix_results.append({
                "table": qualified,
                "ok": len(errors) == 0,
                "changes": changes,
                "error": "; ".join(errors) if errors else None,
            })
    finally:
        await src_conn.close()
        await dest_conn.close()


@router.post("/schema-copy-functions")
async def schema_copy_functions(body: dict):
    """
    body: { "function_names": ["check_epoch_type", ...], "database": "dbname" }
    Looks up each function by name on source (all schemas, all overloads),
    gets its full DDL via pg_get_functiondef(), creates it on dest with
    CREATE OR REPLACE FUNCTION.
    Returns list of { name, ok, error, ddl }.
    """
    _require_connection()
    func_names: list[str] = body.get("function_names", [])
    database: str | None = body.get("database")
    if not func_names:
        raise HTTPException(400, "function_names required")

    import asyncpg as _asyncpg
    src_dsn  = dsn_for_database(state.source_dsn, database) if database else state.source_dsn
    dest_dsn = dsn_for_database(state.dest_dsn,   database) if database else state.dest_dsn
    src_conn  = await _asyncpg.connect(src_dsn,  timeout=15)
    dest_conn = await _asyncpg.connect(dest_dsn, timeout=15)

    results = []
    try:
        for fname in func_names:
            rows = await src_conn.fetch("""
                SELECT n.nspname AS schema_name,
                       p.proname AS func_name,
                       pg_get_functiondef(p.oid) AS func_def
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.proname = $1
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                ORDER BY n.nspname, p.proname
            """, fname)

            if not rows:
                results.append({"name": fname, "ok": False, "error": "Function not found on source", "ddl": None})
                continue

            for row in rows:
                qname = f"{row['schema_name']}.{row['func_name']}"
                ddl = row["func_def"]
                try:
                    await dest_conn.execute(ddl)
                    results.append({"name": qname, "ok": True, "ddl": ddl})
                except Exception as e:
                    err = str(e).split("\n")[0]
                    results.append({"name": qname, "ok": False, "error": err, "ddl": ddl})
    finally:
        await src_conn.close()
        await dest_conn.close()

    return results

    return fix_results
