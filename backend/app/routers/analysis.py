from fastapi import APIRouter, HTTPException
from typing import List
from ..models.schemas import SchemaInfo, TableInfo
from ..db import get_source_pool
from .. import state

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


def _require_connection():
    if not state.source_dsn:
        raise HTTPException(400, "Not connected. Call /api/connections/connect first.")


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
