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
  slot_name?: string
  database?: string
  truncate_dest?: boolean
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
  last_msg_receipt_time: string | null
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
  source_not_null: boolean
  dest_not_null: boolean | null
  not_null_match: boolean
}

export interface IndexDiff {
  index_name: string
  columns: string[]
  is_unique: boolean
  exists_on_dest: boolean
  dest_columns: string[] | null
  columns_match: boolean
}

export interface SequenceDiff {
  sequence_name: string
  column_name: string
  exists_on_dest: boolean
}

export interface TriggerDiff {
  trigger_name: string
  event: string
  timing: string
  exists_on_dest: boolean
}

export interface ConstraintDiff {
  constraint_name: string
  constraint_type: string
  definition: string
  exists_on_dest: boolean
  dest_definition: string | null
  definition_match: boolean
}

export interface TableSchemaDiff {
  table: string
  exists_on_dest: boolean
  columns: ColumnDiff[]
  indexes: IndexDiff[]
  sequences: SequenceDiff[]
  triggers: TriggerDiff[]
  constraints: ConstraintDiff[]
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
  table_oid: number | null
  row_estimate: number | null   // pg_class.reltuples, null if never analyzed
  sub_state: string       // i/d/f/s/r/e
  status: string          // initializing/copying/synced/ready/error
  tuples_done: number | null
  tuples_total: number | null
  bytes_processed: number | null
  table_size_bytes: number
  source_size_bytes: number | null  // heap size on source (no indexes)
  copy_pct: number | null
  last_analyze: string | null   // ISO timestamp or null if never analyzed
}

export interface SubscriptionProgress {
  sub_name: string
  slot_name: string
  database: string | null
  lag_bytes: number
  slot_active: boolean       // pg_replication_slots.active
  enabled: boolean           // pg_subscription.subenabled
  sync_workers: number       // active pg_NNN_sync_NNN worker count
  repl_state: string | null  // pg_stat_replication.state (streaming/catchup/…)
  tables: TableCopyProgress[]
  copying_active: boolean
}

export interface CopyProgressResponse {
  subscriptions: SubscriptionProgress[]
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

export interface SchemaDumpConfig {
  pg_dump_path: string
  pg_dump_available: boolean
  strategy: 'pg_dump' | 'generator'
}

export interface SchemaDumpResponse {
  strategy: string
  database: string
  schemas: string[]
  statement_count: number
  statements: string[]
}

export interface SchemaApplyResponse {
  applied: number
  failed: number
  results: { sql: string; ok: boolean; error?: string }[]
}

export interface ReplicationSlotSnapshot {
  slot_name: string
  database: string
  active: boolean
  confirmed_flush_lsn: string
}

export const schemaDumpApi = {
  getConfig: () => api.get<SchemaDumpConfig>('/schema-dump/config'),
  setConfig: (pg_dump_path: string) =>
    api.post<{ pg_dump_path: string; strategy: string }>('/schema-dump/config', { pg_dump_path }),
  snapshots: () => api.get<ReplicationSlotSnapshot[]>('/schema-dump/snapshots'),
  dump: (database: string, schemas: string[], snapshot?: string, batch = false) =>
    api.post<SchemaDumpResponse>('/schema-dump/dump', { database, schemas, snapshot: snapshot || null, batch }),
  apply: (database: string, statements: string[], stopOnError = false, batch = false) =>
    api.post<SchemaApplyResponse>('/schema-dump/apply', { database, statements, stop_on_error: stopOnError, batch }),
}

export const rolesApi = {
  diff: (includeDatabases = true) =>
    api.get<RolesDiffResponse>(`/roles/diff?include_databases=${includeDatabases}`),
  apply: (statements: string[], stopOnError = false) =>
    api.post<RolesApplyResponse>('/roles/apply', { statements, stop_on_error: stopOnError }),
}

export interface ReplicationCapacity {
  wal_senders_max: number
  wal_senders_used: number
  slots_max: number
  slots_used: number
  slots_active: number
}

export interface UnusedPublication {
  pub_name: string
  database: string
  table_count: number
  tables: string[]
  schemas: string[]
}

export const replicationApi = {
  unusedPublications: () => api.get<UnusedPublication[]>('/replication/unused-publications'),
  capacity: () => api.get<ReplicationCapacity>('/replication/capacity'),
  createPublication: (cfg: PublicationConfig) => api.post('/replication/publication', cfg),
  dropPublication: (name: string, database?: string) =>
    api.delete(`/replication/publication/${name}${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  listPublications: () => api.get('/replication/publications'),
  createSubscription: (cfg: SubscriptionConfig) => api.post('/replication/subscription', cfg),
  dropSubscription: (name: string, database?: string, preserveSlot = false) => {
    const params = new URLSearchParams()
    if (database) params.set('database', database)
    if (preserveSlot) params.set('preserve_slot', 'true')
    const query = params.toString()
    return api.delete(`/replication/subscription/${name}${query ? `?${query}` : ''}`)
  },
  listSubscriptions: () => api.get('/replication/subscriptions'),
  listSlots: (database?: string) =>
    api.get<ReplicationSlotInfo[]>(`/replication/slots${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  dropSlot: (name: string) => api.delete(`/replication/slot/${name}`),
  deadSyncSlots: (name: string, database?: string) =>
    api.get<{ slots: { slot_name: string; lag_pretty: string; lag_bytes: number; restart_lsn: string; rel_oid: number | null }[]; sub_oid: number | null }>(
      `/replication/subscription/${name}/dead-sync-slots${database ? `?database=${encodeURIComponent(database)}` : ''}`
    ),
  dropDeadSyncSlots: (name: string, slotNames: string[], relOids: number[], truncateTables: boolean, database?: string) =>
    api.post<{ dropped: { slot: string; ok: boolean; error?: string }[]; truncated: { oid: number; table?: string; ok: boolean; error?: string }[] }>(
      `/replication/subscription/${name}/drop-dead-sync-slots`,
      { slot_names: slotNames, rel_oids: relOids, truncate_tables: truncateTables, database }
    ),
  progress: () => api.get<TableReplicationProgress[]>('/replication/progress'),
  reset: (subscriptionName: string) => api.post(`/replication/reset/${subscriptionName}`),
  getInterval: () => api.get('/replication/stats/interval'),
  setInterval: (interval_seconds: number) => api.put('/replication/stats/interval', { interval_seconds }),
  workerStats: () => api.get<WorkerStat[]>('/replication/worker-stats'),
  listSubscriptionsTyped: () => api.get<SubscriptionInfo[]>('/replication/subscriptions'),
  setSyncWorkers: (name: string, workers: number, database?: string) =>
    api.post<{ status: string; max_sync_workers_per_subscription: number }>(
      `/replication/subscription/${name}/set-workers${database ? `?database=${encodeURIComponent(database)}` : ''}`,
      { workers }
    ),
  stopSubscription: (name: string, database?: string) =>
    api.post(`/replication/subscription/${name}/stop${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  subscriptionTables: (name: string, database?: string) =>
    api.get<{ dest_host: string; tables: string[] }>(`/replication/subscription/${name}/tables${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  vacuumTruncate: (name: string, database?: string) =>
    api.post<{ dest_host: string; applied: number; failed: number; results: { table: string; ok: boolean; error?: string }[] }>(
      `/replication/subscription/${name}/vacuum-truncate${database ? `?database=${encodeURIComponent(database)}` : ''}`
    ),
  pauseSubscription: (name: string, database?: string) =>
    api.post(`/replication/subscription/${name}/pause${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  resumeSubscription: (name: string, database?: string) =>
    api.post(`/replication/subscription/${name}/resume${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  addTableToPublication: (pubName: string, table: string, database?: string) =>
    api.post(`/replication/publication/${pubName}/add-table`, { table, database }),
  dropTableFromPublication: (pubName: string, table: string, database?: string) =>
    api.delete(`/replication/publication/${pubName}/table?table=${encodeURIComponent(table)}${database ? `&database=${encodeURIComponent(database)}` : ''}`),
  refreshPublicationSubscriptions: (pubName: string, database?: string) =>
    api.post(`/replication/publication/${pubName}/refresh-subscriptions${database ? `?database=${encodeURIComponent(database)}` : ''}`),
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
  schemaDropRecreate: (tables: string[], database?: string) =>
    api.post<SchemaSyncResult[]>('/replication/schema-drop-recreate', { tables, database }),
  copyFunctions: (functionNames: string[], database?: string) =>
    api.post<{ name: string; ok: boolean; error?: string; ddl?: string }[]>(
      '/replication/schema-copy-functions', { function_names: functionNames, database }
    ),
  schemaFixNotNull: (tables: string[], database?: string, strategy: 'not_valid' | 'direct' = 'not_valid') =>
    api.post<{ table: string; ok: boolean; changes: { column: string; action: string; ok: boolean; error?: string }[]; error?: string }[]>(
      '/replication/schema-fix-not-null', { tables, database, strategy }
    ),
  copyProgress: () =>
    api.get<CopyProgressResponse>('/replication/copy-progress'),
  sourceTableSizes: (database: string) =>
    api.get<Record<string, { size_bytes: number; row_estimate: number | null; replica_identity: string; has_pk: boolean }>>(`/replication/source-table-sizes?database=${encodeURIComponent(database)}`),
  debugTable: (schema: string, table: string, database: string, subName: string) =>
    api.get<Record<string, unknown>>(`/replication/debug-table?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&database=${encodeURIComponent(database)}&sub_name=${encodeURIComponent(subName)}`),
  debugSubscription: (subName: string, database: string) =>
    api.get<Record<string, unknown>>(`/replication/debug-subscription?sub_name=${encodeURIComponent(subName)}&database=${encodeURIComponent(database)}`),
  publicationReaddTable: (pubName: string, subName: string, table: string, database: string) =>
    api.post<{ ok: boolean; steps: { step: string; ok: boolean; error?: string }[] }>(
      '/replication/publication-readd-table', { pub_name: pubName, sub_name: subName, table, database }
    ),
  skipLsn: (subName: string, lsn: string) =>
    api.post<{ status: string; subscription_name: string; lsn: string }>('/replication/skip-lsn', { subscription_name: subName, lsn }),
  setReplicaIdentityFull: (tables: string[], database: string) =>
    api.post<{ results: { table: string; ok: boolean; error?: string }[]; applied: number; failed: number }>(
      '/replication/set-replica-identity-full', { tables, database }
    ),
  setReplicaIdentityFullStream: (tables: string[], database: string,
    onProgress: (row: { table: string; ok: boolean; error?: string; index: number; total: number; applied: number; failed: number }) => void
  ): Promise<{ applied: number; failed: number }> => {
    return fetch('/api/replication/set-replica-identity-full-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tables, database }),
    }).then(async res => {
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let applied = 0, failed = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const row = JSON.parse(line)
          if (row.done) { applied = row.applied; failed = row.failed }
          else onProgress(row)
        }
      }
      return { applied, failed }
    })
  },
  analyzeTablesStream: async (
    tables: string[],
    database: string | undefined,
    statisticsTarget: number | undefined,
    onProgress: (ev: { table?: string; ok?: boolean; error?: string; done: number; total: number } | { done: true; total: number }) => void,
  ): Promise<void> => {
    const res = await fetch(`${api.defaults.baseURL}/replication/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tables, database, statistics_target: statisticsTarget }),
    })
    if (!res.ok || !res.body) throw new Error(await res.text())
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) onProgress(JSON.parse(line))
      }
    }
  },
  publicationConfig: (name: string, database?: string) =>
    api.get<PublicationServerConfig>(`/replication/publication-config?name=${encodeURIComponent(name)}${database ? `&database=${encodeURIComponent(database)}` : ''}`),
  listIndexes: (publication: string) =>
    api.get<IndexInfo[]>(`/replication/schema-indexes?publication=${encodeURIComponent(publication)}`),
  createIndexes: (publication?: string, tables?: string[]) =>
    api.post<IndexCreateResult[]>('/replication/schema/create-indexes', { publication, tables }),
}
