from fastapi import APIRouter, HTTPException
import asyncpg
from ..models.schemas import ConnectionConfig, ConnectionStatus, PGVersion
from ..db import get_source_pool, get_dest_pool, reset_pools
from .. import state

router = APIRouter(prefix="/api/connections", tags=["connections"])


async def _check_connection(dsn: str) -> tuple[bool, Optional[PGVersion], Optional[str]]:
    try:
        conn = await asyncpg.connect(dsn, timeout=5)
        row = await conn.fetchrow("SELECT version(), current_setting('server_version_num')::int AS num")
        await conn.close()
        major = row["num"] // 10000
        return True, PGVersion(version=row["version"], major=major), None
    except Exception as e:
        return False, None, str(e)


from typing import Optional


@router.post("/test", response_model=ConnectionStatus)
async def test_connections(config: ConnectionConfig):
    src_ok, src_ver, src_err = await _check_connection(config.source_dsn)
    dst_ok, dst_ver, dst_err = await _check_connection(config.dest_dsn)
    return ConnectionStatus(
        source_ok=src_ok,
        dest_ok=dst_ok,
        source_version=src_ver,
        dest_version=dst_ver,
        source_error=src_err,
        dest_error=dst_err,
    )


@router.post("/connect")
async def connect(config: ConnectionConfig):
    src_ok, src_ver, src_err = await _check_connection(config.source_dsn)
    dst_ok, dst_ver, dst_err = await _check_connection(config.dest_dsn)
    if not src_ok:
        raise HTTPException(400, f"Source connection failed: {src_err}")
    if not dst_ok:
        raise HTTPException(400, f"Destination connection failed: {dst_err}")

    await reset_pools()
    state.source_dsn = config.source_dsn
    state.dest_dsn = config.dest_dsn
    await get_source_pool(config.source_dsn)
    await get_dest_pool(config.dest_dsn)

    return {
        "status": "connected",
        "source_version": src_ver,
        "dest_version": dst_ver,
    }


@router.get("/status")
async def connection_status():
    return {
        "source_dsn": state.source_dsn or None,
        "dest_dsn": state.dest_dsn or None,
        "connected": bool(state.source_dsn and state.dest_dsn),
    }
