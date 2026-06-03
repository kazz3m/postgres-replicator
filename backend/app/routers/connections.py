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
                wal_level = await conn.fetchval("SELECT current_setting('wal_level')")
                if wal_level != "logical":
                    warnings.append(
                        f"wal_level is '{wal_level}', must be 'logical' for replication"
                    )
        finally:
            await conn.close()
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
