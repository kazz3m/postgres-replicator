from fastapi import APIRouter, HTTPException
from typing import Optional, List
import asyncpg
from ..models.schemas import ConnectionConfig, ConnectionStatus, PGVersion
from ..db import get_source_pool, get_dest_pool, reset_pools
from ..utils import mask_dsn
from .. import state

router = APIRouter(prefix="/api/connections", tags=["connections"])


async def _check_connection(
    dsn: str, is_source: bool = False
) -> tuple[bool, Optional[PGVersion], Optional[str], List[str]]:
    warnings: List[str] = []
    try:
        conn = await asyncpg.connect(dsn, timeout=5)
        try:
            row = await conn.fetchrow("SELECT version(), current_setting('server_version_num')::int AS num")
            if is_source:
                # Fix #1 prerequisite: check wal_level
                wal_level = await conn.fetchval("SELECT current_setting('wal_level')")
                if wal_level != "logical":
                    warnings.append(
                        f"wal_level is '{wal_level}', must be 'logical' for replication. "
                        f"Set wal_level = logical in postgresql.conf and restart PostgreSQL."
                    )
                # Fix #2: check that the connecting user has REPLICATION attribute
                current_user = await conn.fetchval("SELECT current_user")
                has_replication = await conn.fetchval(
                    "SELECT rolreplication FROM pg_roles WHERE rolname = $1", current_user
                )
                if not has_replication:
                    warnings.append(
                        f"User '{current_user}' does not have REPLICATION attribute. "
                        f"Run: ALTER USER {current_user} REPLICATION;"
                    )
                # Fix #4: check max_replication_slots headroom
                slots_used = await conn.fetchval(
                    "SELECT count(*) FROM pg_replication_slots"
                )
                slots_max = await conn.fetchval(
                    "SELECT current_setting('max_replication_slots')::int"
                )
                if slots_used >= slots_max:
                    warnings.append(
                        f"max_replication_slots limit reached ({slots_used}/{slots_max}). "
                        f"Increase max_replication_slots in postgresql.conf."
                    )
                elif slots_max - slots_used < 2:
                    warnings.append(
                        f"Only {slots_max - slots_used} replication slot(s) remaining "
                        f"({slots_used}/{slots_max}). Consider increasing max_replication_slots."
                    )
                # Fix #4: check max_wal_senders headroom
                senders_used = await conn.fetchval(
                    "SELECT count(*) FROM pg_stat_replication"
                )
                senders_max = await conn.fetchval(
                    "SELECT current_setting('max_wal_senders')::int"
                )
                if senders_used >= senders_max:
                    warnings.append(
                        f"max_wal_senders limit reached ({senders_used}/{senders_max}). "
                        f"Increase max_wal_senders in postgresql.conf."
                    )
        finally:
            await conn.close()

        if is_source:
            # Fix #3: test the replication protocol channel separately — this is what
            # CREATE SUBSCRIPTION actually uses, and it requires a distinct pg_hba.conf
            # entry: "host replication <user> <dest_ip>/32 md5"
            try:
                repl_conn = await asyncpg.connect(dsn, timeout=5, server_settings={"replication": "database"})
                await repl_conn.close()
            except Exception as e:
                warnings.append(
                    f"Replication channel test failed: {e}. "
                    f"Ensure pg_hba.conf has: host replication <user> <subscriber_ip>/32 md5"
                )
        major = row["num"] // 10000
        return True, PGVersion(version=row["version"], major=major), None, warnings
    except Exception as e:
        return False, None, str(e), warnings


@router.post("/test", response_model=ConnectionStatus)
async def test_connections(config: ConnectionConfig):
    src_ok, src_ver, src_err, src_warnings = await _check_connection(config.source_dsn, is_source=True)
    dst_ok, dst_ver, dst_err, _ = await _check_connection(config.dest_dsn)
    return ConnectionStatus(
        source_ok=src_ok,
        dest_ok=dst_ok,
        source_version=src_ver,
        dest_version=dst_ver,
        source_error=src_err,
        dest_error=dst_err,
        warnings=src_warnings,
    )


@router.post("/connect")
async def connect(config: ConnectionConfig):
    src_ok, src_ver, src_err, src_warnings = await _check_connection(config.source_dsn, is_source=True)
    dst_ok, dst_ver, dst_err, _ = await _check_connection(config.dest_dsn)
    if not src_ok:
        raise HTTPException(400, f"Source connection failed: {src_err}")
    if not dst_ok:
        raise HTTPException(400, f"Destination connection failed: {dst_err}")

    await reset_pools()
    state.source_dsn = config.source_dsn
    state.dest_dsn = config.dest_dsn
    state.persist()
    await get_source_pool(config.source_dsn)
    await get_dest_pool(config.dest_dsn)

    return {
        "status": "connected",
        "source_version": src_ver,
        "dest_version": dst_ver,
        "warnings": src_warnings,
    }


@router.get("/status")
async def connection_status():
    return {
        "source_dsn": mask_dsn(state.source_dsn) if state.source_dsn else None,
        "dest_dsn": mask_dsn(state.dest_dsn) if state.dest_dsn else None,
        "connected": bool(state.source_dsn and state.dest_dsn),
    }
