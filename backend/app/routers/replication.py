import re
from fastapi import APIRouter, HTTPException
from typing import List, Optional
from ..models.schemas import (
    PublicationConfig, SubscriptionConfig, ReplicationStatus,
    ReplicationSlotInfo, SubscriptionStatus, TableReplicationProgress,
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

    # Validate DSN format and prevent dollar-quoting escape
    if not re.match(r'^postgres(ql)?://', config.source_dsn):
        raise HTTPException(400, "source_dsn must start with postgresql:// or postgres://")
    if "$conn_str$" in config.source_dsn:
        raise HTTPException(400, "source_dsn contains an illegal sequence.")

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

        copy_data_sql = "true" if config.copy_data else "false"
        await dest_conn.execute(f"""
            CREATE SUBSCRIPTION "{config.subscription_name}"
            CONNECTION $conn_str${config.source_dsn}$conn_str$
            PUBLICATION "{config.publication_name}"
            WITH (copy_data = {copy_data_sql})
        """)

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
        row = await conn.fetchrow(
            "SELECT subslotname, subpublications, subconninfo FROM pg_subscription WHERE subname = $1",
            subscription_name
        )
        if not row:
            raise HTTPException(404, f"Subscription '{subscription_name}' not found.")
        slot_name = row["subslotname"]
        publications = row["subpublications"]
        conninfo = row["subconninfo"]

        # Fix #6 (reset path): propagate DISABLE failure instead of swallowing it
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

    # Fix #7: use dollar-quoting for conninfo consistently (same as create_or_update_subscription)
    if "$conn_str$" in conninfo:
        raise HTTPException(500, "Stored conninfo contains illegal sequence, cannot recreate subscription.")
    pub_list = ", ".join(f'"{p}"' for p in publications)
    async with dest_pool.acquire() as conn:
        await conn.execute(f"""
            CREATE SUBSCRIPTION "{subscription_name}"
            CONNECTION $conn_str${conninfo}$conn_str$
            PUBLICATION {pub_list}
            WITH (copy_data = true)
        """)

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
