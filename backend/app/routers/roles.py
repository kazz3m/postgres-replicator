"""
Roles & grants migration — pg_dumpall --globals-only compatible.

Generates CREATE ROLE / ALTER ROLE / GRANT statements from source cluster
and applies them on the destination cluster.  Mirrors the SQL queries that
pg_dumpall uses internally so the output is drop-in compatible.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import asyncpg

from ..db import get_source_pool, get_dest_pool
from .. import state

router = APIRouter(prefix="/api/roles", tags=["roles"])


# ── Models ─────────────────────────────────────────────────────────────────────

class RoleStatement(BaseModel):
    sql: str                        # display SQL (joined for multi-step blocks)
    kind: str                       # create_role | alter_role | grant_membership | grant_schema | grant_table | grant_default | comment
    role: str                       # primary role name this statement concerns
    exists_on_dest: bool = False    # True → role already present; statement is ALTER, not CREATE
    warning: Optional[str] = None   # e.g. "password unavailable on Cloud SQL"
    database: Optional[str] = None  # for per-db grants: which database to connect to on dest
    steps: Optional[List[str]] = None  # if set, execute each step in order as one logical unit


class RolesDiffResponse(BaseModel):
    statements: List[RoleStatement]
    skipped_system_roles: List[str]
    password_available: bool   # False on Cloud SQL / RDS
    dest_is_cloudsql: bool     # True → SUPERUSER/REPLICATION options stripped


class ApplyStatement(BaseModel):
    sql: str
    database: Optional[str] = None   # if set, connect to this database on dest instead of the DSN default
    steps: Optional[List[str]] = None  # if set, execute each step sequentially as one logical unit


class RolesApplyRequest(BaseModel):
    statements: List[ApplyStatement]
    stop_on_error: bool = False


class StatementResult(BaseModel):
    sql: str
    ok: bool
    error: Optional[str] = None


class RolesApplyResponse(BaseModel):
    results: List[StatementResult]
    applied: int
    failed: int


# ── Helpers ───────────────────────────────────────────────────────────────────

def _q(s: str) -> str:
    """Quote a PostgreSQL identifier."""
    return '"' + s.replace('"', '""') + '"'


def _role_options(row: dict, dest_is_cloudsql: bool = False) -> str:
    """Build ALTER ROLE ... WITH ... option string from pg_authid row.

    Cloud SQL (destination) rejects SUPERUSER, NOSUPERUSER, REPLICATION,
    NOREPLICATION and BYPASSRLS — those options are omitted when dest_is_cloudsql.
    """
    parts = []
    if not dest_is_cloudsql:
        parts.append("SUPERUSER" if row["rolsuper"] else "NOSUPERUSER")
    parts.append("INHERIT" if row["rolinherit"] else "NOINHERIT")
    parts.append("CREATEROLE" if row["rolcreaterole"] else "NOCREATEROLE")
    parts.append("CREATEDB" if row["rolcreatedb"] else "NOCREATEDB")
    parts.append("LOGIN" if row["rolcanlogin"] else "NOLOGIN")
    parts.append("REPLICATION" if row["rolreplication"] else "NOREPLICATION")
    parts.append("BYPASSRLS" if row["rolbypassrls"] else "NOBYPASSRLS")
    if row["rolconnlimit"] != -1:
        parts.append(f"CONNECTION LIMIT {row['rolconnlimit']}")
    if row["rolvaliduntil"] is not None:
        parts.append(f"VALID UNTIL '{row['rolvaliduntil']}'")
    return " ".join(parts)


def _unpack_acl(acl_string: str):
    """
    Parse one entry from an ACL array element.
    Format:  grantee=privs/grantor
    Returns (grantee, privs, grantor) — grantee '' means PUBLIC.
    """
    if "=" not in acl_string:
        return None
    grantee, rest = acl_string.split("=", 1)
    privs, grantor = rest.split("/", 1) if "/" in rest else (rest, "")
    return grantee or "PUBLIC", privs, grantor


_SCHEMA_PRIV_MAP = {"U": "USAGE", "C": "CREATE"}
_TABLE_PRIV_MAP  = {
    "r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE",
    "D": "TRUNCATE", "x": "REFERENCES", "t": "TRIGGER",
}


# ── Globals diff (roles + memberships) ────────────────────────────────────────

async def _globals_statements(
    src_conn: asyncpg.Connection,
    dest_roles: set,
    password_available: bool,
    dest_is_cloudsql: bool = False,
) -> List[RoleStatement]:
    stmts: List[RoleStatement] = []

    # --- Role definitions (mirrors pg_dumpall globals section) ---
    rows = await src_conn.fetch("""
        SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
               rolcanlogin, rolreplication, rolbypassrls, rolconnlimit,
               rolpassword, rolvaliduntil
        FROM pg_authid
        WHERE LEFT(rolname, 3) <> 'pg_'
          AND rolname NOT IN ('replication')
        ORDER BY rolname
    """)

    for row in rows:
        name = row["rolname"]
        exists = name in dest_roles
        options = _role_options(dict(row), dest_is_cloudsql=dest_is_cloudsql)

        if not exists:
            stmts.append(RoleStatement(
                sql=f"CREATE ROLE {_q(name)};",
                kind="create_role", role=name, exists_on_dest=False,
            ))

        stmts.append(RoleStatement(
            sql=f"ALTER ROLE {_q(name)} WITH {options};",
            kind="alter_role", role=name, exists_on_dest=exists,
        ))

        # Password — only if available and role can login
        pwd = row["rolpassword"]
        if pwd and row["rolcanlogin"]:
            if password_available:
                stmts.append(RoleStatement(
                    sql=f"ALTER ROLE {_q(name)} WITH PASSWORD '{pwd}';",
                    kind="alter_role", role=name, exists_on_dest=exists,
                ))
            else:
                stmts.append(RoleStatement(
                    sql=f"-- ALTER ROLE {_q(name)} WITH PASSWORD '...';  -- password hash unavailable",
                    kind="comment", role=name, exists_on_dest=exists,
                    warning="Password hash not readable (Cloud SQL / RDS). Set password manually.",
                ))

    # --- Role memberships ---
    members = await src_conn.fetch("""
        SELECT ur.rolname AS role, um.rolname AS member,
               m.admin_option
        FROM pg_auth_members m
        JOIN pg_authid ur ON ur.oid = m.roleid
        JOIN pg_authid um ON um.oid = m.member
        WHERE LEFT(um.rolname, 3) <> 'pg_'
        ORDER BY ur.rolname, um.rolname
    """)
    for row in members:
        admin = " WITH ADMIN OPTION" if row["admin_option"] else ""
        stmts.append(RoleStatement(
            sql=f"GRANT {_q(row['role'])} TO {_q(row['member'])}{admin};",
            kind="grant_membership",
            role=row["role"],
            exists_on_dest=row["role"] in dest_roles,
        ))

    # --- Per-role GUC settings (ALTER ROLE ... SET ...) ---
    settings = await src_conn.fetch("""
        SELECT r.rolname, d.datname, s.setconfig
        FROM pg_db_role_setting s
        JOIN pg_authid r ON r.oid = s.setrole
        LEFT JOIN pg_database d ON d.oid = s.setdatabase
        WHERE LEFT(r.rolname, 3) <> 'pg_'
          AND r.rolname NOT IN ('replication')
        ORDER BY r.rolname, d.datname NULLS FIRST
    """)
    for row in settings:
        name = row["rolname"]
        db_clause = f" IN DATABASE {_q(row['datname'])}" if row["datname"] else ""
        for setting in (row["setconfig"] or []):
            if "=" not in setting:
                continue
            key, val = setting.split("=", 1)
            stmts.append(RoleStatement(
                sql=f"ALTER ROLE {_q(name)}{db_clause} SET {key} = '{val}';",
                kind="alter_role_set",
                role=name,
                exists_on_dest=name in dest_roles,
            ))

    return stmts


# ── Per-database grants (schema + table + default privileges) ─────────────────

async def _db_grant_statements(
    src_dsn: str,
    database: str,
    non_system_roles: set,
) -> List[RoleStatement]:
    stmts: List[RoleStatement] = []

    import urllib.parse
    parsed = urllib.parse.urlparse(src_dsn)
    db_dsn = urllib.parse.urlunparse(parsed._replace(path="/" + urllib.parse.quote(database, safe="")))

    try:
        conn = await asyncpg.connect(db_dsn)
    except Exception:
        return stmts  # skip unreachable databases silently

    try:
        # Schema grants — unpack nspacl
        schemas = await conn.fetch("""
            SELECT nspname, nspacl
            FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\\_toast%'
              AND nspname NOT LIKE 'pg\\_temp%'
              AND nspname <> 'information_schema'
            ORDER BY nspname
        """)
        for row in schemas:
            if not row["nspacl"]:
                continue
            for entry in row["nspacl"]:
                parsed_acl = _unpack_acl(entry)
                if not parsed_acl:
                    continue
                grantee, privs, _ = parsed_acl
                if grantee != "PUBLIC" and grantee not in non_system_roles:
                    continue
                grants = [_SCHEMA_PRIV_MAP[c] for c in privs if c in _SCHEMA_PRIV_MAP]
                if not grants:
                    continue
                grantee_sql = "PUBLIC" if grantee == "PUBLIC" else _q(grantee)
                stmts.append(RoleStatement(
                    sql=f"GRANT {', '.join(grants)} ON SCHEMA {_q(row['nspname'])} TO {grantee_sql};",
                    kind="grant_schema",
                    role=grantee if grantee != "PUBLIC" else "__public__",
                    database=database,
                ))

        # Table grants — information_schema view (standard, no superuser needed)
        table_grants = await conn.fetch("""
            SELECT grantee, table_schema, table_name, privilege_type, is_grantable
            FROM information_schema.role_table_grants
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              AND grantor <> grantee
            ORDER BY grantee, table_schema, table_name, privilege_type
        """)
        # Collapse per (grantee, table) for compact GRANT statements
        from collections import defaultdict
        collapsed: dict = defaultdict(lambda: {"privs": [], "grantable": False})
        for row in table_grants:
            key = (row["grantee"], row["table_schema"], row["table_name"])
            collapsed[key]["privs"].append(row["privilege_type"])
            if row["is_grantable"] == "YES":
                collapsed[key]["grantable"] = True

        for (grantee, schema, table), info in collapsed.items():
            if grantee not in non_system_roles and grantee != "PUBLIC":
                continue
            go = " WITH GRANT OPTION" if info["grantable"] else ""
            grantee_sql = "PUBLIC" if grantee == "PUBLIC" else _q(grantee)
            stmts.append(RoleStatement(
                sql=f"GRANT {', '.join(sorted(info['privs']))} ON TABLE {_q(schema)}.{_q(table)} TO {grantee_sql}{go};",
                kind="grant_table",
                role=grantee if grantee != "PUBLIC" else "__public__",
                database=database,
            ))

        # Default privileges — pg_default_acl
        # ALTER DEFAULT PRIVILEGES FOR ROLE X requires membership in X.
        # We wrap each owner's block with GRANT/REVOKE so the executing user
        # temporarily assumes the role, following the pg_dumpall pattern.
        def_acls = await conn.fetch("""
            SELECT r.rolname AS owner,
                   n.nspname AS schema,
                   d.defaclobjtype::text AS defaclobjtype,
                   d.defaclacl
            FROM pg_default_acl d
            JOIN pg_authid r ON r.oid = d.defaclrole
            LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
            ORDER BY owner, schema, defaclobjtype
        """)
        obj_type_map = {"r": "TABLES", "S": "SEQUENCES", "f": "FUNCTIONS", "T": "TYPES", "n": "SCHEMAS"}

        # Collect per-owner so we can bracket with GRANT/REVOKE
        from collections import defaultdict
        owner_stmts: dict = defaultdict(list)

        for row in def_acls:
            obj_type = obj_type_map.get(row["defaclobjtype"], row["defaclobjtype"])
            schema_clause = f" IN SCHEMA {_q(row['schema'])}" if row["schema"] else ""
            for entry in (row["defaclacl"] or []):
                parsed_acl = _unpack_acl(entry)
                if not parsed_acl:
                    continue
                grantee, privs, _ = parsed_acl
                if grantee != "PUBLIC" and grantee not in non_system_roles:
                    continue
                if obj_type == "TABLES":
                    grants = [_TABLE_PRIV_MAP[c] for c in privs if c in _TABLE_PRIV_MAP]
                elif obj_type == "SEQUENCES":
                    seq_map = {"r": "SELECT", "w": "UPDATE", "U": "USAGE"}
                    grants = [seq_map[c] for c in privs if c in seq_map]
                elif obj_type == "FUNCTIONS":
                    func_map = {"X": "EXECUTE"}
                    grants = [func_map[c] for c in privs if c in func_map]
                elif obj_type == "TYPES":
                    type_map = {"U": "USAGE"}
                    grants = [type_map[c] for c in privs if c in type_map]
                elif obj_type == "SCHEMAS":
                    schema_map = {"U": "USAGE", "C": "CREATE"}
                    grants = [schema_map[c] for c in privs if c in schema_map]
                else:
                    grants = list(privs)
                if not grants:
                    continue
                grantee_sql = "PUBLIC" if grantee == "PUBLIC" else _q(grantee)
                owner_stmts[row["owner"]].append(RoleStatement(
                    sql=(f"ALTER DEFAULT PRIVILEGES FOR ROLE {_q(row['owner'])}"
                         f"{schema_clause} GRANT {', '.join(grants)} ON {obj_type} TO {grantee_sql};"),
                    kind="grant_default",
                    role=grantee if grantee != "PUBLIC" else "__public__",
                    database=database,
                ))

        for owner, owner_block in owner_stmts.items():
            steps = (
                [f"GRANT {_q(owner)} TO CURRENT_USER;"]
                + [f"SET ROLE {_q(owner)};"]
                + [s.sql for s in owner_block]
                + ["RESET ROLE;"]
                + [f"REVOKE {_q(owner)} FROM CURRENT_USER;"]
            )
            display_sql = "\n".join(steps)
            stmts.append(RoleStatement(
                sql=display_sql,
                kind="grant_default",
                role=owner,
                database=database,
                steps=steps,
            ))
    finally:
        await conn.close()

    return stmts


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/diff", response_model=RolesDiffResponse)
async def roles_diff(include_databases: bool = True):
    """
    Generate pg_dumpall-compatible DDL statements to migrate roles and grants
    from source to destination.  Statements are returned for preview/editing
    before applying.
    """
    if not state.source_dsn:
        raise HTTPException(400, "Not connected.")

    src_pool = await get_source_pool(state.source_dsn)
    dest_pool = await get_dest_pool(state.dest_dsn)

    async with src_pool.acquire() as src_conn, dest_pool.acquire() as dest_conn:
        # Check if password hashes are readable (superuser-only column)
        try:
            await src_conn.fetchval("SELECT rolpassword FROM pg_authid LIMIT 1")
            password_available = True
        except asyncpg.InsufficientPrivilegeError:
            password_available = False

        # Detect Cloud SQL on destination — it always has the cloudsqlsuperuser role
        dest_is_cloudsql = await dest_conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser')"
        )

        # Roles already present on destination
        dest_role_rows = await dest_conn.fetch(
            "SELECT rolname FROM pg_roles WHERE LEFT(rolname, 3) <> 'pg_'"
        )
        dest_roles = {r["rolname"] for r in dest_role_rows}

        # Roles present on source (non-system) — for grant filtering
        src_role_rows = await src_conn.fetch(
            "SELECT rolname FROM pg_authid WHERE LEFT(rolname, 3) <> 'pg_'"
        )
        non_system_roles = {r["rolname"] for r in src_role_rows}

        skipped = [r for r in dest_roles if r.startswith("pg_")]

        stmts = await _globals_statements(
            src_conn, dest_roles, password_available, dest_is_cloudsql=dest_is_cloudsql
        )

    # Per-database grants — use separate connections outside the pool
    if include_databases:
        db_conn = await asyncpg.connect(state.source_dsn)
        try:
            dbs = await db_conn.fetch("""
                SELECT datname FROM pg_database
                WHERE datistemplate = false AND datname NOT IN ('postgres')
                ORDER BY datname
            """)
        finally:
            await db_conn.close()

        for row in dbs:
            db_stmts = await _db_grant_statements(
                state.source_dsn, row["datname"], non_system_roles
            )
            stmts.extend(db_stmts)

    return RolesDiffResponse(
        statements=stmts,
        skipped_system_roles=skipped,
        password_available=password_available,
        dest_is_cloudsql=dest_is_cloudsql,
    )


@router.post("/apply", response_model=RolesApplyResponse)
async def roles_apply(body: RolesApplyRequest):
    """
    Execute the provided SQL statements on the destination cluster.
    Statements with a database field are executed against that specific database on dest.
    Statements without a database field are executed on the dest DSN default database.
    Statements that are comments (start with --) are skipped automatically.
    """
    if not state.dest_dsn:
        raise HTTPException(400, "Not connected.")

    import urllib.parse

    def _dsn_for_db(base_dsn: str, database: Optional[str]) -> str:
        if not database:
            return base_dsn
        parsed = urllib.parse.urlparse(base_dsn)
        return urllib.parse.urlunparse(
            parsed._replace(path="/" + urllib.parse.quote(database, safe=""))
        )

    results: List[StatementResult] = []
    applied = 0
    failed = 0

    # Cache open connections per database to avoid reconnecting per statement.
    # None sentinel means "connection failed" — skip all statements for that db.
    conns: dict = {}
    try:
        for item in body.statements:
            stripped = item.sql.strip()
            if not stripped or stripped.startswith("--"):
                continue

            dsn = _dsn_for_db(state.dest_dsn, item.database)
            if dsn not in conns:
                try:
                    conns[dsn] = await asyncpg.connect(dsn)
                except Exception as e:
                    conns[dsn] = None  # mark as unreachable so we don't retry
                    db_label = item.database or "(default)"
                    results.append(StatementResult(
                        sql=item.sql, ok=False,
                        error=f"Cannot connect to database '{db_label}' on destination: {e}",
                    ))
                    failed += 1
                    if body.stop_on_error:
                        break
                    continue

            conn = conns[dsn]
            if conn is None:
                # Database unreachable — skip silently (already counted above)
                results.append(StatementResult(
                    sql=item.sql, ok=False,
                    error=f"Skipped — database '{item.database or '(default)'}' not reachable on destination",
                ))
                failed += 1
                if body.stop_on_error:
                    break
                continue

            try:
                if item.steps:
                    # steps[0] is always: GRANT "owner" TO CURRENT_USER
                    # Extract owner name to verify it exists on dest before attempting SET ROLE.
                    import re as _re
                    m = _re.match(r'^GRANT\s+"([^"]+)"\s+TO\s+CURRENT_USER', item.steps[0])
                    owner_name = m.group(1) if m else None
                    if owner_name:
                        exists = await conn.fetchval(
                            "SELECT 1 FROM pg_roles WHERE rolname = $1", owner_name
                        )
                        if not exists:
                            results.append(StatementResult(
                                sql=item.sql, ok=False,
                                error=(
                                    f"Skipped: role \"{owner_name}\" does not exist on destination. "
                                    f"Apply CREATE ROLE statements first, then re-run default privileges."
                                ),
                            ))
                            failed += 1
                            if body.stop_on_error:
                                break
                            continue

                    # GRANT membership is only visible to new connections in PG.
                    # Pattern: GRANT on current conn → new conn for SET ROLE + work → REVOKE on current conn.
                    grant_step = item.steps[0]
                    revoke_step = item.steps[-1]
                    inner_steps = item.steps[1:-1]  # SET ROLE ... ALTER ... RESET ROLE
                    await conn.execute(grant_step)
                    new_conn = await asyncpg.connect(dsn)
                    try:
                        for step in inner_steps:
                            await new_conn.execute(step)
                    finally:
                        await new_conn.close()
                    await conn.execute(revoke_step)
                else:
                    await conn.execute(stripped)
                results.append(StatementResult(sql=item.sql, ok=True))
                applied += 1
            except Exception as e:
                if item.steps:
                    try:
                        await conn.execute("RESET ROLE")
                    except Exception:
                        pass
                    try:
                        await conn.execute(item.steps[-1])  # REVOKE
                    except Exception:
                        pass
                err = str(e)
                results.append(StatementResult(sql=item.sql, ok=False, error=err))
                failed += 1
                if body.stop_on_error:
                    break
    finally:
        for conn in conns.values():
            try:
                await conn.close()
            except Exception:
                pass

    return RolesApplyResponse(results=results, applied=applied, failed=failed)
