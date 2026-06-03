from fastapi import APIRouter, HTTPException
from typing import Optional, List
import asyncpg
from ..models.schemas import ConnectionConfig, ConnectionStatus, PGVersion
from ..db import get_source_pool, get_dest_pool, reset_pools
from ..utils import mask_dsn
from .. import state

router = APIRouter(prefix="/api/connections", tags=["connections"])


async def _check_connection(
    dsn: str, is_source: bool = False, repl_dsn: str = ""
) -> tuple[bool, Optional[PGVersion], Optional[str], List[str]]:
    warnings: List[str] = []
    try:
        conn = await asyncpg.connect(dsn, timeout=5)
        try:
            row = await conn.fetchrow("SELECT version(), current_setting('server_version_num')::int AS num")
            if is_source:
                # Check wal_level on admin connection
                wal_level = await conn.fetchval("SELECT current_setting('wal_level')")
                if wal_level != "logical":
                    warnings.append(
                        f"wal_level is '{wal_level}', must be 'logical' for replication. "
                        f"Set wal_level = logical in postgresql.conf and restart PostgreSQL."
                    )
                # Check REPLICATION attribute on the admin user
                current_user = await conn.fetchval("SELECT current_user")
                has_replication = await conn.fetchval(
                    "SELECT rolreplication FROM pg_roles WHERE rolname = $1", current_user
                )
                if not has_replication:
                    # Only warn if no separate replication DSN is provided
                    if not repl_dsn:
                        warnings.append(
                            f"User '{current_user}' does not have REPLICATION attribute. "
                            f"Provide a separate Replication DSN, or run: ALTER USER {current_user} REPLICATION;"
                        )
                # Check max_replication_slots headroom
                slots_used = await conn.fetchval("SELECT count(*) FROM pg_replication_slots")
                slots_max = await conn.fetchval("SELECT current_setting('max_replication_slots')::int")
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
                # Check max_wal_senders headroom
                senders_used = await conn.fetchval("SELECT count(*) FROM pg_stat_replication")
                senders_max = await conn.fetchval("SELECT current_setting('max_wal_senders')::int")
                if senders_used >= senders_max:
                    warnings.append(
                        f"max_wal_senders limit reached ({senders_used}/{senders_max}). "
                        f"Increase max_wal_senders in postgresql.conf."
                    )
        finally:
            await conn.close()

        if is_source:
            # Test the replication protocol channel — use dedicated repl_dsn if provided,
            # otherwise fall back to admin dsn. This tests the pg_hba.conf "host replication" entry.
            test_dsn = repl_dsn if repl_dsn else dsn
            try:
                repl_conn = await asyncpg.connect(
                    test_dsn, timeout=5, server_settings={"replication": "database"}
                )
                await repl_conn.close()
            except Exception as e:
                warnings.append(
                    f"Replication channel test failed: {e}. "
                    f"Ensure pg_hba.conf has: host replication <user> <subscriber_ip>/32 md5"
                )

            # If repl_dsn provided, also verify it has REPLICATION attribute
            if repl_dsn:
                try:
                    repl_conn = await asyncpg.connect(repl_dsn, timeout=5)
                    try:
                        repl_user = await repl_conn.fetchval("SELECT current_user")
                        has_repl_attr = await repl_conn.fetchval(
                            "SELECT rolreplication FROM pg_roles WHERE rolname = $1", repl_user
                        )
                        if not has_repl_attr:
                            warnings.append(
                                f"Replication user '{repl_user}' does not have REPLICATION attribute. "
                                f"Run: ALTER USER {repl_user} REPLICATION;"
                            )
                    finally:
                        await repl_conn.close()
                except Exception as e:
                    warnings.append(f"Replication DSN connection failed: {e}")

        major = row["num"] // 10000
        return True, PGVersion(version=row["version"], major=major), None, warnings
    except Exception as e:
        return False, None, str(e), warnings


@router.post("/test", response_model=ConnectionStatus)
async def test_connections(config: ConnectionConfig):
    src_ok, src_ver, src_err, src_warnings = await _check_connection(
        config.source_dsn, is_source=True, repl_dsn=config.source_repl_dsn
    )
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
    src_ok, src_ver, src_err, src_warnings = await _check_connection(
        config.source_dsn, is_source=True, repl_dsn=config.source_repl_dsn
    )
    dst_ok, dst_ver, dst_err, _ = await _check_connection(config.dest_dsn)
    if not src_ok:
        raise HTTPException(400, f"Source connection failed: {src_err}")
    if not dst_ok:
        raise HTTPException(400, f"Destination connection failed: {dst_err}")

    await reset_pools()
    state.source_dsn = config.source_dsn
    state.source_repl_dsn = config.source_repl_dsn
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
        "source_repl_dsn": mask_dsn(state.source_repl_dsn) if state.source_repl_dsn else None,
        "dest_dsn": mask_dsn(state.dest_dsn) if state.dest_dsn else None,
        "connected": bool(state.source_dsn and state.dest_dsn),
    }
