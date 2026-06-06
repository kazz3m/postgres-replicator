import re
from fastapi import APIRouter, HTTPException
from typing import List, Optional
from ..models.schemas import (
    PublicationConfig, SubscriptionConfig, ReplicationStatus,
    ReplicationSlotInfo, SubscriptionStatus, TableReplicationProgress,
    SequenceInfo, TableSchemaDiff, ColumnDiff, SchemaSyncResult,
    IndexInfo, IndexCreateResult,
)
from ..db import get_source_pool, get_dest_pool
from .. import state

router = APIRouter(prefix="/api/replication", tags=["replication"])


def _require_connection():
    if not state.source_dsn or not state.dest_dsn:
        raise HTTPException(400, "Not connected. Call /api/connections/connect first.")


# ── Publications ──────────────────────────────────────────────────────────────

@router.post("/publication")
async def create_or_update_publication(config: PublicationConfig):
    _require_connection()
    pool = await get_source_pool(state.source_dsn)

    async with pool.acquire() as conn:
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
            # Validate each schema exists and quote safely — prevents SQL injection
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
            # Validate each table exists and quote safely — prevents SQL injection
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

    # Use dedicated replication DSN if provided, otherwise fall back to admin DSN
    conn_dsn = state.source_repl_dsn if state.source_repl_dsn else config.source_dsn

    # Validate DSN format and prevent dollar-quoting escape
    if not re.match(r'^postgres(ql)?://', conn_dsn):
        raise HTTPException(400, "Connection DSN must start with postgresql:// or postgres://")
    if "$conn_str$" in conn_dsn:
        raise HTTPException(400, "Connection DSN contains an illegal sequence.")

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

        # Fix #5: fetch tables included in this publication so we can verify
        # they exist on destination before committing — avoids silent error state
        pub_tables = await src_conn.fetch(
            "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1",
            config.publication_name,
        )

    if not pub_tables:
        raise HTTPException(
            400,
            f"Publication '{config.publication_name}' does not exist on source or contains no tables."
        )

    # Fix #5: verify every published table exists on destination
    dest_pool = await get_dest_pool(state.dest_dsn)
    async with dest_pool.acquire() as dest_conn:
        missing = []
        for row in pub_tables:
            exists_on_dest = await dest_conn.fetchval(
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

        exists = await dest_conn.fetchval(
            "SELECT 1 FROM pg_subscription WHERE subname = $1", config.subscription_name
        )
        if exists:
            await dest_conn.execute(
                f'ALTER SUBSCRIPTION "{config.subscription_name}" DISABLE'
            )
            await dest_conn.execute(
                f'DROP SUBSCRIPTION IF EXISTS "{config.subscription_name}"'
            )

    # CREATE SUBSCRIPTION uses a dedicated connection (not shared pool) with a
    # statement_timeout. The command makes destination PG connect back to source —
    # if unreachable it blocks for the full OS TCP timeout and poisons pool connections.
    import asyncpg as _asyncpg
    dedicated_conn = None
    try:
        dedicated_conn = await _asyncpg.connect(state.dest_dsn, timeout=15)
        copy_data_sql = "true" if config.copy_data else "false"
        # Set a statement-level timeout so the back-connect attempt fails fast
        # rather than waiting for the OS TCP timeout.
        await dedicated_conn.execute("SET statement_timeout = '30s'")
        await dedicated_conn.execute(f"""
            CREATE SUBSCRIPTION "{config.subscription_name}"
            CONNECTION $conn_str${conn_dsn}$conn_str$
            PUBLICATION "{config.publication_name}"
            WITH (copy_data = {copy_data_sql})
        """)
    except Exception as e:
        err = str(e)
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
    finally:
        if dedicated_conn:
            try:
                await dedicated_conn.close()
            except Exception:
                pass

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
                   last_msg_receive_time::text,
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

async def _diff_table_list(table_pairs: list[tuple[str, str]]) -> list[TableSchemaDiff]:
    """Core diff logic — accepts list of (schema, table) pairs."""
    src_pool = await get_source_pool(state.source_dsn)
    dest_pool = await get_dest_pool(state.dest_dsn)
    results = []

    for schema_name, table_name in table_pairs:
        fqn = f"{schema_name}.{table_name}"

        async with src_pool.acquire() as src_conn:
            src_cols = await src_conn.fetch("""
                SELECT column_name, udt_name AS data_type
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position
            """, schema_name, table_name)

        async with dest_pool.acquire() as dest_conn:
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
    if not raw_tables:
        return []
    pairs = []
    for t in raw_tables:
        if "." not in t:
            continue
        schema, table = t.split(".", 1)
        pairs.append((schema, table))
    return await _diff_table_list(pairs)


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
    tables_direct: list[str] = body.get("tables", [])  # alternative: explicit table list
    if not publication and not tables_direct:
        raise HTTPException(400, "publication or tables required")
    # create_indexes: "before" = create indexes right after table creation
    #                 "after"  = skip (user creates manually or calls /schema/create-indexes)
    # Default: "after" (safe during initial large copy — indexes slow down INSERT)
    create_indexes_when: str = body.get("create_indexes", "after")

    if publication:
        diffs = await schema_diff(publication)
    else:
        pairs = [t.split(".", 1) for t in tables_direct if "." in t]
        diffs = await _diff_table_list([(p[0], p[1]) for p in pairs])
    results = []

    src_pool = await get_source_pool(state.source_dsn)
    dest_pool = await get_dest_pool(state.dest_dsn)

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
            async with src_pool.acquire() as src_conn:
                cols = await src_conn.fetch("""
                    SELECT
                        a.attname AS col,
                        pg_catalog.format_type(a.atttypid, a.atttypmod) AS col_type,
                        a.attnotnull AS not_null,
                        pg_get_expr(d.adbin, d.adrelid) AS col_default,
                        -- detect identity columns
                        a.attidentity AS identity   -- '' none, 'a' ALWAYS, 'd' BY DEFAULT
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

                # Also get PRIMARY KEY constraint
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

            col_defs = []
            for c in cols:
                col_def = f"  {c['col']} {c['col_type']}"
                if c["identity"] == "a":
                    col_def += " GENERATED ALWAYS AS IDENTITY"
                elif c["identity"] == "d":
                    col_def += " GENERATED BY DEFAULT AS IDENTITY"
                elif c["col_default"] and "nextval" not in (c["col_default"] or ""):
                    # Skip serial nextval defaults — handled by IDENTITY or sequence
                    col_def += f" DEFAULT {c['col_default']}"
                if c["not_null"] and not c["identity"]:
                    col_def += " NOT NULL"
                col_defs.append(col_def)

            if pk_cols:
                pk_list = ", ".join(r["attname"] for r in pk_cols)
                col_defs.append(f"  PRIMARY KEY ({pk_list})")

            ddl = (
                f'CREATE TABLE IF NOT EXISTS "{schema_name}"."{table_name}" (\n'
                + ",\n".join(col_defs)
                + "\n);"
            )

            async with dest_pool.acquire() as dest_conn:
                # Ensure schema exists
                await dest_conn.execute(
                    f'CREATE SCHEMA IF NOT EXISTS "{schema_name}"'
                )
                await dest_conn.execute(ddl)

            # Optionally create indexes immediately (useful when applying schema
            # before replication starts so destination is ready to serve queries)
            index_results: list[IndexInfo] = []
            if create_indexes_when == "before":
                async with src_pool.acquire() as src_conn:
                    idx_list = await _get_table_indexes(src_conn, schema_name, table_name)
                async with dest_pool.acquire() as dest_conn:
                    for idx in idx_list:
                        try:
                            await dest_conn.execute(idx.index_def)
                            index_results.append(idx)
                        except Exception:
                            pass  # best-effort; individual errors don't fail table sync

            results.append(SchemaSyncResult(
                table=diff.table,
                action="created",
                detail=(
                    f"Table created with {len(index_results)} index(es)."
                    if create_indexes_when == "before" and index_results
                    else "Table created. Indexes NOT created — use 'Create indexes' after replication completes."
                ),
                indexes=index_results,
            ))

        except Exception as e:
            results.append(SchemaSyncResult(
                table=diff.table,
                action="error",
                detail=str(e),
            ))

    return results
