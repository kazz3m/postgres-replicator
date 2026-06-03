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
}
export interface SchemaInfo {
  schema_name: string; tables: TableInfo[]
  total_size_bytes: number; total_size_pretty: string
}
export interface ReplicationTarget { schemas?: string[]; tables?: string[] }
export interface PublicationConfig { publication_name: string; target: ReplicationTarget }
export interface SubscriptionConfig {
  subscription_name: string; publication_name: string
  source_dsn: string; copy_data: boolean
}
export interface ReplicationSlotInfo {
  slot_name: string; plugin: string; slot_type: string
  active: boolean; restart_lsn?: string; confirmed_flush_lsn?: string; lag_bytes?: number
}
export interface TableReplicationProgress {
  schema_name: string; table_name: string; status: string
  copied_rows?: number; total_rows?: number; progress_pct?: number
}

export const connectionsApi = {
  test: (cfg: ConnectionConfig) => api.post<ConnectionStatus>('/connections/test', cfg),
  connect: (cfg: ConnectionConfig) => api.post('/connections/connect', cfg),
  status: () => api.get('/connections/status'),
}

export const analysisApi = {
  schemas: () => api.get<SchemaInfo[]>('/analysis/schemas'),
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
}
