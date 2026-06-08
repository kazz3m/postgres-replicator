import asyncpg
import urllib.parse
from typing import Optional


def dsn_for_database(base_dsn: str, database: str) -> str:
    """Return a DSN with the database name replaced, preserving all other parameters."""
    parsed = urllib.parse.urlparse(base_dsn)
    new_path = "/" + urllib.parse.quote(database, safe="")
    return urllib.parse.urlunparse(parsed._replace(path=new_path))

_source_pool: Optional[asyncpg.Pool] = None
_dest_pool: Optional[asyncpg.Pool] = None


async def get_source_pool(dsn: str) -> asyncpg.Pool:
    global _source_pool
    if _source_pool is None or _source_pool._closed:
        _source_pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
    return _source_pool


async def get_dest_pool(dsn: str) -> asyncpg.Pool:
    global _dest_pool
    if _dest_pool is None or _dest_pool._closed:
        _dest_pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
    return _dest_pool


async def close_pools():
    global _source_pool, _dest_pool
    if _source_pool:
        await _source_pool.close()
    if _dest_pool:
        await _dest_pool.close()


async def reset_pools():
    global _source_pool, _dest_pool
    if _source_pool and not _source_pool._closed:
        await _source_pool.close()
    if _dest_pool and not _dest_pool._closed:
        await _dest_pool.close()
    _source_pool = None
    _dest_pool = None
