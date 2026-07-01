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
    kind: str                       # create_role | alter_role | alter_role_set | grant_membership | grant_schema | grant_table | grant_default | alter_owner | create_extension | comment
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
    kind: Optional[str] = None
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
    # PostgreSQL quotes role names containing special chars: "svc-foo"=rwx/bar
    if grantee.startswith('"') and grantee.endswith('"'):
        grantee = grantee[1:-1].replace('""', '"')
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


async def _database_owner_statements(
    src_conn: asyncpg.Connection,
    non_system_roles: set,
    dest_roles: set,
) -> List[RoleStatement]:
    """ALTER DATABASE x OWNER TO y — emitted at globals level (no per-db connection needed)."""
    stmts: List[RoleStatement] = []
    rows = await src_conn.fetch("""
        SELECT d.datname, r.rolname AS owner
        FROM pg_database d
        JOIN pg_authid r ON r.oid = d.datdba
        WHERE d.datistemplate = false
          AND d.datname NOT IN ('postgres')
        ORDER BY d.datname
    """)
    for row in rows:
        owner = row["owner"]
        if owner not in non_system_roles:
            continue
        warning = None
        if dest_roles and owner not in dest_roles:
            warning = f"Role \"{owner}\" does not exist on destination yet — apply CREATE ROLE first."
        stmts.append(RoleStatement(
            sql=f"ALTER DATABASE {_q(row['datname'])} OWNER TO {_q(owner)};",
            kind="alter_owner",
            role=owner,
            warning=warning,
        ))
    return stmts


# ── Per-database grants (schema + table + default privileges) ─────────────────

async def _db_grant_statements(
    src_dsn: str,
    database: str,
    non_system_roles: set,
    dest_roles: set = frozenset(),
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
                if grantee != "PUBLIC" and dest_roles and grantee not in dest_roles:
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

        # Table grants — read relacl directly to avoid information_schema visibility
        # restrictions (it only shows grants for roles the current user is a member of).
        table_acl_rows = await conn.fetch("""
            SELECT n.nspname AS schema, c.relname AS table, c.relacl
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','v','m','f','p')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg\\_toast%'
              AND n.nspname NOT LIKE 'pg\\_temp%'
              AND c.relacl IS NOT NULL
            ORDER BY n.nspname, c.relname
        """)
        _TABLE_PRIV_MAP = {
            "r": "SELECT", "w": "UPDATE", "a": "INSERT", "d": "DELETE",
            "D": "TRUNCATE", "x": "REFERENCES", "t": "TRIGGER",
        }
        from collections import defaultdict
        collapsed: dict = defaultdict(lambda: {"privs": set(), "grantable": False})
        for row in table_acl_rows:
            for entry in row["relacl"]:
                parsed_acl = _unpack_acl(entry)
                if not parsed_acl:
                    continue
                grantee, privs, _grantor = parsed_acl
                if grantee != "PUBLIC" and grantee not in non_system_roles:
                    continue
                if grantee != "PUBLIC" and dest_roles and grantee not in dest_roles:
                    continue
                key = (grantee, row["schema"], row["table"])
                # '*' after a priv letter means WITH GRANT OPTION: e.g. "rw*a"
                has_grant_option = "*" in privs
                for c in privs:
                    if c in _TABLE_PRIV_MAP:
                        collapsed[key]["privs"].add(_TABLE_PRIV_MAP[c])
                if has_grant_option:
                    collapsed[key]["grantable"] = True

        for (grantee, schema, table), info in collapsed.items():
            if not info["privs"]:
                continue
            go = " WITH GRANT OPTION" if info["grantable"] else ""
            grantee_sql = "PUBLIC" if grantee == "PUBLIC" else _q(grantee)
            stmts.append(RoleStatement(
                sql=f"GRANT {', '.join(sorted(info['privs']))} ON TABLE {_q(schema)}.{_q(table)} TO {grantee_sql}{go};",
                kind="grant_table",
                role=grantee if grantee != "PUBLIC" else "__public__",
                database=database,
            ))

        # Sequence grants — relacl on sequences (USAGE, SELECT, UPDATE)
        seq_acl_rows = await conn.fetch("""
            SELECT n.nspname AS schema, c.relname AS sequence, c.relacl
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'S'
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg\\_toast%'
              AND n.nspname NOT LIKE 'pg\\_temp%'
              AND c.relacl IS NOT NULL
            ORDER BY n.nspname, c.relname
        """)
        _SEQ_PRIV_MAP = {"r": "SELECT", "w": "UPDATE", "U": "USAGE"}
        seq_collapsed: dict = defaultdict(lambda: {"privs": set(), "grantable": False})
        for row in seq_acl_rows:
            for entry in row["relacl"]:
                parsed_acl = _unpack_acl(entry)
                if not parsed_acl:
                    continue
                grantee, privs, _grantor = parsed_acl
                if grantee != "PUBLIC" and grantee not in non_system_roles:
                    continue
                if grantee != "PUBLIC" and dest_roles and grantee not in dest_roles:
                    continue
                key = (grantee, row["schema"], row["sequence"])
                has_grant_option = "*" in privs
                for c in privs:
                    if c in _SEQ_PRIV_MAP:
                        seq_collapsed[key]["privs"].add(_SEQ_PRIV_MAP[c])
                if has_grant_option:
                    seq_collapsed[key]["grantable"] = True

        for (grantee, schema, seq), info in seq_collapsed.items():
            if not info["privs"]:
                continue
            go = " WITH GRANT OPTION" if info["grantable"] else ""
            grantee_sql = "PUBLIC" if grantee == "PUBLIC" else _q(grantee)
            stmts.append(RoleStatement(
                sql=f"GRANT {', '.join(sorted(info['privs']))} ON SEQUENCE {_q(schema)}.{_q(seq)} TO {grantee_sql}{go};",
                kind="grant_sequence",
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
                if grantee != "PUBLIC" and dest_roles and grantee not in dest_roles:
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

        # Schema owners
        schema_owners = await conn.fetch("""
            SELECT n.nspname, r.rolname AS owner
            FROM pg_namespace n
            JOIN pg_authid r ON r.oid = n.nspowner
            WHERE n.nspname NOT LIKE 'pg\\_%'
              AND n.nspname <> 'information_schema'
            ORDER BY n.nspname
        """)
        for row in schema_owners:
            owner = row["owner"]
            if owner not in non_system_roles:
                continue
            warning = None
            if dest_roles and owner not in dest_roles:
                warning = f"Role \"{owner}\" does not exist on destination yet."
            stmts.append(RoleStatement(
                sql=f"ALTER SCHEMA {_q(row['nspname'])} OWNER TO {_q(owner)};",
                kind="alter_owner",
                role=owner,
                database=database,
                warning=warning,
            ))

        # Table / view / materialized view / sequence / foreign table owners
        obj_owners = await conn.fetch("""
            SELECT n.nspname, c.relname, c.relkind::text AS relkind, r.rolname AS owner
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_authid r ON r.oid = c.relowner
            WHERE c.relkind IN ('r','v','m','S','f','p')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg\\_%'
            ORDER BY n.nspname, c.relname
        """)
        _relkind_sql = {'r': 'TABLE', 'v': 'VIEW', 'm': 'MATERIALIZED VIEW', 'S': 'SEQUENCE', 'f': 'FOREIGN TABLE', 'p': 'TABLE'}
        for row in obj_owners:
            owner = row["owner"]
            if owner not in non_system_roles:
                continue
            warning = None
            if dest_roles and owner not in dest_roles:
                warning = f"Role \"{owner}\" does not exist on destination yet."
            obj_type = _relkind_sql.get(row["relkind"], "TABLE")
            stmts.append(RoleStatement(
                sql=f"ALTER {obj_type} {_q(row['nspname'])}.{_q(row['relname'])} OWNER TO {_q(owner)};",
                kind="alter_owner",
                role=owner,
                database=database,
                warning=warning,
            ))

        # Function / procedure definitions (excluding extension-owned routines)
        routine_defs = await conn.fetch("""
            SELECT p.oid,
                   n.nspname,
                   p.proname,
                   p.prokind::text AS prokind,
                   pg_get_function_identity_arguments(p.oid) AS args,
                   pg_get_functiondef(p.oid) AS definition,
                   r.rolname AS owner
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            JOIN pg_authid r ON r.oid = p.proowner
            WHERE n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg\\_%'
              AND p.prokind <> 'a'
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d
                JOIN pg_extension e ON e.oid = d.refobjid
                WHERE d.classid = 'pg_proc'::regclass
                  AND d.objid = p.oid
                  AND d.deptype = 'e'
              )
            ORDER BY n.nspname, p.proname
        """)
        for row in routine_defs:
            stmts.append(RoleStatement(
                sql=row["definition"].strip() + ";",
                kind="create_routine",
                role=row["owner"],
                database=database,
            ))

        # Function / procedure owners
        routine_owners = await conn.fetch("""
            SELECT n.nspname,
                   p.proname,
                   p.prokind::text AS prokind,
                   pg_get_function_identity_arguments(p.oid) AS args,
                   r.rolname AS owner
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            JOIN pg_authid r ON r.oid = p.proowner
            WHERE n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg\\_%'
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d
                JOIN pg_extension e ON e.oid = d.refobjid
                WHERE d.classid = 'pg_proc'::regclass
                  AND d.objid = p.oid
                  AND d.deptype = 'e'
              )
            ORDER BY n.nspname, p.proname
        """)
        _prokind_sql = {'f': 'FUNCTION', 'p': 'PROCEDURE', 'a': 'AGGREGATE', 'w': 'FUNCTION'}
        for row in routine_owners:
            owner = row["owner"]
            if owner not in non_system_roles:
                continue
            warning = None
            if dest_roles and owner not in dest_roles:
                warning = f"Role \"{owner}\" does not exist on destination yet."
            obj_type = _prokind_sql.get(row["prokind"], "FUNCTION")
            stmts.append(RoleStatement(
                sql=f"ALTER {obj_type} {_q(row['nspname'])}.{_q(row['proname'])}({row['args']}) OWNER TO {_q(owner)};",
                kind="alter_owner",
                role=owner,
                database=database,
                warning=warning,
            ))

        # Event triggers
        event_triggers = await conn.fetch("""
            SELECT e.evtname, e.evtevent, r.rolname AS owner,
                   e.evtenabled,
                   n.nspname AS func_schema, p.proname AS func_name
            FROM pg_event_trigger e
            JOIN pg_authid r ON r.oid = e.evtowner
            JOIN pg_proc p ON p.oid = e.evtfoid
            JOIN pg_namespace n ON n.oid = p.pronamespace
            ORDER BY e.evtname
        """)
        _evtenabled = {'O': 'ENABLE', 'D': 'DISABLE', 'R': 'ENABLE REPLICA', 'A': 'ENABLE ALWAYS'}
        for row in event_triggers:
            owner = row["owner"]
            warning = None
            if dest_roles and owner not in dest_roles:
                warning = f"Role \"{owner}\" does not exist on destination yet."
            func_ref = f"{_q(row['func_schema'])}.{_q(row['func_name'])}"
            stmts.append(RoleStatement(
                sql=(
                    f"CREATE EVENT TRIGGER {_q(row['evtname'])}\n"
                    f"  ON {row['evtevent']}\n"
                    f"  EXECUTE FUNCTION {func_ref}();"
                ),
                kind="create_event_trigger",
                role=owner,
                database=database,
                warning=warning,
            ))
            stmts.append(RoleStatement(
                sql=f"ALTER EVENT TRIGGER {_q(row['evtname'])} OWNER TO {_q(owner)};",
                kind="alter_owner",
                role=owner,
                database=database,
                warning=warning,
            ))
            enabled_clause = _evtenabled.get(row["evtenabled"], "ENABLE")
            if enabled_clause != "ENABLE":
                stmts.append(RoleStatement(
                    sql=f"ALTER EVENT TRIGGER {_q(row['evtname'])} {enabled_clause};",
                    kind="create_event_trigger",
                    role=owner,
                    database=database,
                ))

        # Extensions — create on dest if missing
        extensions = await conn.fetch("""
            SELECT e.extname, n.nspname AS schema
            FROM pg_extension e
            JOIN pg_namespace n ON n.oid = e.extnamespace
            ORDER BY e.extname
        """)
        for row in extensions:
            stmts.append(RoleStatement(
                sql=f"CREATE EXTENSION IF NOT EXISTS {_q(row['extname'])} SCHEMA {_q(row['schema'])};",
                kind="create_extension",
                role="__extension__",
                database=database,
            ))

        for owner, owner_block in owner_stmts.items():
            # ALTER DEFAULT PRIVILEGES FOR ROLE X only requires membership in X,
            # not an active SET ROLE. We GRANT on conn1, reconnect so membership
            # is visible, run ALTER DEFAULT PRIVILEGES, then REVOKE on conn1.
            steps = (
                [f"GRANT {_q(owner)} TO CURRENT_USER;"]
                + [s.sql for s in owner_block]
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
        stmts += await _database_owner_statements(src_conn, non_system_roles, dest_roles)

        # Prepend a single "grant all roles to current user" block.
        # Required so that ALTER ... OWNER TO <role> succeeds on Cloud SQL
        # (current_user must be a member of the target role).
        # We read roles from destination so only already-created roles are included.
        current_user_row = await dest_conn.fetchval("SELECT current_user")
        # Exclude roles that are already members of current_user — granting them
        # to current_user would create a circular membership and PostgreSQL rejects it.
        members_of_current_user = {
            r["rolname"] for r in await dest_conn.fetch("""
                SELECT r.rolname
                FROM pg_auth_members m
                JOIN pg_roles r ON r.oid = m.member
                WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
            """)
        }
        grantable_roles = sorted(
            r for r in dest_roles
            if not r.startswith("pg_")
            and not r.startswith("cloudsql")
            and r != current_user_row
            and r not in members_of_current_user
        )
        if grantable_roles:
            grant_lines = [f"GRANT {_q(r)} TO CURRENT_USER;" for r in grantable_roles]
            display_sql = "\n".join(grant_lines)
            stmts.insert(0, RoleStatement(
                sql=display_sql,
                kind="grant_self_membership",
                role="__self__",
                steps=grant_lines,
                warning="Grants all destination roles to current user so ALTER OWNER succeeds.",
            ))

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
                state.source_dsn, row["datname"], non_system_roles, dest_roles
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
                if item.kind == "grant_self_membership" and item.steps:
                    # Execute all GRANT ... TO CURRENT_USER then REVOKE ... FROM CURRENT_USER
                    # sequentially on the same connection — no new conn needed.
                    errors = []
                    for step in item.steps:
                        try:
                            await conn.execute(step)
                        except Exception as e:
                            errors.append(f"{step!r}: {e}")
                    if errors:
                        results.append(StatementResult(
                            sql=item.sql, ok=False, error="; ".join(errors),
                        ))
                        failed += 1
                    else:
                        results.append(StatementResult(sql=item.sql, ok=True))
                        applied += 1
                    continue

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
                    # Pattern: GRANT on conn1 → new conn2 (sees membership) → ALTER DEFAULT PRIVILEGES → REVOKE on conn1.
                    # No SET ROLE needed — ALTER DEFAULT PRIVILEGES FOR ROLE X only checks membership.
                    #
                    # On Cloud SQL ALTER DEFAULT PRIVILEGES FOR ROLE X also requires ADMIN OPTION on X.
                    # cloudsqlsuperuser members can grant any role with admin option, so skip the
                    # check for them — otherwise check pg_auth_members directly.
                    if owner_name:
                        is_cloudsql_super = await conn.fetchval(
                            """SELECT EXISTS(
                                SELECT 1 FROM pg_auth_members
                                WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'cloudsqlsuperuser')
                                  AND member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                            )"""
                        )
                        if not is_cloudsql_super:
                            has_admin = await conn.fetchval(
                                """SELECT admin_option FROM pg_auth_members
                                   WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
                                     AND member = (SELECT oid FROM pg_roles WHERE rolname = current_user)""",
                                owner_name,
                            )
                            if not has_admin:  # None (not a member) or False (member, no admin option)
                                results.append(StatementResult(
                                    sql=item.sql, ok=False,
                                    error=(
                                        f"Skipped: current user lacks ADMIN OPTION on \"{owner_name}\". "
                                        f"Run on destination as superuser: "
                                        f"GRANT \"{owner_name}\" TO CURRENT_USER WITH ADMIN OPTION; "
                                        f"then re-apply."
                                    ),
                                ))
                                failed += 1
                                if body.stop_on_error:
                                    break
                                continue

                    grant_step = item.steps[0]
                    revoke_step = item.steps[-1]
                    alter_steps = item.steps[1:-1]
                    await conn.execute(grant_step)
                    new_conn = await asyncpg.connect(dsn)
                    try:
                        for step in alter_steps:
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
                        await conn.execute(item.steps[-1])  # REVOKE cleanup
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
