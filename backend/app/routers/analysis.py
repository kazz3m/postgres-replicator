from fastapi import APIRouter, HTTPException
from typing import List
import asyncpg
from ..models.schemas import SchemaInfo, TableInfo
from ..db import get_source_pool, get_dest_pool, dsn_for_database
from .. import state

router = APIRouter(prefix="/api/analysis", tags=["analysis"])

SYSTEM_DATABASES = {"postgres", "template0", "template1", "cloudsqladmin"}


def _require_connection():
    if not state.source_dsn:
        raise HTTPException(400, "Not connected. Call /api/connections/connect first.")



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


@router.get("/database-schema-list")
async def list_database_schema_list(database: str):
    """
    List schemas (names + sizes, NO tables) for a specific database.
    Called when user expands a database node — fast, no per-table stats.
    """
    _require_connection()
    db_dsn = dsn_for_database(state.source_dsn, database)
    try:
        conn = await asyncpg.connect(db_dsn, timeout=10)
    except Exception as e:
        raise HTTPException(400, f"Cannot connect to database '{database}': {e}")

    try:
        rows = await conn.fetch("""
            SELECT
                n.nspname AS schema_name,
                COUNT(c.oid) AS table_count,
                COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS total_size_bytes,
                pg_size_pretty(COALESCE(SUM(pg_total_relation_size(c.oid)), 0)) AS total_size_pretty
            FROM pg_namespace n
            LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r'
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
              AND n.nspname NOT LIKE 'pg\\_toast%'
              AND n.nspname NOT LIKE 'pg\\_temp%'
            GROUP BY n.nspname
            ORDER BY n.nspname
        """)
    finally:
        await conn.close()

    return [
        {
            "schema_name": r["schema_name"],
            "table_count": r["table_count"],
            "total_size_bytes": r["total_size_bytes"],
            "total_size_pretty": r["total_size_pretty"],
        }
        for r in rows
    ]


@router.get("/schema-tables")
async def list_schema_tables(database: str, schema: str):
    """
    List tables for a specific schema within a database.
    Called when user expands a schema node — lazy loaded.
    """
    _require_connection()
    db_dsn = dsn_for_database(state.source_dsn, database)
    try:
        conn = await asyncpg.connect(db_dsn, timeout=10)
    except Exception as e:
        raise HTTPException(400, f"Cannot connect to database '{database}': {e}")

    try:
        rows = await conn.fetch("""
            SELECT
                t.table_name,
                COALESCE(pg_total_relation_size(
                    quote_ident(t.table_schema)||'.'||quote_ident(t.table_name)
                ), 0) AS size_bytes,
                pg_size_pretty(COALESCE(pg_total_relation_size(
                    quote_ident(t.table_schema)||'.'||quote_ident(t.table_name)
                ), 0)) AS size_pretty,
                COALESCE(c.reltuples::bigint, 0) AS row_estimate,
                c.relreplident,
                c.relkind = 'p'          AS is_partitioned,
                c.relispartition         AS is_partition
            FROM information_schema.tables t
            LEFT JOIN pg_class c ON c.relname = t.table_name
              AND c.relnamespace = (
                  SELECT oid FROM pg_namespace WHERE nspname = t.table_schema
              )
            WHERE t.table_schema = $1
              AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_name
        """, schema)
    finally:
        await conn.close()

    replident_map = {"d": "default", "f": "full", "i": "index", "n": "nothing"}
    return [
        {
            "table_name": r["table_name"],
            "schema_name": schema,
            "size_bytes": r["size_bytes"],
            "size_pretty": r["size_pretty"],
            "row_estimate": max(0, r["row_estimate"]),
            "replica_identity": replident_map.get(r["relreplident"], "default"),
            "is_partitioned": r["is_partitioned"] or False,
            "is_partition": r["is_partition"] or False,
        }
        for r in rows
    ]


@router.get("/database-schemas")
async def list_database_schemas(database: str):
    """Legacy endpoint — returns all schemas+tables. Kept for backward compat."""
    _require_connection()
    db_dsn = dsn_for_database(state.source_dsn, database)
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
    maint_dsn = dsn_for_database(state.dest_dsn, "postgres")
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


@router.get("/published-tables")
async def published_tables(database: str):
    """
    Returns a map of schema.table → list of publication names for tables
    that are already part of a publication in the given source database.
    Used by the UI to warn when selecting tables already being replicated.
    """
    _require_connection()
    db_dsn = dsn_for_database(state.source_dsn, database)
    try:
        conn = await asyncpg.connect(db_dsn, timeout=10)
    except Exception as e:
        raise HTTPException(400, f"Cannot connect to database '{database}': {e}")

    try:
        rows = await conn.fetch("""
            SELECT schemaname || '.' || tablename AS table_fqn,
                   pubname
            FROM pg_publication_tables
            ORDER BY table_fqn, pubname
        """)
    finally:
        await conn.close()

    result: dict[str, list[str]] = {}
    for row in rows:
        key = row["table_fqn"]
        if key not in result:
            result[key] = []
        result[key].append(row["pubname"])

    return result


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
