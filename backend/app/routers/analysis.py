from fastapi import APIRouter, HTTPException
from typing import List
import asyncpg
from ..models.schemas import SchemaInfo, TableInfo
from ..db import get_source_pool, get_dest_pool
from .. import state

router = APIRouter(prefix="/api/analysis", tags=["analysis"])

SYSTEM_DATABASES = {"postgres", "template0", "template1"}


def _require_connection():
    if not state.source_dsn:
        raise HTTPException(400, "Not connected. Call /api/connections/connect first.")


def _dsn_for_database(base_dsn: str, database: str) -> str:
    """Swap the database name in a DSN while preserving all other parameters."""
    import urllib.parse
    parsed = urllib.parse.urlparse(base_dsn)
    # path is /dbname[?flags] — replace just the dbname part
    new_path = "/" + urllib.parse.quote(database, safe="")
    new = parsed._replace(path=new_path)
    return urllib.parse.urlunparse(new)


@router.get("/databases")
async def list_cluster_databases():
    """
    List all non-template databases on source cluster.
    Also reports which databases exist on destination cluster.
    """
    _require_connection()
    src_pool = await get_source_pool(state.source_dsn)
    dest_pool = await get_dest_pool(state.dest_dsn)

    async with src_pool.acquire() as src_conn:
        src_dbs = await src_conn.fetch("""
            SELECT datname,
                   pg_size_pretty(pg_database_size(datname)) AS size_pretty,
                   pg_database_size(datname) AS size_bytes
            FROM pg_database
            WHERE datistemplate = false
              AND datname NOT IN ('postgres')
            ORDER BY datname
        """)

    async with dest_pool.acquire() as dest_conn:
        dest_db_names = set(
            r["datname"] for r in await dest_conn.fetch(
                "SELECT datname FROM pg_database WHERE datistemplate = false"
            )
        )

    return [
        {
            "database": r["datname"],
            "size_pretty": r["size_pretty"],
            "size_bytes": r["size_bytes"],
            "exists_on_dest": r["datname"] in dest_db_names,
        }
        for r in src_dbs
    ]


@router.get("/database-schemas")
async def list_database_schemas(database: str):
    """
    List schemas and tables for a specific database on source.
    Connects to that database directly (separate pool per-request).
    """
    _require_connection()
    db_dsn = _dsn_for_database(state.source_dsn, database)
    try:
        conn = await asyncpg.connect(db_dsn, timeout=10)
    except Exception as e:
        raise HTTPException(400, f"Cannot connect to database '{database}': {e}")

    try:
        rows = await conn.fetch("""
            SELECT
                t.table_schema,
                t.table_name,
                COALESCE(pg_total_relation_size(
                    quote_ident(t.table_schema)||'.'||quote_ident(t.table_name)
                ), 0) AS size_bytes,
                pg_size_pretty(COALESCE(pg_total_relation_size(
                    quote_ident(t.table_schema)||'.'||quote_ident(t.table_name)
                ), 0)) AS size_pretty,
                COALESCE(c.reltuples::bigint, 0) AS row_estimate,
                c.relreplident
            FROM information_schema.tables t
            LEFT JOIN pg_class c ON c.relname = t.table_name
              AND c.relnamespace = (
                  SELECT oid FROM pg_namespace WHERE nspname = t.table_schema
              )
            WHERE t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
              AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_schema, t.table_name
        """)
    finally:
        await conn.close()

    replident_map = {"d": "default", "f": "full", "i": "index", "n": "nothing"}
    schemas: dict[str, SchemaInfo] = {}
    for row in rows:
        sname = row["table_schema"]
        table = TableInfo(
            schema_name=sname,
            table_name=row["table_name"],
            size_bytes=row["size_bytes"],
            size_pretty=row["size_pretty"],
            row_estimate=max(0, row["row_estimate"]),
            replica_identity=replident_map.get(row["relreplident"], "default"),
        )
        if sname not in schemas:
            schemas[sname] = SchemaInfo(
                schema_name=sname,
                tables=[],
                total_size_bytes=0,
                total_size_pretty="",
            )
        schemas[sname].tables.append(table)
        schemas[sname].total_size_bytes += table.size_bytes

    for s in schemas.values():
        s.total_size_pretty = _pretty_size(s.total_size_bytes)

    return list(schemas.values())


@router.post("/ensure-database")
async def ensure_database(body: dict):
    """
    CREATE DATABASE <name> on destination if it does not already exist.
    Uses the destination admin DSN (connects to maintenance DB 'postgres').
    """
    _require_connection()
    database = body.get("database")
    if not database:
        raise HTTPException(400, "database name required")

    import re
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_$]*$', database):
        raise HTTPException(400, f"Invalid database name: '{database}'")

    # Connect to maintenance DB on destination (CREATE DATABASE cannot run in tx)
    maint_dsn = _dsn_for_database(state.dest_dsn, "postgres")
    try:
        conn = await asyncpg.connect(maint_dsn, timeout=10)
    except Exception as e:
        raise HTTPException(400, f"Cannot connect to destination: {e}")

    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", database
        )
        if exists:
            return {"status": "already_exists", "database": database}

        # CREATE DATABASE cannot run inside a transaction block — asyncpg wraps each
        # statement in an implicit transaction, so we must use execute with autocommit.
        await conn.execute(f'CREATE DATABASE "{database}"')
        return {"status": "created", "database": database}
    finally:
        await conn.close()


@router.get("/schemas", response_model=List[SchemaInfo])
async def list_schemas():
    _require_connection()
    pool = await get_source_pool(state.source_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT
                t.table_schema,
                t.table_name,
                COALESCE(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name)), 0) AS size_bytes,
                pg_size_pretty(COALESCE(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name)), 0)) AS size_pretty,
                COALESCE(c.reltuples::bigint, 0) AS row_estimate,
                c.relreplident
            FROM information_schema.tables t
            LEFT JOIN pg_class c ON c.relname = t.table_name
              AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
            WHERE t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
              AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_schema, t.table_name
        """)

    replident_map = {"d": "default", "f": "full", "i": "index", "n": "nothing"}

    schemas: dict[str, SchemaInfo] = {}
    for row in rows:
        sname = row["table_schema"]
        table = TableInfo(
            schema_name=sname,
            table_name=row["table_name"],
            size_bytes=row["size_bytes"],
            size_pretty=row["size_pretty"],
            row_estimate=max(0, row["row_estimate"]),
            replica_identity=replident_map.get(row["relreplident"], "default"),
        )
        if sname not in schemas:
            schemas[sname] = SchemaInfo(
                schema_name=sname,
                tables=[],
                total_size_bytes=0,
                total_size_pretty="",
            )
        schemas[sname].tables.append(table)
        schemas[sname].total_size_bytes += table.size_bytes

    for s in schemas.values():
        s.total_size_pretty = _pretty_size(s.total_size_bytes)

    return list(schemas.values())


def _pretty_size(b: int) -> str:
    for unit in ["B", "kB", "MB", "GB", "TB"]:
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"
