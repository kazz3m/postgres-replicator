"""
Schema dump & apply — dump DDL from source database and apply to destination.

Strategy:
  1. If state.pg_dump_path is set and the binary exists — use pg_dump.
     Output is post-processed to remove DROP statements and convert
     CREATE → CREATE IF NOT EXISTS where possible.
  2. Otherwise — use built-in pg_catalog generator (subset: tables,
     sequences, indexes, views, types, functions, triggers, comments).

Both paths produce a list of SQL statements that can be previewed and
selectively applied on destination.
"""

import asyncio
import concurrent.futures
import os
import re
import subprocess
from typing import Optional

import asyncpg
from fastapi import APIRouter, HTTPException

from ..db import dsn_for_database
from .. import state

router = APIRouter(prefix="/api/schema-dump", tags=["schema-dump"])


# ── helpers ───────────────────────────────────────────────────────────────────

def _post_process_pg_dump(sql: str) -> list[str]:
    """
    Split pg_dump output into individual statements, remove DROPs,
    convert CREATE to CREATE IF NOT EXISTS where supported.
    """
    # Strip SET / SELECT pg_catalog lines that are noise
    lines = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        if stripped.upper().startswith("SET "):
            continue
        if stripped.upper().startswith("SELECT PG_CATALOG"):
            continue
        lines.append(line)

    raw = "\n".join(lines)

    # Split on statement boundaries respecting $$ dollar-quoting blocks.
    # pg_dump uses $$ (or $BODY$ etc.) for function/procedure bodies.
    # A statement ends at ";" that is NOT inside a dollar-quote block,
    # string literal, or block comment.
    statements = []
    current_chars: list[str] = []
    i = 0
    text = raw
    n = len(text)
    in_dollar_quote: Optional[str] = None   # the tag e.g. "$$" or "$BODY$"
    in_single_quote = False
    in_line_comment = False
    in_block_comment = False

    while i < n:
        ch = text[i]

        # Line comment --
        if not in_dollar_quote and not in_single_quote and not in_block_comment:
            if ch == '-' and i + 1 < n and text[i+1] == '-':
                in_line_comment = True

        if in_line_comment:
            current_chars.append(ch)
            if ch == '\n':
                in_line_comment = False
            i += 1
            continue

        # Block comment /* */
        if not in_dollar_quote and not in_single_quote:
            if not in_block_comment and ch == '/' and i + 1 < n and text[i+1] == '*':
                in_block_comment = True
                current_chars.append(ch)
                i += 1
                continue
            if in_block_comment:
                current_chars.append(ch)
                if ch == '*' and i + 1 < n and text[i+1] == '/':
                    current_chars.append(text[i+1])
                    i += 2
                    in_block_comment = False
                else:
                    i += 1
                continue

        # Dollar quoting $$...$$ or $tag$...$tag$
        if not in_single_quote and not in_block_comment:
            if ch == '$':
                # find closing $
                j = i + 1
                while j < n and (text[j].isalnum() or text[j] == '_'):
                    j += 1
                if j < n and text[j] == '$':
                    tag = text[i:j+1]  # e.g. "$$" or "$BODY$"
                    if in_dollar_quote is None:
                        in_dollar_quote = tag
                        current_chars.append(text[i:j+1])
                        i = j + 1
                        continue
                    elif in_dollar_quote == tag:
                        in_dollar_quote = None
                        current_chars.append(text[i:j+1])
                        i = j + 1
                        continue

        # Single quote
        if not in_dollar_quote and not in_block_comment:
            if ch == "'" and not in_single_quote:
                in_single_quote = True
                current_chars.append(ch)
                i += 1
                continue
            if in_single_quote:
                current_chars.append(ch)
                if ch == "'" and i + 1 < n and text[i+1] == "'":
                    # escaped quote ''
                    current_chars.append(text[i+1])
                    i += 2
                else:
                    in_single_quote = False
                    i += 1
                continue

        # Statement terminator
        if ch == ';' and not in_dollar_quote and not in_single_quote \
                and not in_block_comment and not in_line_comment:
            current_chars.append(ch)
            stmt = "".join(current_chars).strip()
            if stmt and stmt != ';':
                statements.append(stmt)
            current_chars = []
            i += 1
            continue

        current_chars.append(ch)
        i += 1

    # trailing content without semicolon
    remainder = "".join(current_chars).strip()
    if remainder and remainder != ';':
        statements.append(remainder)

    result = []
    for stmt in statements:
        upper = stmt.upper().lstrip()

        # Drop DROP statements entirely
        if upper.startswith("DROP "):
            continue
        if upper.startswith("ALTER TABLE") and "OWNER TO" in upper:
            continue  # ownership changes often fail on Cloud SQL

        # Convert CREATE TABLE → CREATE TABLE IF NOT EXISTS
        stmt = re.sub(
            r'\bCREATE TABLE\b(?!\s+IF\s+NOT\s+EXISTS)',
            'CREATE TABLE IF NOT EXISTS',
            stmt, flags=re.IGNORECASE
        )
        # CREATE SEQUENCE → CREATE SEQUENCE IF NOT EXISTS
        stmt = re.sub(
            r'\bCREATE SEQUENCE\b(?!\s+IF\s+NOT\s+EXISTS)',
            'CREATE SEQUENCE IF NOT EXISTS',
            stmt, flags=re.IGNORECASE
        )
        # CREATE INDEX → CREATE INDEX IF NOT EXISTS
        stmt = re.sub(
            r'\bCREATE INDEX\b(?!\s+IF\s+NOT\s+EXISTS)',
            'CREATE INDEX IF NOT EXISTS',
            stmt, flags=re.IGNORECASE
        )
        # CREATE UNIQUE INDEX → CREATE UNIQUE INDEX IF NOT EXISTS
        stmt = re.sub(
            r'\bCREATE UNIQUE INDEX\b(?!\s+IF\s+NOT\s+EXISTS)',
            'CREATE UNIQUE INDEX IF NOT EXISTS',
            stmt, flags=re.IGNORECASE
        )
        # CREATE VIEW → CREATE OR REPLACE VIEW
        stmt = re.sub(
            r'\bCREATE VIEW\b(?!\s+OR\s+REPLACE)',
            'CREATE OR REPLACE VIEW',
            stmt, flags=re.IGNORECASE
        )
        # CREATE FUNCTION / PROCEDURE → CREATE OR REPLACE
        stmt = re.sub(
            r'\bCREATE FUNCTION\b(?!\s+OR\s+REPLACE)',
            'CREATE OR REPLACE FUNCTION',
            stmt, flags=re.IGNORECASE
        )
        stmt = re.sub(
            r'\bCREATE PROCEDURE\b(?!\s+OR\s+REPLACE)',
            'CREATE OR REPLACE PROCEDURE',
            stmt, flags=re.IGNORECASE
        )
        # CREATE SCHEMA → CREATE SCHEMA IF NOT EXISTS
        stmt = re.sub(
            r'\bCREATE SCHEMA\b(?!\s+IF\s+NOT\s+EXISTS)',
            'CREATE SCHEMA IF NOT EXISTS',
            stmt, flags=re.IGNORECASE
        )
        # CREATE TYPE → leave as-is (no IF NOT EXISTS in PG < 9.5 syntax trick)
        # but wrap in DO block for safety
        if re.match(r'\s*CREATE TYPE\b', stmt, re.IGNORECASE):
            m = re.match(r'\s*CREATE TYPE\s+("?[\w.]+"?)\s+AS', stmt, re.IGNORECASE)
            if m:
                type_name = m.group(1)
                stmt = (
                    f"DO $$ BEGIN\n"
                    f"  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE oid = '{type_name}'::regtype) THEN\n"
                    f"    {stmt};\n"
                    f"  END IF;\n"
                    f"END $$;"
                )

        if stmt.strip():
            result.append(stmt.strip())

    return result


async def _dump_via_pg_dump(database: str, schemas: list[str]) -> list[str]:
    """Run pg_dump --schema-only and post-process output."""
    import urllib.parse
    import os
    import concurrent.futures

    pg_dump = state.pg_dump_path.strip()
    if not pg_dump:
        raise RuntimeError("pg_dump path not configured")

    parsed = urllib.parse.urlparse(dsn_for_database(state.source_dsn, database))

    cmd = [
        pg_dump,
        "--schema-only", "--no-owner", "--no-acl", "--no-comments",
        "-h", parsed.hostname or "localhost",
        "-p", str(parsed.port or 5432),
        "-U", parsed.username or "postgres",
        parsed.path.lstrip("/"),
    ]
    for schema in schemas:
        cmd += ["-n", schema]

    env = {**os.environ}
    if parsed.password:
        env["PGPASSWORD"] = parsed.password

    def _run() -> tuple[int, str, str]:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=120,
        )
        return result.returncode, result.stdout, result.stderr

    loop = asyncio.get_event_loop()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        returncode, stdout, stderr = await loop.run_in_executor(pool, _run)

    if returncode != 0:
        raise RuntimeError(f"pg_dump failed (exit {returncode}): {stderr[:600]}")

    return _post_process_pg_dump(stdout)


async def _dump_via_catalog(database: str, schemas: list[str]) -> list[str]:
    """Built-in DDL generator using pg_catalog. Covers common objects."""
    src_dsn = dsn_for_database(state.source_dsn, database)
    conn = await asyncpg.connect(src_dsn, timeout=30)
    statements = []

    try:
        schema_filter = schemas if schemas else None

        def schema_in(col: str) -> str:
            if schema_filter:
                placeholders = ", ".join(f"${i+1}" for i in range(len(schema_filter)))
                return f"{col} IN ({placeholders})"
            return f"{col} NOT IN ('pg_catalog','information_schema','pg_toast')"

        args = schema_filter or []

        # ── Schemas ──────────────────────────────────────────────────────────
        schema_rows = await conn.fetch(
            f"SELECT nspname FROM pg_namespace WHERE {schema_in('nspname')} ORDER BY nspname",
            *args
        )
        for r in schema_rows:
            statements.append(f'CREATE SCHEMA IF NOT EXISTS "{r["nspname"]}";')

        # ── Types (enum) ─────────────────────────────────────────────────────
        type_rows = await conn.fetch(f"""
            SELECT n.nspname, t.typname,
                   array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            JOIN pg_enum e ON e.enumtypid = t.oid
            WHERE t.typtype = 'e' AND {schema_in('n.nspname')}
            GROUP BY n.nspname, t.typname
            ORDER BY n.nspname, t.typname
        """, *args)
        for r in type_rows:
            labels = ", ".join(f"'{l}'" for l in r["labels"])
            statements.append(
                f'CREATE TYPE IF NOT EXISTS "{r["nspname"]}"."{r["typname"]}" AS ENUM ({labels});'
            )

        # ── Sequences ────────────────────────────────────────────────────────
        seq_rows = await conn.fetch(f"""
            SELECT n.nspname, c.relname,
                   s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcycle
            FROM pg_sequence s
            JOIN pg_class c ON c.oid = s.seqrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE {schema_in('n.nspname')}
            ORDER BY n.nspname, c.relname
        """, *args)
        for r in seq_rows:
            cycle = "CYCLE" if r["seqcycle"] else "NO CYCLE"
            statements.append(
                f'CREATE SEQUENCE IF NOT EXISTS "{r["nspname"]}"."{r["relname"]}" '
                f'START {r["seqstart"]} INCREMENT {r["seqincrement"]} '
                f'MINVALUE {r["seqmin"]} MAXVALUE {r["seqmax"]} {cycle};'
            )

        # ── Tables ───────────────────────────────────────────────────────────
        table_rows = await conn.fetch(f"""
            SELECT n.nspname, c.relname, c.oid,
                   c.relkind::text,
                   pg_get_partkeydef(c.oid) AS partkeydef,
                   c.relispartition,
                   pg_get_expr(c.relpartbound, c.oid) AS partbound,
                   (SELECT n2.nspname || '.' || p.relname
                    FROM pg_inherits i
                    JOIN pg_class p ON p.oid = i.inhparent
                    JOIN pg_namespace n2 ON n2.oid = p.relnamespace
                    WHERE i.inhrelid = c.oid LIMIT 1) AS parent
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p') AND NOT c.relispartition
              AND {schema_in('n.nspname')}
            ORDER BY n.nspname, c.relname
        """, *args)

        # partitions separately (after parents)
        part_rows = await conn.fetch(f"""
            SELECT n.nspname, c.relname, c.oid,
                   pg_get_expr(c.relpartbound, c.oid) AS partbound,
                   n2.nspname || '."' || p.relname || '"' AS parent_fq
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_inherits i ON i.inhrelid = c.oid
            JOIN pg_class p ON p.oid = i.inhparent
            JOIN pg_namespace n2 ON n2.oid = p.relnamespace
            WHERE c.relispartition AND {schema_in('n.nspname')}
            ORDER BY n.nspname, c.relname
        """, *args)

        async def col_ddl(oid: int) -> list[str]:
            cols = await conn.fetch("""
                SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ,
                       a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt,
                       a.attidentity
                FROM pg_attribute a
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum
            """, oid)
            pk = await conn.fetch("""
                SELECT a.attname FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = $1 AND i.indisprimary ORDER BY a.attnum
            """, oid)
            pk_cols = [r["attname"] for r in pk]
            defs = []
            for c in cols:
                d = f'  "{c["attname"]}" {c["typ"]}'
                if c["attidentity"] == "a":
                    d += " GENERATED ALWAYS AS IDENTITY"
                elif c["attidentity"] == "d":
                    d += " GENERATED BY DEFAULT AS IDENTITY"
                elif c["dflt"] and "nextval" not in (c["dflt"] or ""):
                    d += f" DEFAULT {c['dflt']}"
                if c["attnotnull"] and not c["attidentity"]:
                    d += " NOT NULL"
                defs.append(d)
            if pk_cols:
                pk_list = ", ".join(f'"{c}"' for c in pk_cols)
                defs.append(f'  PRIMARY KEY ({pk_list})')
            return defs

        for r in table_rows:
            col_defs = await col_ddl(r["oid"])
            body = ",\n".join(col_defs)
            if r["partkeydef"]:
                stmt = (f'CREATE TABLE IF NOT EXISTS "{r["nspname"]}"."{r["relname"]}" (\n'
                        f'{body}\n) PARTITION BY {r["partkeydef"]};')
            else:
                stmt = (f'CREATE TABLE IF NOT EXISTS "{r["nspname"]}"."{r["relname"]}" (\n'
                        f'{body}\n);')
            statements.append(stmt)

        for r in part_rows:
            statements.append(
                f'CREATE TABLE IF NOT EXISTS "{r["nspname"]}"."{r["relname"]}" '
                f'PARTITION OF {r["parent_fq"]} {r["partbound"]};'
            )

        # ── Indexes ──────────────────────────────────────────────────────────
        idx_rows = await conn.fetch(f"""
            SELECT n.nspname, c.relname AS tbl, i.relname AS idx,
                   pg_get_indexdef(ix.indexrelid) AS def,
                   ix.indisprimary
            FROM pg_index ix
            JOIN pg_class c ON c.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE NOT ix.indisprimary AND {schema_in('n.nspname')}
            ORDER BY n.nspname, c.relname, i.relname
        """, *args)
        for r in idx_rows:
            idef = re.sub(
                r'\bCREATE (UNIQUE )?INDEX\b(?!\s+IF\s+NOT\s+EXISTS)',
                r'CREATE \1INDEX IF NOT EXISTS',
                r["def"], flags=re.IGNORECASE
            )
            statements.append(f"{idef};")

        # ── Views ────────────────────────────────────────────────────────────
        view_rows = await conn.fetch(f"""
            SELECT n.nspname, c.relname, pg_get_viewdef(c.oid, true) AS def
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'v' AND {schema_in('n.nspname')}
            ORDER BY n.nspname, c.relname
        """, *args)
        for r in view_rows:
            statements.append(
                f'CREATE OR REPLACE VIEW "{r["nspname"]}"."{r["relname"]}" AS\n{r["def"]};'
            )

        # ── Functions & Procedures ───────────────────────────────────────────
        func_rows = await conn.fetch(f"""
            SELECT n.nspname, p.proname, pg_get_functiondef(p.oid) AS def
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE {schema_in('n.nspname')}
              AND p.prokind IN ('f', 'p')
            ORDER BY n.nspname, p.proname
        """, *args)
        for r in func_rows:
            fdef = re.sub(
                r'\bCREATE (OR REPLACE )?(FUNCTION|PROCEDURE)\b',
                r'CREATE OR REPLACE \2',
                r["def"], flags=re.IGNORECASE
            )
            statements.append(f"{fdef.strip()};")

    finally:
        await conn.close()

    return statements


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.get("/config")
async def get_dump_config():
    """Return current pg_dump path config and whether binary exists."""
    path = state.pg_dump_path.strip()
    exists = bool(path) and os.path.isfile(path)
    return {
        "pg_dump_path": path,
        "pg_dump_available": exists,
        "strategy": "pg_dump" if exists else "generator",
    }


@router.post("/config")
async def set_dump_config(body: dict):
    """Set pg_dump binary path."""
    path: str = body.get("pg_dump_path", "").strip()
    if path and not os.path.isfile(path):
        raise HTTPException(400, f"pg_dump not found at: {path}")
    state.pg_dump_path = path
    state.persist()
    return {"pg_dump_path": path, "strategy": "pg_dump" if path else "generator"}


@router.post("/dump")
async def dump_schema(body: dict):
    """
    Generate schema DDL for specified database and schemas.
    body: { "database": "dbname", "schemas": ["schema1", ...] }
    Returns list of SQL statements ready for review and apply.
    """
    from .. import state as _state
    if not _state.source_dsn:
        raise HTTPException(400, "Not connected.")

    database: str = body.get("database", "")
    schemas: list[str] = body.get("schemas", [])
    if not database:
        raise HTTPException(400, "database is required.")

    import os
    pg_dump = state.pg_dump_path.strip()
    use_pg_dump = bool(pg_dump) and os.path.isfile(pg_dump) and os.access(pg_dump, os.X_OK)

    try:
        if use_pg_dump:
            stmts = await _dump_via_pg_dump(database, schemas)
            strategy = "pg_dump"
        else:
            stmts = await _dump_via_catalog(database, schemas)
            strategy = "generator"
    except Exception as e:
        raise HTTPException(500, str(e))

    return {
        "strategy": strategy,
        "database": database,
        "schemas": schemas,
        "statement_count": len(stmts),
        "statements": stmts,
    }


@router.post("/apply")
async def apply_schema(body: dict):
    """
    Apply schema statements on destination database.
    body: { "database": "dbname", "statements": ["...", ...], "stop_on_error": false }
    """
    from .. import state as _state
    if not _state.dest_dsn:
        raise HTTPException(400, "Not connected.")

    database: str = body.get("database", "")
    statements: list[str] = body.get("statements", [])
    stop_on_error: bool = body.get("stop_on_error", False)

    if not database or not statements:
        raise HTTPException(400, "database and statements are required.")

    dest_dsn = dsn_for_database(state.dest_dsn, database)
    conn = await asyncpg.connect(dest_dsn, timeout=30)
    results = []
    applied = 0
    failed = 0

    try:
        for stmt in statements:
            try:
                await conn.execute(stmt)
                results.append({"sql": stmt[:120], "ok": True})
                applied += 1
            except Exception as e:
                results.append({"sql": stmt[:120], "ok": False, "error": str(e)})
                failed += 1
                if stop_on_error:
                    break
    finally:
        await conn.close()

    return {
        "applied": applied,
        "failed": failed,
        "results": results,
    }
