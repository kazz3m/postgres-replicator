from pydantic import BaseModel
from typing import Optional, List
from enum import Enum


class ConnectionConfig(BaseModel):
    source_dsn: str
    dest_dsn: str
    source_repl_dsn: str = ""  # dedicated replication user DSN for CREATE SUBSCRIPTION CONNECTION


class TableInfo(BaseModel):
    schema_name: str
    table_name: str
    size_bytes: int
    size_pretty: str
    row_estimate: int
    replica_identity: str = "default"


class SchemaInfo(BaseModel):
    schema_name: str
    tables: List[TableInfo]
    total_size_bytes: int
    total_size_pretty: str


class ReplicationTarget(BaseModel):
    schemas: Optional[List[str]] = None  # PG 15+ publication for schemas
    tables: Optional[List[str]] = None   # list of "schema.table"


class PublicationConfig(BaseModel):
    publication_name: str = "pg_sync_pub"
    target: ReplicationTarget
    database: Optional[str] = None  # source database name; None = use DSN default


class SubscriptionConfig(BaseModel):
    subscription_name: str = "pg_sync_sub"
    publication_name: str = "pg_sync_pub"
    source_dsn: str
    copy_data: bool = True
    slot_name: Optional[str] = None
    database: Optional[str] = None  # source database; if set, overrides DSN default in CONNECTION string
    dest_database: Optional[str] = None  # destination database; defaults to `database` if unset
    truncate_dest: bool = False      # TRUNCATE destination tables before creating subscription


class ReplicationSlotInfo(BaseModel):
    slot_name: str
    plugin: str
    slot_type: str
    active: bool
    restart_lsn: Optional[str]
    confirmed_flush_lsn: Optional[str]
    lag_bytes: Optional[int]


class SubscriptionStatus(BaseModel):
    subname: str
    subenabled: bool
    subpublications: List[str]
    subslotname: Optional[str]


class TableReplicationProgress(BaseModel):
    schema_name: str
    table_name: str
    status: str  # initializing, copying, synced, error
    copied_rows: Optional[int]
    total_rows: Optional[int]
    progress_pct: Optional[float]


class ReplicationStatus(BaseModel):
    slots: List[ReplicationSlotInfo]
    subscriptions: List[SubscriptionStatus]
    table_progress: List[TableReplicationProgress]
    lag_bytes: Optional[int]
    lag_seconds: Optional[float]


class StatsRefreshInterval(BaseModel):
    interval_seconds: int


class TableCopyProgress(BaseModel):
    schema_name: str
    table_name: str
    table_oid: Optional[int] = None   # pg_class.oid — useful for debugging
    sub_state: str          # i/d/f/s/r/e raw char
    status: str             # initializing/copying/synced/ready/error
    # row estimate from pg_class.reltuples (always present, may be 0 if never analyzed)
    row_estimate: Optional[int]
    # COPY phase (only populated while sub_state == 'd')
    tuples_done: Optional[int]
    tuples_total: Optional[int]
    bytes_processed: Optional[int]
    # size on destination (heap only, no indexes)
    table_size_bytes: int
    # size on source (heap only) — better progress estimate during initial copy
    source_size_bytes: Optional[int]
    # derived
    copy_pct: Optional[float]   # None if not in copy phase or tuples_total == 0
    # statistics freshness on destination
    last_analyze: Optional[str]  # ISO timestamp or None if never analyzed


class SubscriptionProgress(BaseModel):
    sub_name: str
    slot_name: str
    database: Optional[str]      # source/dest database name
    lag_bytes: int
    slot_active: bool            # pg_replication_slots.active
    enabled: bool                # pg_subscription.subenabled
    sync_workers: int            # active pg_NNN_sync_NNN worker count for this subscription
    repl_state: Optional[str]    # pg_stat_replication.state (streaming/catchup/backup/…)
    tables: List["TableCopyProgress"]
    copying_active: bool


class CopyProgressResponse(BaseModel):
    subscriptions: List["SubscriptionProgress"]
    # True when at least one table across all subs is still copying
    copying_active: bool


class SequenceInfo(BaseModel):
    sequence_name: str       # fully qualified: schema.seq
    table_name: str          # schema.table it belongs to
    column_name: str
    source_value: int
    dest_value: Optional[int]   # None if seq doesn't exist on dest yet
    needs_sync: bool


class ColumnDiff(BaseModel):
    column_name: str
    source_type: str
    dest_type: Optional[str]    # None if column missing on dest
    match: bool
    source_not_null: bool = False
    dest_not_null: Optional[bool] = None   # None if column missing on dest
    not_null_match: bool = True            # False when NOT NULL differs


class IndexDiff(BaseModel):
    index_name: str
    columns: List[str]          # column names in key order
    is_unique: bool
    exists_on_dest: bool
    dest_columns: Optional[List[str]] = None  # None if index missing on dest
    columns_match: bool = True


class SequenceDiff(BaseModel):
    sequence_name: str          # just the sequence name (without schema)
    column_name: str
    exists_on_dest: bool


class TriggerDiff(BaseModel):
    trigger_name: str
    event: str                  # INSERT/UPDATE/DELETE/TRUNCATE
    timing: str                 # BEFORE/AFTER/INSTEAD OF
    exists_on_dest: bool


class ConstraintDiff(BaseModel):
    constraint_name: str
    constraint_type: str        # CHECK / UNIQUE / FOREIGN KEY / PRIMARY KEY
    definition: str             # pg_get_constraintdef()
    exists_on_dest: bool
    dest_definition: Optional[str] = None
    definition_match: bool = True


class TableSchemaDiff(BaseModel):
    table: str                  # schema.table
    exists_on_dest: bool
    columns: List[ColumnDiff]
    indexes: List[IndexDiff] = []
    sequences: List[SequenceDiff] = []
    triggers: List[TriggerDiff] = []
    constraints: List[ConstraintDiff] = []
    compatible: bool            # True only when all columns match


class IndexInfo(BaseModel):
    table: str                  # schema.table
    index_name: str
    index_def: str              # full CREATE INDEX statement


class IndexCreateResult(BaseModel):
    index_name: str
    table: str
    action: str                 # created | already_exists | error
    detail: str = ""


class SchemaSyncResult(BaseModel):
    table: str
    action: str                 # created | already_exists | error
    detail: str = ""
    indexes: List[IndexInfo] = []   # available indexes (populated when create_indexes=before)


class PGVersion(BaseModel):
    version: str
    major: int


class ConnectionStatus(BaseModel):
    source_ok: bool
    dest_ok: bool
    source_version: Optional[PGVersion]
    dest_version: Optional[PGVersion]
    source_error: Optional[str]
    dest_error: Optional[str]
    warnings: List[str] = []
