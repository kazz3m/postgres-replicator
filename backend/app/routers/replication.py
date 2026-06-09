import re
from fastapi import APIRouter, HTTPException
from typing import List, Optional
from ..models.schemas import (
    PublicationConfig, SubscriptionConfig, ReplicationStatus,
    ReplicationSlotInfo, SubscriptionStatus, TableReplicationProgress,
    SequenceInfo, TableSchemaDiff, ColumnDiff, SchemaSyncResult,
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
async def drop_publication(name: str):
    _require_connection()
    pool = await get_source_pool(state.source_dsn)
    async with pool.acquire() as conn:
        await conn.execute(f'DROP PUBLICATION IF EXISTS "{name}"')
    return {"status": "dropped", "name": name}


@router.get("/publication-config")
async def get_publication_config(name: str):
    """
    Load full configuration for an existing publication: tables/schemas it covers,
    plus all linked subscriptions on destination. Used by UI to pre-fill Setup page.
    """
    _require_connection()
    src_pool = await get_source_pool(state.source_dsn)
    dest_pool = await get_dest_pool(state.dest_dsn)

    async with src_pool.acquire() as src_conn:
        version_num = await src_conn.fetchval("SELECT current_setting('server_version_num')::int")
        major = version_num // 10000
        database = await src_conn.fetchval("SELECT current_database()")

        pub = await src_conn.fetchrow(
            "SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete "
            "FROM pg_publication WHERE pubname = $1", name
        )
        if not pub:
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
    async with dest_pool.acquire() as dest_conn:
        try:
            subs = await dest_conn.fetch(
                "SELECT subname, subenabled, subslotname "
                "FROM pg_subscription WHERE $1 = ANY(subpublications)",
                name,
            )
        except Exception:
            # pg_subscription requires superuser or pg_monitor — fall back gracefully
            try:
                # pg_stat_subscription is accessible to non-superusers
                subs = await dest_conn.fetch(
                    "SELECT s.subname, true AS subenabled, NULL::text AS subslotname "
                    "FROM pg_stat_subscription s "
                    "WHERE s.subname IS NOT NULL "
                    "GROUP BY s.subname",
                )
            except Exception:
                subs = []

    return {
        "pub_name": name,
        "database": database,
        "puballtables": pub["puballtables"],
        "tables": [f"{r['schemaname']}.{r['tablename']}" for r in tables],
        "schemas": schemas,
        "subscriptions": [
            {
                "sub_name": r["subname"],
                "enabled": r["subenabled"],
                "slot_name": r["subslotname"],
            }
            for r in subs
        ],
    }


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

        exists = await dest_db_conn.fetchval(
            "SELECT 1 FROM pg_subscription WHERE subname = $1", config.subscription_name
        )
        if exists:
            await dest_db_conn.execute(
                f'ALTER SUBSCRIPTION "{config.subscription_name}" DISABLE'
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

    async def _do_create_subscription() -> None:
        dedicated_conn = None
        try:
            dedicated_conn = await _asyncpg.connect(dest_dsn_db, timeout=15)
            copy_data_sql = "true" if config.copy_data else "false"
            await dedicated_conn.execute("SET statement_timeout = '30s'")
            await dedicated_conn.execute(f"""
                CREATE SUBSCRIPTION "{config.subscription_name}"
                CONNECTION $conn_str${conn_dsn}$conn_str$
                PUBLICATION "{config.publication_name}"
                WITH (copy_data = {copy_data_sql})
            """)
        finally:
            if dedicated_conn:
                try:
                    await dedicated_conn.close()
                except Exception:
                    pass

    try:
        await _do_create_subscription()
    except Exception as e:
        err = str(e)
        # Orphaned slot from a previous failed attempt — drop it and retry once
        if "replication slot" in err and "already exists" in err:
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
async def drop_subscription(name: str):
    _require_connection()
    dest_pool = await get_dest_pool(state.dest_dsn)
    src_pool = await get_source_pool(state.source_dsn)

    async with dest_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT subslotname, subenabled FROM pg_subscription WHERE subname = $1", name
        )
        if not row:
            raise HTTPException(404, f"Subscription '{name}' not found.")
        slot_name = row["subslotname"]

        # Fix #6: DISABLE must succeed before DROP when subscription is enabled.
        # An active replication slot cannot be dropped while the apply worker holds it.
        if row["subenabled"]:
            try:
                await conn.execute(f'ALTER SUBSCRIPTION "{name}" DISABLE')
            except Exception as e:
                raise HTTPException(
                    500,
                    f"Could not disable subscription '{name}' before dropping: {e}. "
                    f"The subscription may still be active. Retry or disable it manually."
                )
        await conn.execute(f'DROP SUBSCRIPTION IF EXISTS "{name}"')

    # Drop orphaned slot on source if DROP SUBSCRIPTION didn't clean it up
    if slot_name:
        async with src_pool.acquire() as conn:
            still_exists = await conn.fetchval(
                "SELECT 1 FROM pg_replication_slots WHERE slot_name = $1", slot_name
            )
            if still_exists:
                try:
                    await conn.execute("SELECT pg_drop_replication_slot($1)", slot_name)
                except Exception:
                    pass

    return {"status": "dropped", "name": name}


@router.get("/subscriptions")
async def list_subscriptions():
    _require_connection()
    pool = await get_dest_pool(state.dest_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT subname, subenabled, subpublications, subslotname
            FROM pg_subscription
        """)
    return [dict(r) for r in rows]


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
async def list_slots():
    _require_connection()
    pool = await get_source_pool(state.source_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT slot_name, plugin, slot_type, active,
                   restart_lsn::text, confirmed_flush_lsn::text,
                   COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0) AS lag_bytes
            FROM pg_replication_slots
        """)
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
    repl_state_map = {r["application_name"]: r["state"] for r in repl_rows}
    # Only keep real subscription slots (exclude worker sync slots)
    slot_map = {
        r["slot_name"]: r for r in slot_rows
        if not _sync_worker_slot.match(r["slot_name"])
    }

    # Get all destination databases
    dest_pool_default = await get_dest_pool(state.dest_dsn)
    async with dest_pool_default.acquire() as _dc:
        dest_db_names = [r["datname"] for r in await _dc.fetch("""
            SELECT datname FROM pg_database
            WHERE datistemplate = false AND datname NOT IN ('postgres', 'template0', 'template1')
            ORDER BY datname
        """)]

    state_label = {'i':'initializing','d':'copying','f':'catching up','s':'synced','r':'ready','e':'error'}

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
            COALESCE(s.subslotname, s.subname) AS slot_name,
            current_database() AS database,
            n.nspname  AS schema_name,
            c.relname  AS table_name,
            c.oid      AS table_oid,
            sr.srsubstate AS sub_state,
            COALESCE(cp.tuples_processed, 0)             AS tuples_done,
            COALESCE(NULLIF(c.reltuples::bigint, -1), 0) AS tuples_total,
            COALESCE(cp.bytes_processed, 0)              AS bytes_processed,
            COALESCE(pg_relation_size(c.oid), 0)         AS table_size_bytes,
            GREATEST(psu.last_analyze, psu.last_autoanalyze) AS last_analyze
        FROM pg_subscription_rel sr
        JOIN pg_subscription s   ON s.oid  = sr.srsubid
        JOIN pg_class       c    ON c.oid  = sr.srrelid
        JOIN pg_namespace   n    ON n.oid  = c.relnamespace
        LEFT JOIN pg_stat_progress_copy cp  ON cp.relid  = c.oid
        LEFT JOIN pg_stat_user_tables   psu ON psu.relid = c.oid
        ORDER BY s.subname, n.nspname, c.relname
    """

    # Group rows by sub_name -> SubscriptionProgress
    subs_by_name: dict[str, SubscriptionProgress] = {}
    global_copying = False

    for db_name in dest_db_names:
        db_dsn = dsn_for_database(state.dest_dsn, db_name)
        try:
            db_conn = await _asyncpg.connect(db_dsn, timeout=10)
        except Exception:
            continue
        try:
            rows = await db_conn.fetch(MAIN_QUERY)
        except Exception:
            rows = []
        finally:
            await db_conn.close()

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
                    repl_state=repl_state_map.get(slot_name),
                    tables=[],
                    copying_active=False,
                )

            sub_state = _decode_state(r["sub_state"])
            tuples_done, tuples_total = r["tuples_done"], r["tuples_total"]
            copy_pct: Optional[float] = None
            if sub_state == 'd' and tuples_total > 0:
                copy_pct = min(100.0, tuples_done / tuples_total * 100)
            elif sub_state in ('f', 's', 'r'):
                copy_pct = 100.0
            if sub_state == 'd':
                subs_by_name[sub_name].copying_active = True
                global_copying = True
            last_analyze = r["last_analyze"]
            subs_by_name[sub_name].tables.append(TableCopyProgress(
                schema_name=r["schema_name"], table_name=r["table_name"],
                table_oid=r["table_oid"],
                row_estimate=tuples_total if tuples_total and tuples_total > 0 else None,
                sub_state=sub_state, status=state_label.get(sub_state, 'unknown'),
                tuples_done=tuples_done if sub_state == 'd' else None,
                tuples_total=tuples_total if sub_state == 'd' else None,
                bytes_processed=r["bytes_processed"] if sub_state == 'd' else None,
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
                repl_state=repl_state_map.get(slot_name),
                tables=[],
                copying_active=False,
            )

    subscriptions = sorted(subs_by_name.values(), key=lambda s: s.sub_name)

    return CopyProgressResponse(subscriptions=subscriptions, copying_active=global_copying)


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
                       pg_relation_size(c.oid) AS size_bytes,
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
                   c.relpages::bigint * current_setting('block_size')::bigint AS size_bytes,
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

        # replica identity
        replica_id = await src_conn.fetchrow("""
            SELECT CASE c.relreplident
                WHEN 'd' THEN 'default (PK)'
                WHEN 'f' THEN 'full'
                WHEN 'i' THEN 'index'
                WHEN 'n' THEN 'nothing'
                ELSE c.relreplident::text
            END AS replica_identity
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2
        """, schema, table)
        result["replica_identity"] = replica_id["replica_identity"] if replica_id else None

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
                   c.relpages::bigint * current_setting('block_size')::bigint AS size_bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        """)
        await conn.close()
    except Exception as e:
        raise HTTPException(502, f"Cannot connect to source database '{database}': {e}")
    return {r["qualified"]: r["size_bytes"] for r in rows}


# ── Analyze ───────────────────────────────────────────────────────────────────

@router.post("/analyze")
async def analyze_tables(body: dict):
    """Run ANALYZE on specified tables on destination. tables: ["schema.table", ...]"""
    _require_connection()
    tables: list = body.get("tables", [])
    if not tables:
        raise HTTPException(400, "No tables specified.")
    dest_pool = await get_dest_pool(state.dest_dsn)
    results = []
    async with dest_pool.acquire() as conn:
        for t in tables:
            try:
                parts = t.split(".", 1)
                if len(parts) != 2:
                    raise ValueError(f"Expected schema.table, got: {t}")
                schema, table = parts
                await conn.execute(f'ANALYZE "{schema}"."{table}"')
                results.append({"table": t, "ok": True})
            except Exception as e:
                results.append({"table": t, "ok": False, "error": str(e)})
    return {"results": results}


# ── Reset ─────────────────────────────────────────────────────────────────────

@router.post("/reset/{subscription_name}")
async def reset_replication(subscription_name: str):
    """Drop subscription + slot, then recreate from scratch (destructive)."""
    _require_connection()
    dest_pool = await get_dest_pool(state.dest_dsn)
    src_pool = await get_source_pool(state.source_dsn)

    async with dest_pool.acquire() as conn:
        # Avoid reading subconninfo — requires superuser on Cloud SQL / restricted envs.
        # Use state.source_repl_dsn (or source_dsn) as the connection string on recreate.
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

    conn_dsn = state.source_repl_dsn if state.source_repl_dsn else state.source_dsn
    if not re.match(r'^postgres(ql)?://', conn_dsn):
        raise HTTPException(400, "Replication DSN is missing or invalid. Reconnect and try again.")
    if "$conn_str$" in conn_dsn:
        raise HTTPException(500, "Connection DSN contains illegal sequence, cannot recreate subscription.")

    pub_list = ", ".join(f'"{p}"' for p in publications)
    import asyncpg as _asyncpg
    dedicated_conn = None
    try:
        dedicated_conn = await _asyncpg.connect(state.dest_dsn, timeout=15)
        await dedicated_conn.execute("SET statement_timeout = '30s'")
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

    return {"status": "reset", "subscription_name": subscription_name}


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
async def stop_subscription(name: str):
    """
    Gracefully stop replication: DISABLE subscription on dest, drop slot on source.
    Leaves tables and data intact. Use reset to restart from scratch.
    """
    _require_connection()
    dest_pool = await get_dest_pool(state.dest_dsn)
    src_pool = await get_source_pool(state.source_dsn)

    async with dest_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT subslotname, subenabled FROM pg_subscription WHERE subname = $1", name
        )
        if not row:
            raise HTTPException(404, f"Subscription '{name}' not found.")

        if row["subenabled"]:
            try:
                await conn.execute(f'ALTER SUBSCRIPTION "{name}" DISABLE')
            except Exception as e:
                raise HTTPException(500, f"Could not disable subscription: {e}")

        slot_name = row["subslotname"]

    # Detach slot so source can clean up WAL; slot name stays in pg_subscription
    # but replication stops. We use SET slot_name = NONE to detach gracefully.
    async with dest_pool.acquire() as conn:
        try:
            await conn.execute(f'ALTER SUBSCRIPTION "{name}" SET (slot_name = NONE)')
        except Exception:
            pass

    if slot_name:
        async with src_pool.acquire() as conn:
            still_exists = await conn.fetchval(
                "SELECT 1 FROM pg_replication_slots WHERE slot_name = $1", slot_name
            )
            if still_exists:
                try:
                    await conn.execute("SELECT pg_drop_replication_slot($1)", slot_name)
                except Exception as e:
                    raise HTTPException(500, f"Could not drop replication slot '{slot_name}': {e}")

    return {"status": "stopped", "subscription_name": name, "slot_dropped": bool(slot_name)}


# ── Add table to publication ──────────────────────────────────────────────────

@router.post("/publication/{pub_name}/add-table")
async def add_table_to_publication(pub_name: str, body: dict):
    """
    ALTER PUBLICATION pub ADD TABLE schema.table
    Then issues ALTER SUBSCRIPTION sub REFRESH PUBLICATION on all subscriptions
    that reference this publication.
    """
    _require_connection()
    table = body.get("table")  # "schema.table"
    if not table or "." not in table:
        raise HTTPException(400, "table must be 'schema.table'")

    src_pool = await get_source_pool(state.source_dsn)
    async with src_pool.acquire() as conn:
        # Validate publication exists
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_publication WHERE pubname = $1", pub_name
        )
        if not exists:
            raise HTTPException(404, f"Publication '{pub_name}' not found.")

        # Validate + quote table name safely
        schema, tname = table.split(".", 1)
        safe = await conn.fetchval(
            "SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) "
            "FROM information_schema.tables "
            "WHERE table_schema = $1 AND table_name = $2",
            schema, tname,
        )
        if not safe:
            raise HTTPException(400, f"Table '{table}' does not exist on source.")

        await conn.execute(f'ALTER PUBLICATION "{pub_name}" ADD TABLE {safe}')

    # Refresh all subscriptions on dest that reference this publication
    dest_pool = await get_dest_pool(state.dest_dsn)
    refreshed = []
    async with dest_pool.acquire() as conn:
        subs = await conn.fetch(
            "SELECT subname FROM pg_subscription WHERE $1 = ANY(subpublications)", pub_name
        )
        for sub in subs:
            try:
                await conn.execute(f'ALTER SUBSCRIPTION "{sub["subname"]}" REFRESH PUBLICATION')
                refreshed.append(sub["subname"])
            except Exception as e:
                raise HTTPException(500, f"Could not refresh subscription '{sub['subname']}': {e}")

    return {
        "status": "ok",
        "publication": pub_name,
        "table_added": table,
        "subscriptions_refreshed": refreshed,
    }


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

            src_cols = await src_conn.fetch("""
                SELECT column_name, udt_name AS data_type
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position
            """, schema_name, table_name)

            dest_cols = await dest_conn.fetch("""
                    SELECT column_name, udt_name AS data_type
                    FROM information_schema.columns
                    WHERE table_schema = $1 AND table_name = $2
                    ORDER BY ordinal_position
                """, schema_name, table_name)
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
                dest_col = dest_col_map.get(cname)
                match = bool(dest_col and dest_col["data_type"] == src_type)
                if not match:
                    compatible = False
                col_diffs.append(ColumnDiff(
                    column_name=cname,
                    source_type=src_type,
                    dest_type=dest_col["data_type"] if dest_col else None,
                    match=match,
                ))

            results.append(TableSchemaDiff(
                table=fqn,
                exists_on_dest=bool(table_exists),
                columns=col_diffs,
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
          AND NOT ix.indisunique OR ix.indisunique  -- include all non-PK
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
        """Normalize pg relkind — asyncpg may return bytes on some platforms."""
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
                        a.attnotnull AS not_null,
                        pg_get_expr(d.adbin, d.adrelid) AS col_default,
                        a.attidentity AS identity
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
                        await dest_pool_conn.execute(idx.index_def)
                        index_results.append(idx)
                    except Exception:
                        pass

            results.append(SchemaSyncResult(
                table=diff.table,
                action="created",
                detail=(
                    f"Partitioned table created with {len(index_results)} index(es) (propagated to partitions)."
                    if is_partitioned and index_results
                    else f"Table created with {len(index_results)} index(es)."
                    if index_results
                    else "Table created."
                    if is_partition
                    else "Table created. Indexes NOT created — use 'Create indexes' after replication completes."
                ),
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

                if pk_cols:
                    col_defs.append(f"  PRIMARY KEY ({', '.join(_qi(r['attname']) for r in pk_cols)})")

                ddl = (f'CREATE TABLE "{schema_name}"."{table_name}" (\n'
                       + ",\n".join(col_defs) + "\n);")

                await dest_conn_dr.execute(ddl)

                results.append(SchemaSyncResult(table=diff.table, action="created", detail="Dropped and recreated"))
            except Exception as e:
                results.append(SchemaSyncResult(table=diff.table, action="error", detail=str(e)))
    finally:
        await src_conn.close()
        await dest_conn_dr.close()

    return results
