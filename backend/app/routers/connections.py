from fastapi import APIRouter, HTTPException
from typing import Optional, List
import asyncpg
from ..models.schemas import ConnectionConfig, ConnectionStatus, PGVersion
from ..db import get_source_pool, get_dest_pool, reset_pools
from ..utils import mask_dsn
from .. import state

router = APIRouter(prefix="/api/connections", tags=["connections"])


async def _check_source_admin(conn: asyncpg.Connection, warnings: List[str]) -> None:
    """Checks performed on the source via the admin DSN."""
    current_user = await conn.fetchval("SELECT current_user")

    # wal_level must be logical
    wal_level = await conn.fetchval("SELECT current_setting('wal_level')")
    if wal_level != "logical":
        warnings.append(
            f"[source admin] wal_level is '{wal_level}', must be 'logical'. "
            f"Set wal_level = logical in postgresql.conf and restart PostgreSQL."
        )

    # Check #6: admin user needs SUPERUSER or at minimum CREATE PUBLICATION capability.
    # CREATE PUBLICATION requires superuser or table ownership; we flag non-superusers
    # so they know they may hit permission errors on individual tables.
    row = await conn.fetchrow(
        "SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1", current_user
    )
    is_superuser = row["rolsuper"] if row else False
    if not is_superuser:
        warnings.append(
            f"[source admin] User '{current_user}' is not a superuser. "
            f"CREATE PUBLICATION requires ownership of every published table, "
            f"or GRANT CREATE ON DATABASE and table ownership. "
            f"Consider: ALTER USER {current_user} SUPERUSER; (or grant per-table)."
        )

    # max_replication_slots headroom
    slots_used = await conn.fetchval("SELECT count(*) FROM pg_replication_slots")
    slots_max = await conn.fetchval("SELECT current_setting('max_replication_slots')::int")
    if slots_used >= slots_max:
        warnings.append(
            f"[source] max_replication_slots limit reached ({slots_used}/{slots_max}). "
            f"Increase max_replication_slots in postgresql.conf."
        )
    elif slots_max - slots_used < 2:
        warnings.append(
            f"[source] Only {slots_max - slots_used} replication slot(s) remaining "
            f"({slots_used}/{slots_max}). Consider increasing max_replication_slots."
        )

    # max_wal_senders headroom
    senders_used = await conn.fetchval("SELECT count(*) FROM pg_stat_replication")
    senders_max = await conn.fetchval("SELECT current_setting('max_wal_senders')::int")
    if senders_used >= senders_max:
        warnings.append(
            f"[source] max_wal_senders limit reached ({senders_used}/{senders_max}). "
            f"Increase max_wal_senders in postgresql.conf."
        )


async def _check_replication_user(repl_dsn: str, warnings: List[str]) -> None:
    """
    Checks performed on the replication DSN — the user that will be used
    in CREATE SUBSCRIPTION CONNECTION '...'.
    """
    try:
        conn = await asyncpg.connect(repl_dsn, timeout=5)
    except Exception as e:
        warnings.append(f"[replication user] Cannot connect: {e}")
        return

    try:
        current_user = await conn.fetchval("SELECT current_user")

        # Check #2: REPLICATION attribute
        row = await conn.fetchrow(
            "SELECT rolreplication, rolcanlogin, rolsuper "
            "FROM pg_roles WHERE rolname = $1", current_user
        )
        if not row:
            warnings.append(f"[replication user] Role '{current_user}' not found in pg_roles.")
            return

        # Check #2: REPLICATION attribute
        if not row["rolreplication"] and not row["rolsuper"]:
            warnings.append(
                f"[replication user] '{current_user}' lacks REPLICATION attribute. "
                f"Run: ALTER USER {current_user} REPLICATION;"
            )

        # Check #2: LOGIN capability
        if not row["rolcanlogin"]:
            warnings.append(
                f"[replication user] '{current_user}' cannot log in (rolcanlogin=false). "
                f"Run: ALTER USER {current_user} LOGIN;"
            )

        # Check #1: SELECT on all non-system tables
        # We check via has_table_privilege for each accessible table
        tables_missing_select = await conn.fetch(
            """
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_type = 'BASE TABLE'
              AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND NOT has_table_privilege($1, table_schema||'.'||table_name, 'SELECT')
            ORDER BY table_schema, table_name
            """,
            current_user,
        )
        if tables_missing_select:
            table_list = ", ".join(
                f"{r['table_schema']}.{r['table_name']}"
                for r in tables_missing_select[:10]
            )
            extra = f" (+{len(tables_missing_select) - 10} more)" if len(tables_missing_select) > 10 else ""
            warnings.append(
                f"[replication user] '{current_user}' lacks SELECT on {len(tables_missing_select)} table(s): "
                f"{table_list}{extra}. "
                f"Run: GRANT SELECT ON ALL TABLES IN SCHEMA public TO {current_user}; "
                f"(adjust schema as needed)"
            )

        # Check #3: replication channel (pg_hba.conf "host replication" entry)
        try:
            repl_conn = await asyncpg.connect(
                repl_dsn, timeout=5, server_settings={"replication": "database"}
            )
            await repl_conn.close()
        except Exception as e:
            warnings.append(
                f"[replication user] Replication protocol channel failed: {e}. "
                f"Ensure pg_hba.conf has: host replication {current_user} <subscriber_ip>/32 md5"
            )

    finally:
        await conn.close()


async def _check_dest_admin(conn: asyncpg.Connection, warnings: List[str]) -> None:
    """Checks performed on the destination via the admin DSN."""
    current_user = await conn.fetchval("SELECT current_user")

    row = await conn.fetchrow(
        "SELECT rolsuper FROM pg_roles WHERE rolname = $1", current_user
    )
    is_superuser = row["rolsuper"] if row else False

    # Check #4: CREATE privilege on the database (required for CREATE SUBSCRIPTION)
    has_create = await conn.fetchval(
        "SELECT has_database_privilege($1, current_database(), 'CREATE')",
        current_user,
    )
    if not has_create and not is_superuser:
        warnings.append(
            f"[dest admin] '{current_user}' lacks CREATE privilege on database. "
            f"Run: GRANT CREATE ON DATABASE <dbname> TO {current_user};"
        )

    # Check #5: pg_create_subscription role membership (PG16+)
    version_num = await conn.fetchval("SELECT current_setting('server_version_num')::int")
    if version_num // 10000 >= 16 and not is_superuser:
        has_sub_role = await conn.fetchval(
            "SELECT pg_has_role($1, 'pg_create_subscription', 'MEMBER')",
            current_user,
        )
        if not has_sub_role:
            warnings.append(
                f"[dest admin] '{current_user}' is not a superuser and lacks pg_create_subscription role (PG16+). "
                f"Run: GRANT pg_create_subscription TO {current_user};"
            )


async def _check_connection(
    dsn: str, is_source: bool = False, repl_dsn: str = ""
) -> tuple[bool, Optional[PGVersion], Optional[str], List[str]]:
    warnings: List[str] = []
    try:
        conn = await asyncpg.connect(dsn, timeout=5)
        try:
            row = await conn.fetchrow(
                "SELECT version(), current_setting('server_version_num')::int AS num"
            )
            if is_source:
                await _check_source_admin(conn, warnings)
            else:
                await _check_dest_admin(conn, warnings)
        finally:
            await conn.close()

        if is_source:
            # If no dedicated replication DSN, test replication channel on admin DSN
            # and warn about missing REPLICATION attribute on admin user
            if not repl_dsn:
                admin_user = await _get_user(dsn)
                has_repl = await _has_replication_attr(dsn)
                if not has_repl:
                    warnings.append(
                        f"[source admin] '{admin_user}' lacks REPLICATION attribute. "
                        f"Provide a Replication DSN, or run: ALTER USER {admin_user} REPLICATION;"
                    )
                # Test replication channel with admin DSN
                try:
                    rc = await asyncpg.connect(
                        dsn, timeout=5, server_settings={"replication": "database"}
                    )
                    await rc.close()
                except Exception as e:
                    warnings.append(
                        f"[source] Replication channel test failed: {e}. "
                        f"Ensure pg_hba.conf has: host replication <user> <subscriber_ip>/32 md5"
                    )
            else:
                await _check_replication_user(repl_dsn, warnings)

        major = row["num"] // 10000
        return True, PGVersion(version=row["version"], major=major), None, warnings
    except Exception as e:
        return False, None, str(e), warnings


async def _get_user(dsn: str) -> str:
    try:
        conn = await asyncpg.connect(dsn, timeout=5)
        try:
            return await conn.fetchval("SELECT current_user")
        finally:
            await conn.close()
    except Exception:
        return "<unknown>"


async def _has_replication_attr(dsn: str) -> bool:
    try:
        conn = await asyncpg.connect(dsn, timeout=5)
        try:
            user = await conn.fetchval("SELECT current_user")
            return bool(await conn.fetchval(
                "SELECT rolreplication OR rolsuper FROM pg_roles WHERE rolname = $1", user
            ))
        finally:
            await conn.close()
    except Exception:
        return False


@router.post("/test", response_model=ConnectionStatus)
async def test_connections(config: ConnectionConfig):
    src_ok, src_ver, src_err, src_warnings = await _check_connection(
        config.source_dsn, is_source=True, repl_dsn=config.source_repl_dsn
    )
    dst_ok, dst_ver, dst_err, dst_warnings = await _check_connection(config.dest_dsn)
    return ConnectionStatus(
        source_ok=src_ok,
        dest_ok=dst_ok,
        source_version=src_ver,
        dest_version=dst_ver,
        source_error=src_err,
        dest_error=dst_err,
        warnings=src_warnings + dst_warnings,
    )


@router.post("/connect")
async def connect(config: ConnectionConfig):
    src_ok, src_ver, src_err, src_warnings = await _check_connection(
        config.source_dsn, is_source=True, repl_dsn=config.source_repl_dsn
    )
    dst_ok, dst_ver, dst_err, dst_warnings = await _check_connection(config.dest_dsn)
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
        "warnings": src_warnings + dst_warnings,
    }


@router.get("/status")
async def connection_status():
    connected = bool(state.source_dsn and state.dest_dsn)
    pg_major: Optional[int] = None

    if connected:
        # Re-derive PG version from the stored DSN so the frontend can restore
        # pgMajor after a backend restart without requiring a full re-connect.
        try:
            conn = await asyncpg.connect(state.source_dsn, timeout=5)
            try:
                version_num = await conn.fetchval(
                    "SELECT current_setting('server_version_num')::int"
                )
                pg_major = version_num // 10000
            finally:
                await conn.close()
        except Exception:
            pass  # pg_major stays None; frontend will show 0 and let user reconnect

    return {
        "source_dsn": mask_dsn(state.source_dsn) if state.source_dsn else None,
        "source_repl_dsn": mask_dsn(state.source_repl_dsn) if state.source_repl_dsn else None,
        "dest_dsn": mask_dsn(state.dest_dsn) if state.dest_dsn else None,
        "connected": connected,
        "pg_major": pg_major,
    }
