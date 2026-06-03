from pydantic import BaseModel
from typing import Optional, List
from enum import Enum


class ConnectionConfig(BaseModel):
    source_dsn: str
    dest_dsn: str


class TableInfo(BaseModel):
    schema_name: str
    table_name: str
    size_bytes: int
    size_pretty: str
    row_estimate: int


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


class SubscriptionConfig(BaseModel):
    subscription_name: str = "pg_sync_sub"
    publication_name: str = "pg_sync_pub"
    source_dsn: str
    copy_data: bool = True


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
