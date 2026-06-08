import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

export interface ConnectionConfig { source_dsn: string; dest_dsn: string; source_repl_dsn?: string }
export interface PGVersion { version: string; major: number }
export interface ConnectionStatus {
  source_ok: boolean; dest_ok: boolean
  source_version?: PGVersion; dest_version?: PGVersion
  source_error?: string; dest_error?: string
  warnings?: string[]
}
export interface TableInfo {
  schema_name: string; table_name: string
  size_bytes: number; size_pretty: string; row_estimate: number
  replica_identity?: string
  is_partitioned?: boolean   // parent partitioned table (relkind='p')
  is_partition?: boolean     // child partition (relispartition=true)
}
export interface SchemaInfo {
  schema_name: string; tables: TableInfo[]
  total_size_bytes: number; total_size_pretty: string
}
export interface ReplicationTarget { schemas?: string[]; tables?: string[] }
export interface PublicationConfig { publication_name: string; target: ReplicationTarget; database?: string }

export interface PublicationServerConfig {
  pub_name: string
  database: string       // source database name
  puballtables: boolean
  tables: string[]       // "schema.table"
  schemas: string[]      // schema names (PG15+ only)
  subscriptions: Array<{ sub_name: string; enabled: boolean; slot_name: string | null }>
}
export interface SubscriptionConfig {
  subscription_name: string; publication_name: string
  source_dsn: string; copy_data: boolean
  database?: string
}
export interface ReplicationSlotInfo {
  slot_name: string; plugin: string; slot_type: string
  active: boolean; restart_lsn?: string; confirmed_flush_lsn?: string; lag_bytes?: number
}
export interface TableReplicationProgress {
  schema_name: string; table_name: string; status: string
  copied_rows?: number; total_rows?: number; progress_pct?: number
}

export interface SubscriptionInfo {
  subname: string
  subenabled: boolean
  subpublications: string[]
  subslotname: string | null
}

export interface WorkerStat {
  subname: string
  pid: number | null
  received_lsn: string | null
  last_msg_receive_time: string | null
  latest_end_lsn: string | null
  latest_end_time: string | null
}

export interface SequenceInfo {
  sequence_name: string
  table_name: string
  column_name: string
  source_value: number
  dest_value: number | null
  needs_sync: boolean
}

export interface ColumnDiff {
  column_name: string
  source_type: string
  dest_type: string | null
  match: boolean
}

export interface TableSchemaDiff {
  table: string
  exists_on_dest: boolean
  columns: ColumnDiff[]
  compatible: boolean
}

export interface SchemaSyncResult {
  table: string
  action: string   // created | already_exists | incompatible | error
  detail?: string
  indexes?: IndexInfo[]
}

export interface IndexInfo {
  table: string
  index_name: string
  index_def: string
}

export interface IndexCreateResult {
  index_name: string
  table: string
  action: string   // created | already_exists | error
  detail?: string
}

export interface ConnectionState {
  source_dsn: string | null
  source_repl_dsn: string | null
  dest_dsn: string | null
  connected: boolean
  pg_major: number | null
}

export const connectionsApi = {
  test: (cfg: ConnectionConfig) => api.post<ConnectionStatus>('/connections/test', cfg),
  connect: (cfg: ConnectionConfig) => api.post('/connections/connect', cfg),
  status: () => api.get<ConnectionState>('/connections/status'),
}

export interface DatabaseInfo {
  database: string
  size_pretty: string
  size_bytes: number
  exists_on_dest: boolean
}

export interface SchemaListItem {
  schema_name: string
  table_count: number
  total_size_bytes: number
  total_size_pretty: string
}

export const analysisApi = {
  schemas: () => api.get<SchemaInfo[]>('/analysis/schemas'),
  databases: () => api.get<DatabaseInfo[]>('/analysis/databases'),
  databaseSchemaList: (database: string) =>
    api.get<SchemaListItem[]>(`/analysis/database-schema-list?database=${encodeURIComponent(database)}`),
  schemaTables: (database: string, schema: string) =>
    api.get<TableInfo[]>(`/analysis/schema-tables?database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}`),
  ensureDatabase: (database: string) =>
    api.post<{ status: string; database: string }>('/analysis/ensure-database', { database }),
  publishedTables: (database: string) =>
    api.get<Record<string, string[]>>(`/analysis/published-tables?database=${encodeURIComponent(database)}`),
}

export interface TableCopyProgress {
  schema_name: string
  table_name: string
  sub_state: string       // i/d/f/s/r/e
  status: string          // initializing/copying/synced/ready/error
  tuples_done: number | null
  tuples_total: number | null
  bytes_processed: number | null
  table_size_bytes: number
  copy_pct: number | null
  last_analyze: string | null   // ISO timestamp or null if never analyzed
}

export interface CopyProgressResponse {
  tables: TableCopyProgress[]
  wal_slots: ReplicationSlotInfo[]
  copying_active: boolean
}

export interface RoleStatement {
  sql: string
  kind: 'create_role' | 'alter_role' | 'grant_membership' | 'grant_schema' | 'grant_table' | 'grant_default' | 'comment'
  role: string
  exists_on_dest: boolean
  warning?: string
}

export interface RolesDiffResponse {
  statements: RoleStatement[]
  skipped_system_roles: string[]
  password_available: boolean
  dest_is_cloudsql: boolean
}

export interface StatementResult {
  sql: string
  ok: boolean
  error?: string
}

export interface RolesApplyResponse {
  results: StatementResult[]
  applied: number
  failed: number
}

export const rolesApi = {
  diff: (includeDatabases = true) =>
    api.get<RolesDiffResponse>(`/roles/diff?include_databases=${includeDatabases}`),
  apply: (statements: string[], stopOnError = false) =>
    api.post<RolesApplyResponse>('/roles/apply', { statements, stop_on_error: stopOnError }),
}

export const replicationApi = {
  createPublication: (cfg: PublicationConfig) => api.post('/replication/publication', cfg),
  dropPublication: (name: string) => api.delete(`/replication/publication/${name}`),
  listPublications: () => api.get('/replication/publications'),
  createSubscription: (cfg: SubscriptionConfig) => api.post('/replication/subscription', cfg),
  dropSubscription: (name: string) => api.delete(`/replication/subscription/${name}`),
  listSubscriptions: () => api.get('/replication/subscriptions'),
  listSlots: () => api.get<ReplicationSlotInfo[]>('/replication/slots'),
  dropSlot: (name: string) => api.delete(`/replication/slot/${name}`),
  progress: () => api.get<TableReplicationProgress[]>('/replication/progress'),
  reset: (subscriptionName: string) => api.post(`/replication/reset/${subscriptionName}`),
  getInterval: () => api.get('/replication/stats/interval'),
  setInterval: (interval_seconds: number) => api.put('/replication/stats/interval', { interval_seconds }),
  workerStats: () => api.get<WorkerStat[]>('/replication/worker-stats'),
  listSubscriptionsTyped: () => api.get<SubscriptionInfo[]>('/replication/subscriptions'),
  stopSubscription: (name: string) => api.post(`/replication/subscription/${name}/stop`),
  addTableToPublication: (pubName: string, table: string) =>
    api.post(`/replication/publication/${pubName}/add-table`, { table }),
  listSequences: () => api.get<SequenceInfo[]>('/replication/sequences'),
  syncSequences: (sequences?: string[]) =>
    api.post('/replication/sequences/sync', { sequences: sequences ?? [] }),
  schemaDiff: (publication: string) =>
    api.get<TableSchemaDiff[]>(`/replication/schema-diff?publication=${encodeURIComponent(publication)}`),
  schemaCheck: (tables: string[], database?: string) =>
    api.post<TableSchemaDiff[]>('/replication/schema-check', { tables, database }),
  schemaSync: (publication: string, createIndexes: 'before' | 'after' = 'after') =>
    api.post<SchemaSyncResult[]>('/replication/schema-sync', { publication, create_indexes: createIndexes }),
  schemaSyncByTables: (tables: string[], createIndexes: 'before' | 'after' = 'after', database?: string) =>
    api.post<SchemaSyncResult[]>('/replication/schema-sync', { tables, create_indexes: createIndexes, database }),
  copyProgress: () =>
    api.get<CopyProgressResponse>('/replication/copy-progress'),
  analyzeTables: (tables: string[]) =>
    api.post<{ results: { table: string; ok: boolean; error?: string }[] }>('/replication/analyze', { tables }),
  publicationConfig: (name: string) =>
    api.get<PublicationServerConfig>(`/replication/publication-config?name=${encodeURIComponent(name)}`),
  listIndexes: (publication: string) =>
    api.get<IndexInfo[]>(`/replication/schema-indexes?publication=${encodeURIComponent(publication)}`),
  createIndexes: (publication?: string, tables?: string[]) =>
    api.post<IndexCreateResult[]>('/replication/schema/create-indexes', { publication, tables }),
}
