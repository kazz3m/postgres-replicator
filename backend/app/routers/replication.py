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
        # Detect PG version for schema-level publications (PG15+)
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
            # Drop and recreate to reflect changes
            await conn.execute(f'DROP PUBLICATION IF EXISTS "{config.publication_name}"')

        if config.target.schemas:
            schemas_sql = ", ".join(f'"{s}"' for s in config.target.schemas)
            await conn.execute(
                f'CREATE PUBLICATION "{config.publication_name}" FOR TABLES IN SCHEMA {schemas_sql}'
            )
        elif config.target.tables:
            tables_sql = ", ".join(config.target.tables)
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
    return [dict(r) for r in rows]


# ── Subscriptions ─────────────────────────────────────────────────────────────

@router.post("/subscription")
async def create_or_update_subscription(config: SubscriptionConfig):
    _require_connection()
    pool = await get_dest_pool(state.dest_dsn)

    async with pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_subscription WHERE subname = $1", config.subscription_name
        )
        if exists:
            # Disable, drop, recreate
            await conn.execute(
                f'ALTER SUBSCRIPTION "{config.subscription_name}" DISABLE'
            )
            await conn.execute(
                f'DROP SUBSCRIPTION IF EXISTS "{config.subscription_name}"'
            )

        copy_data_sql = "true" if config.copy_data else "false"
        await conn.execute(f"""
            CREATE SUBSCRIPTION "{config.subscription_name}"
            CONNECTION '{config.source_dsn}'
            PUBLICATION "{config.publication_name}"
            WITH (copy_data = {copy_data_sql})
        """)

    return {"status": "ok", "subscription_name": config.subscription_name, "updated": bool(exists)}


@router.delete("/subscription/{name}")
async def drop_subscription(name: str):
    _require_connection()
    pool = await get_dest_pool(state.dest_dsn)
    async with pool.acquire() as conn:
        # Must disable before drop
        try:
            await conn.execute(f'ALTER SUBSCRIPTION "{name}" DISABLE')
        except Exception:
            pass
        await conn.execute(f'DROP SUBSCRIPTION IF EXISTS "{name}"')
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


# ── Slots ─────────────────────────────────────────────────────────────────────

@router.get("/slots", response_model=List[ReplicationSlotInfo])
async def list_slots():
    _require_connection()
    pool = await get_source_pool(state.source_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT slot_name, plugin, slot_type, active,
                   restart_lsn::text, confirmed_flush_lsn::text,
                   pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
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
        # pg_subscription_rel tracks per-table sync state
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

        try:
            await conn.execute(f'ALTER SUBSCRIPTION "{subscription_name}" DISABLE')
        except Exception:
            pass
        await conn.execute(f'DROP SUBSCRIPTION IF EXISTS "{subscription_name}"')

    # Drop slot on source if exists
    if slot_name:
        async with src_pool.acquire() as conn:
            try:
                await conn.execute("SELECT pg_drop_replication_slot($1)", slot_name)
            except Exception:
                pass

    # Recreate subscription
    pub_list = ", ".join(f'"{p}"' for p in publications)
    async with dest_pool.acquire() as conn:
        await conn.execute(f"""
            CREATE SUBSCRIPTION "{subscription_name}"
            CONNECTION '{conninfo}'
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
    return {"interval_seconds": state.stats_refresh_interval}
