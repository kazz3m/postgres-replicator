import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { replicationApi, ReplicationSlotInfo, SubscriptionInfo, TableCopyProgress, CopyProgressResponse } from '../api/client'
import { Badge } from '../components/Badge'
import { DebugTableModal } from '../components/DebugTableModal'
import { DebugSubscriptionModal } from '../components/DebugSubscriptionModal'
import { PublicationManagerPanel } from '../components/PublicationManagerPanel'
import { ConfirmModal } from '../components/ConfirmModal'
import { Spinner } from '../components/Spinner'
import { SequenceSyncPanel } from '../components/SequenceSyncPanel'
import { SchemaSyncPanel } from '../components/SchemaSyncPanel'
import { AddTableModal } from '../components/AddTableModal'
import { IndexSyncPanel } from '../components/IndexSyncPanel'
import { RolesSyncPanel } from '../components/RolesSyncPanel'
import { RefreshCw, AlertTriangle, Square, PlusCircle, Layers, Database, ChevronDown, ChevronRight, FlaskConical, Bug } from 'lucide-react'
import clsx from 'clsx'
import type { WorkspaceSnapshot } from './WorkspacePicker'

function ProgressBar({ pct, color = 'blue' }: { pct: number | null | undefined; color?: string }) {
  const v = pct ?? 0
  const colorClass = color === 'green' ? 'bg-green-500' : color === 'yellow' ? 'bg-yellow-500' : 'bg-blue-500'
  return (
    <div className="w-full bg-gray-800 rounded-full h-2">
      <div
        className={`h-2 rounded-full transition-all ${colorClass}`}
        style={{ width: `${Math.min(100, v)}%` }}
      />
    </div>
  )
}

function fmtBytes(b: number): string {
  if (b <= 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`
  return `${(b / 1024 ** 4).toFixed(2)} TB`
}

function lagColor(bytes: number): string {
  if (bytes > 1024 ** 3) return 'text-red-400'       // > 1 GB
  if (bytes > 100 * 1024 * 1024) return 'text-yellow-400'  // > 100 MB
  return 'text-green-400'
}

function statusVariant(s: string): 'green' | 'yellow' | 'blue' | 'red' | 'gray' {
  if (s === 'synced' || s === 'ready') return 'green'
  if (s === 'copying') return 'blue'
  if (s === 'initializing' || s === 'catching up') return 'yellow'
  if (s === 'error') return 'red'
  return 'gray'
}

interface Props {
  initialSnapshot?: WorkspaceSnapshot
}

export function StatusPage({ initialSnapshot }: Props) {
  const qc = useQueryClient()
  const [interval, setIntervalSecs] = useState(10)
  const [editInterval, setEditInterval] = useState(false)
  const [intervalInput, setIntervalInput] = useState('10')
  const [confirmReset, setConfirmReset] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState<string | null>(null)
  const [confirmDropSlot, setConfirmDropSlot] = useState<string | null>(null)
  const [vacuumTarget, setVacuumTarget] = useState<{ subName: string; destHost: string; tables: string[] } | null>(null)
  const [vacuumLoading, setVacuumLoading] = useState(false)
  const [vacuumResult, setVacuumResult] = useState<{ applied: number; failed: number; results: { table: string; ok: boolean; error?: string }[] } | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState('')
  // Add table to publication — modal
  const [addTablePub, setAddTablePub] = useState<string | null>(null)
  const [addTableResult, setAddTableResult] = useState('')
  // Schema sync — track active publication for schema panel
  const [schemaPub, setSchemaPub] = useState<string | null>(null)
  // Index panel after stop
  const [indexPub, setIndexPub] = useState<string | null>(null)
  // Progress table expanded per subscription
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set())
  function toggleSubExpanded(subName: string) {
    setExpandedSubs(prev => {
      const next = new Set(prev)
      next.has(subName) ? next.delete(subName) : next.add(subName)
      return next
    })
  }
  // ANALYZE state
  const [analyzingTables, setAnalyzingTables] = useState(false)
  // Table sort — shared across all subscriptions (same column/dir preference)
  type SortCol = 'table' | 'status'
  const [sortCol, setSortCol] = useState<SortCol>('table')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  function handleSort(col: SortCol) {
    if (col === sortCol) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const STATE_ORDER: Record<string, number> = {
    copying: 0, initializing: 1, 'catching up': 2, synced: 3, ready: 4, error: 5, unknown: 6,
  }
  function sortTables(tables: TableCopyProgress[]) {
    return [...tables].sort((a, b) => {
      let cmp = 0
      if (sortCol === 'table') {
        cmp = `${a.schema_name}.${a.table_name}`.localeCompare(`${b.schema_name}.${b.table_name}`)
      } else {
        cmp = (STATE_ORDER[a.status] ?? 9) - (STATE_ORDER[b.status] ?? 9)
        if (cmp === 0) cmp = `${a.schema_name}.${a.table_name}`.localeCompare(`${b.schema_name}.${b.table_name}`)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }
  // Debug modal (table)
  const [debugTarget, setDebugTarget] = useState<{ schema: string; table: string; database: string; subName: string } | null>(null)
  // Publication manager
  const [managePub, setManagePub] = useState<{ pubName: string; database: string; subName: string } | null>(null)
  // Debug modal (subscription)
  const [debugSub, setDebugSub] = useState<{ subName: string; database: string } | null>(null)

  const { data: progress, refetch: refetchProgress, isLoading: progressLoading } = useQuery({
    queryKey: ['progress'],
    queryFn: () => replicationApi.progress().then(r => r.data),
    refetchInterval: interval * 1000,
    initialData: initialSnapshot?.progress,
  })

  const { data: copyData, refetch: refetchCopy, isLoading: copyLoading, isError: copyError } = useQuery<CopyProgressResponse>({
    queryKey: ['copy-progress'],
    queryFn: () => replicationApi.copyProgress().then(r => r.data),
    refetchInterval: (query) =>
      (query.state.data as CopyProgressResponse | undefined)?.copying_active
        ? 3000
        : interval * 1000,
    retry: 1,
  })

  // Source table sizes — fetched once per database, never re-polled.
  // Key: "database/schema.table" → bytes
  // v2 = added replica_identity + has_pk; bump version to force refetch on format change
  const SOURCE_SIZES_CACHE_VERSION = 'v2'
  const sourceSizesRef = useRef<Record<string, { size_bytes: number; row_estimate: number | null; replica_identity: string; has_pk: boolean }>>({})
  const fetchedDatabasesRef = useRef<Set<string>>(new Set())
  const [sourceSizesVersion, setSourceSizesVersion] = useState(0)

  useEffect(() => {
    const databases = new Set(
      (copyData?.subscriptions ?? []).map(s => s.database).filter(Boolean) as string[]
    )
    databases.forEach(db => {
      if (fetchedDatabasesRef.current.has(db)) {
        // Check if cached data has the current format (replica_identity present)
        const sample = Object.entries(sourceSizesRef.current).find(([k]) => k.startsWith(`${db}/`))
        if (sample && (sample[1] as Record<string, unknown>).replica_identity === undefined) {
          // Stale format — clear and refetch
          for (const k of Object.keys(sourceSizesRef.current)) {
            if (k.startsWith(`${db}/`)) delete sourceSizesRef.current[k]
          }
          fetchedDatabasesRef.current.delete(db)
        } else {
          return
        }
      }
      fetchedDatabasesRef.current.add(db)
      replicationApi.sourceTableSizes(db).then(res => {
        Object.entries(res.data).forEach(([qualified, info]) => {
          sourceSizesRef.current[`${db}/${qualified}`] = info
        })
        setSourceSizesVersion(v => v + 1)
      }).catch((e) => {
        console.warn('source-table-sizes failed for', db, e)
        fetchedDatabasesRef.current.delete(db)  // allow retry on next poll
      })
    })
  }, [copyData?.subscriptions?.map(s => s.database).join(',')])

  function getSourceInfo(database: string | null, schema: string, table: string) {
    if (!database) return null
    return sourceSizesRef.current[`${database}/${schema}.${table}`] ?? null
  }
  function getSourceSize(database: string | null, schema: string, table: string): number | null {
    return getSourceInfo(database, schema, table)?.size_bytes ?? null
  }
  function getSourceRowEstimate(database: string | null, schema: string, table: string): number | null {
    return getSourceInfo(database, schema, table)?.row_estimate ?? null
  }
  function getSourceReplicaInfo(database: string | null, schema: string, table: string) {
    const info = getSourceInfo(database, schema, table)
    if (!info || info.replica_identity === undefined) return null
    return { replica_identity: info.replica_identity, has_pk: info.has_pk }
  }

  const { data: slots, refetch: refetchSlots } = useQuery({
    queryKey: ['slots'],
    queryFn: () => replicationApi.listSlots().then(r => r.data),
    refetchInterval: interval * 1000,
  })

  const { data: subs, refetch: refetchSubs } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => replicationApi.listSubscriptions().then(r => r.data),
    refetchInterval: interval * 1000,
    initialData: initialSnapshot?.subscriptions,
  })

  useEffect(() => {
    replicationApi.getInterval().then(r => {
      setIntervalSecs(r.data.interval_seconds)
      setIntervalInput(String(r.data.interval_seconds))
    })
  }, [])

  async function saveInterval() {
    const v = parseInt(intervalInput)
    if (isNaN(v) || v < 1) return
    await replicationApi.setInterval(v)
    setIntervalSecs(v)
    setEditInterval(false)
  }

  async function handleReset(subName: string) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.reset(subName)
      refetchProgress(); refetchSlots(); refetchSubs()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false); setConfirmReset(null)
    }
  }

  async function handleStop(subName: string) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.stopSubscription(subName, getSubDatabase(subName))
      refetchProgress(); refetchSlots(); refetchSubs()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false); setConfirmStop(null)
    }
  }

  function getSubDatabase(subName: string): string | undefined {
    return copyData?.subscriptions?.find(s => s.sub_name === subName)?.database ?? undefined
  }

  function isSlotDropped(sub: any): boolean {
    // Slot is gone if subslotname is null/empty OR the slot doesn't appear in the slots list
    if (!sub.subslotname) return true
    return !(slots ?? []).some((s: ReplicationSlotInfo) => s.slot_name === sub.subslotname)
  }

  async function handlePause(subName: string) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.pauseSubscription(subName, getSubDatabase(subName))
      refetchProgress(); refetchSubs()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleResume(subName: string) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.resumeSubscription(subName, getSubDatabase(subName))
      refetchProgress(); refetchSubs()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false)
    }
  }

  function handleAddTableDone(tables: string[], refreshed: string[]) {
    setAddTableResult(
      `Added ${tables.length} table${tables.length !== 1 ? 's' : ''}, refreshed: ${refreshed.join(', ') || 'none'}`
    )
    setAddTablePub(null)
    qc.invalidateQueries({ queryKey: ['subscriptions'] })
  }

  async function handleDropSlot(slotName: string) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.dropSlot(slotName)
      refetchSlots()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false); setConfirmDropSlot(null)
    }
  }

  async function handleVacuumOpen(subName: string) {
    const db = getSubDatabase(subName)
    try {
      const res = await replicationApi.subscriptionTables(subName, db)
      setVacuumTarget({ subName, destHost: res.data.dest_host, tables: res.data.tables })
      setVacuumResult(null)
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    }
  }

  async function handleVacuumRun() {
    if (!vacuumTarget) return
    setVacuumLoading(true)
    try {
      const db = getSubDatabase(vacuumTarget.subName)
      const res = await replicationApi.vacuumTruncate(vacuumTarget.subName, db)
      setVacuumResult(res.data)
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
      setVacuumTarget(null)
    } finally {
      setVacuumLoading(false)
    }
  }

  function refetchAll() { refetchProgress(); refetchCopy(); refetchSlots(); refetchSubs() }

  async function handleAnalyze(tables: string[]) {
    setAnalyzingTables(true)
    try {
      await replicationApi.analyzeTables(tables)
      refetchCopy()
    } finally {
      setAnalyzingTables(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Replication Status</h2>
        <div className="flex items-center gap-3">
          {editInterval ? (
            <div className="flex items-center gap-2">
              <input
                className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs"
                value={intervalInput}
                onChange={e => setIntervalInput(e.target.value)}
              />
              <span className="text-gray-500 text-xs">s</span>
              <button onClick={saveInterval} className="text-xs bg-blue-700 hover:bg-blue-600 px-2 py-1 rounded">Save</button>
              <button onClick={() => setEditInterval(false)} className="text-xs text-gray-400 hover:text-gray-200">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setEditInterval(true)}
              className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 px-2 py-1 rounded"
            >
              Refresh: {interval}s
            </button>
          )}
          <button
            onClick={refetchAll}
            className="p-1.5 rounded hover:bg-gray-700"
            title="Refresh now"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {actionError && (
        <div className="text-red-400 text-sm bg-red-950 border border-red-800 rounded p-3 flex items-center gap-2">
          <AlertTriangle size={14} /> {actionError}
        </div>
      )}

      {/* Copy + WAL progress — per subscription */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-2">
          <span className="font-semibold text-gray-300 flex-1">Replication Progress</span>
          {copyData?.copying_active && (
            <span className="flex items-center gap-1.5 text-xs text-blue-400 animate-pulse">
              <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
              Initial copy in progress
            </span>
          )}
        </div>

        {copyLoading && (
          <div className="p-4 flex items-center gap-2 text-gray-500 text-sm"><Spinner size={3} /> Loading...</div>
        )}
        {copyError && (
          <div className="p-4 text-red-400 text-sm">Failed to load progress. Check backend logs.</div>
        )}
        {!copyLoading && !copyError && !copyData?.subscriptions?.length && (
          <div className="p-4 text-gray-500 text-sm">No subscriptions tracked yet. Set up replication first.</div>
        )}

        {/* Per-subscription rows */}
        {copyData?.subscriptions?.map(sub => {
          const total = sub.tables.length
          const synced = sub.tables.filter(t => ['s','r'].includes(t.sub_state)).length
          const unanalyzed = sub.tables.filter(t => !t.last_analyze).map(t => `${t.schema_name}.${t.table_name}`)
          const lag = sub.lag_bytes ?? 0
          const subExpanded = expandedSubs.has(sub.sub_name)

          // Aggregate copy progress across all tables in this subscription.
          // Source sizes come from sourceSizesRef (fetched once, not polled).
          // sourceSizesVersion dependency ensures re-render when ref is populated.
          void sourceSizesVersion
          const tablesWithSource = sub.tables.filter(t => getSourceSize(sub.database, t.schema_name, t.table_name) != null)
          const totalSourceBytes = tablesWithSource.reduce((s, t) => s + (getSourceSize(sub.database, t.schema_name, t.table_name) ?? 0), 0)
          const totalCopiedBytes = tablesWithSource.reduce((s, t) => {
            const srcSize = getSourceSize(sub.database, t.schema_name, t.table_name) ?? 0
            if (['f','s','r'].includes(t.sub_state)) return s + srcSize
            // For copying tables use dest heap size (same metric as per-table progress bar)
            if (t.sub_state === 'd') return s + Math.min(t.table_size_bytes, srcSize)
            return s
          }, 0)
          const copyPct = totalSourceBytes > 0 ? Math.min(100, totalCopiedBytes / totalSourceBytes * 100) : null
          const showCopyProgress = tablesWithSource.length > 0

          return (
            <div key={sub.sub_name} className="border-b border-gray-800 last:border-0">
              {/* Subscription summary row */}
              <div className="px-4 py-2.5 flex flex-wrap items-center gap-3 text-xs">
                <Database size={12} className="text-gray-500 shrink-0" />
                <span className="font-mono text-gray-300 font-medium">{sub.sub_name}</span>
                {/* Slot active + sync workers + replication state */}
                {sub.slot_active
                  ? <Badge label="active" variant="green" />
                  : sub.sync_workers > 0
                    ? <Badge label={`syncing (${sub.sync_workers})`} variant="yellow" />
                    : <Badge label="inactive" variant="gray" />
                }
                {sub.repl_state && (
                  <span className={clsx(
                    'text-xs border rounded px-1.5 py-0.5 font-mono',
                    sub.repl_state === 'streaming' ? 'bg-green-950 border-green-800 text-green-300' :
                    sub.repl_state === 'catchup'   ? 'bg-yellow-950 border-yellow-800 text-yellow-300' :
                    'bg-gray-800 border-gray-700 text-gray-300'
                  )}>
                    {sub.repl_state}
                  </span>
                )}

                {/* Database badge */}
                {sub.database && (
                  <span className="text-xs bg-blue-950 border border-blue-800 text-blue-300 rounded px-1.5 py-0.5 font-mono">
                    {sub.database}
                  </span>
                )}

                {/* Table sync counter */}
                {total > 0 && (
                  <span className={clsx('font-mono', synced === total ? 'text-green-400' : 'text-blue-400')}>
                    {synced}/{total} tables synced
                  </span>
                )}

                {/* Aggregate copy progress */}
                {showCopyProgress && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-500">copied:</span>
                    <span className="font-mono text-blue-300">{fmtBytes(totalCopiedBytes)}</span>
                    <span className="text-gray-600">/</span>
                    <span className="font-mono text-gray-400">{fmtBytes(totalSourceBytes)}</span>
                    {copyPct != null && (
                      <>
                        <span className="text-gray-500">({copyPct.toFixed(1)}%)</span>
                        <div className="w-24">
                          <ProgressBar pct={copyPct} color="blue" />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* WAL lag */}
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-500">WAL lag:</span>
                  <span className={clsx('font-mono font-semibold', lagColor(lag))}>{fmtBytes(lag)}</span>
                  {lag > 0 && (
                    <div className="w-20">
                      <ProgressBar pct={Math.min(100, (lag / (1024 ** 3)) * 100)}
                        color={lag > 1024 ** 3 ? 'yellow' : lag > 100 * 1024 * 1024 ? 'yellow' : 'green'} />
                    </div>
                  )}
                </div>

                {/* Analyze unanalyzed */}
                {unanalyzed.length > 0 && (
                  <button
                    onClick={() => handleAnalyze(unanalyzed)}
                    disabled={analyzingTables}
                    className="flex items-center gap-1 text-xs bg-amber-900/40 hover:bg-amber-800/60 border border-amber-700/60 text-amber-300 px-2 py-0.5 rounded disabled:opacity-50 transition-colors"
                  >
                    {analyzingTables ? <Spinner size={2} /> : <FlaskConical size={10} />}
                    Analyze {unanalyzed.length} unanalyzed
                  </button>
                )}

                {/* Debug subscription */}
                <button
                  onClick={() => setDebugSub({ subName: sub.sub_name, database: sub.database ?? '' })}
                  className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-300 border border-gray-700 hover:border-gray-500 px-1.5 py-0.5 rounded transition-colors"
                  title="Debug subscription — apply worker, WAL lag, conflicts"
                >
                  <Bug size={10} /> debug sub
                </button>

                {/* Show/hide tables */}
                <button
                  onClick={() => toggleSubExpanded(sub.sub_name)}
                  className="flex items-center gap-1 text-gray-400 hover:text-gray-200 ml-auto"
                >
                  {subExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {subExpanded ? 'Hide tables' : 'Show tables'}
                </button>

              </div>

              {/* Table list — lazy */}
              {subExpanded && sub.tables.length > 0 && (
                <table className="w-full text-xs border-t border-gray-800">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700 bg-gray-950/40">
                      {(['table', 'status'] as const).map(col => (
                        <th key={col}
                          className={clsx('px-4 py-1.5 text-left cursor-pointer select-none hover:text-gray-300 whitespace-nowrap', col === 'status' && 'w-32')}
                          onClick={() => handleSort(col)}
                        >
                          {col === 'table' ? 'Schema.Table' : 'Status'}
                          {sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : <span className="text-gray-700"> ↕</span>}
                        </th>
                      ))}
                      <th className="px-4 py-1.5 text-right">Dest size</th>
                      <th className="px-4 py-1.5 text-right">Source size</th>
                      <th className="px-4 py-1.5 text-right">Row est.</th>
                      <th className="px-4 py-1.5 text-right">Rows copied</th>
                      <th className="px-4 py-1.5 text-left w-40">Progress</th>
                      <th className="px-4 py-1.5 text-left">Analyzed</th>
                      <th className="px-4 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortTables(sub.tables).map((row: TableCopyProgress) => {
                      const isCopying = row.sub_state === 'd'
                      const isDone = ['f','s','r'].includes(row.sub_state)
                      const srcSize = getSourceSize(sub.database, row.schema_name, row.table_name)
                      const srcRowEst = getSourceRowEstimate(sub.database, row.schema_name, row.table_name)
                      const replicaInfo = getSourceReplicaInfo(sub.database, row.schema_name, row.table_name)
                      const riProblem = replicaInfo && (!replicaInfo.has_pk || replicaInfo.replica_identity === 'nothing')
                      return (
                        <tr key={`${row.schema_name}.${row.table_name}`}
                          className={clsx('border-b border-gray-800', {
                            'bg-blue-950/20': isCopying, 'hover:bg-gray-800': !isCopying,
                          })}>
                          <td className="px-4 py-1.5 font-mono">
                            <span className="text-gray-500">{row.schema_name}.</span>{row.table_name}
                            {row.table_oid != null && (
                              <span className="ml-2 text-gray-600 text-[10px]" title="pg_class.oid">
                                oid:{row.table_oid}
                              </span>
                            )}
                            {replicaInfo && (
                              <span
                                className={clsx('ml-2 text-[10px] px-1 py-0.5 rounded border font-sans',
                                  riProblem
                                    ? 'bg-red-950/60 border-red-800 text-red-400'
                                    : 'bg-gray-800 border-gray-700 text-gray-500'
                                )}
                                title={`Replica identity: ${replicaInfo.replica_identity} | PK: ${replicaInfo.has_pk}`}
                              >
                                {replicaInfo.has_pk ? 'PK' : 'no PK'}
                                {' · '}
                                {replicaInfo.replica_identity === 'default' ? 'RI:default'
                                  : replicaInfo.replica_identity === 'full' ? 'RI:full'
                                  : replicaInfo.replica_identity === 'nothing' ? 'RI:nothing ⚠'
                                  : replicaInfo.replica_identity === 'index' ? 'RI:index'
                                  : `RI:${replicaInfo.replica_identity}`}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-1.5">
                            <Badge label={row.status} variant={statusVariant(row.status)} />
                          </td>
                          <td className="px-4 py-1.5 text-right text-gray-400">{fmtBytes(row.table_size_bytes)}</td>
                          <td className="px-4 py-1.5 text-right text-gray-400">
                            {srcSize != null
                              ? <span className={clsx({ 'text-blue-300': isCopying })}>{fmtBytes(srcSize)}</span>
                              : <span className="text-gray-600 animate-pulse">…</span>}
                          </td>
                          <td className="px-4 py-1.5 text-right text-gray-500 font-mono">
                            {srcRowEst != null ? srcRowEst.toLocaleString() : <span className="text-gray-700">…</span>}
                          </td>
                          <td className="px-4 py-1.5 text-right text-gray-400">
                            {isCopying
                              ? (() => {
                                  const done = row.tuples_done ?? 0
                                  const est = srcRowEst ?? 0
                                  const pct = est > 0 ? Math.min(100, done / est * 100) : null
                                  return <>
                                    <span className="text-blue-300">{done.toLocaleString()}</span>
                                    {pct != null && <span className="text-gray-500"> ({pct.toFixed(1)}%)</span>}
                                  </>
                                })()
                              : isDone ? <span className="text-green-500">done</span> : '–'}
                          </td>
                          <td className="px-4 py-1.5">
                            {(() => {
                              // Progress = dest heap size / source heap size.
                              // pg_relation_size on dest grows as COPY writes pages —
                              // this is the most reliable indicator regardless of whether
                              // a COPY worker is currently active for this table.
                              // bytes_processed only covers the active worker window.
                              const destPct = (isCopying && srcSize && srcSize > 0 && row.table_size_bytes > 0)
                                ? Math.min(100, row.table_size_bytes / srcSize * 100)
                                : null
                              const pct = destPct
                              return isCopying ? (
                              <div className="space-y-0.5">
                                <ProgressBar pct={pct} color="blue" />
                                <span className="text-gray-500">{pct != null ? `${pct.toFixed(1)}%` : 'estimating...'}</span>
                              </div>
                            ) : isDone ? (
                              <div className="space-y-0.5">
                                <ProgressBar pct={100} color="green" />
                                <span className="text-green-600 text-xs">100%</span>
                              </div>
                            ) : <span className="text-gray-600">–</span>
                            })()}
                          </td>
                          <td className="px-4 py-1.5">
                            {row.last_analyze ? (
                              <span className="text-green-400" title={row.last_analyze}>✓ {new Date(row.last_analyze).toLocaleString()}</span>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="text-yellow-500">⚠ never</span>
                                <button
                                  onClick={() => handleAnalyze([`${row.schema_name}.${row.table_name}`])}
                                  disabled={analyzingTables}
                                  className="bg-amber-900/40 hover:bg-amber-800/60 border border-amber-700/60 text-amber-300 px-1.5 py-0.5 rounded disabled:opacity-50"
                                >Analyze</button>
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <button
                              onClick={() => setDebugTarget({ schema: row.schema_name, table: row.table_name, database: sub.database ?? '', subName: sub.sub_name })}
                              className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-300 border border-gray-700 hover:border-gray-500 px-1.5 py-0.5 rounded transition-colors"
                              title="Debug this table"
                            >
                              <Bug size={10} /> debug
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              {subExpanded && sub.tables.length === 0 && (
                <div className="px-4 py-2 text-xs text-gray-500">No tables tracked for this subscription.</div>
              )}
            </div>
          )
        })}
      </div>

      {/* Subscriptions */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 font-semibold text-gray-300">Subscriptions</div>
        {!subs?.length ? (
          <div className="p-4 text-gray-500 text-sm">No subscriptions found.</div>
        ) : (
          <>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Enabled</th>
                  <th className="px-4 py-2 text-left">Publications</th>
                  <th className="px-4 py-2 text-left">Slot</th>
                  <th className="px-4 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((sub: any) => (
                  <tr key={sub.subname} className="border-b border-gray-800 hover:bg-gray-800">
                    <td className="px-4 py-2 font-semibold">{sub.subname}</td>
                    <td className="px-4 py-2">
                      <Badge label={sub.subenabled ? 'enabled' : 'disabled'} variant={sub.subenabled ? 'green' : 'red'} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1 items-center">
                        {sub.subpublications?.map((p: string) => {
                          const db = getSubDatabase(sub.subname) ?? ''
                          const isManaging = managePub?.pubName === p && managePub?.database === db
                          return (
                            <div key={p} className="flex items-center gap-1">
                              <button
                                onClick={() => setSchemaPub(schemaPub === p ? null : p)}
                                className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                                  schemaPub === p
                                    ? 'border-blue-500 text-blue-300 bg-blue-900/30'
                                    : 'border-gray-700 text-gray-400 hover:border-gray-500'
                                }`}
                                title="Show schema / sequence panel for this publication"
                              >
                                {p}
                              </button>
                              <button
                                onClick={() => setManagePub(isManaging ? null : { pubName: p, database: db, subName: sub.subname })}
                                className={clsx('text-xs px-1.5 py-0.5 rounded border transition-colors',
                                  isManaging
                                    ? 'border-purple-500 text-purple-300 bg-purple-900/30'
                                    : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'
                                )}
                                title="Manage publication tables"
                              >
                                Manage
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-gray-400">{sub.subslotname || '–'}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {sub.subenabled
                          ? <button
                              onClick={() => handlePause(sub.subname)}
                              disabled={actionLoading}
                              className="text-xs text-yellow-500/80 hover:text-yellow-400 border border-yellow-900/60 hover:border-yellow-700 px-2 py-1 rounded disabled:opacity-40 flex items-center gap-1"
                              title="Pause — ALTER SUBSCRIPTION DISABLE. Slot preserved, resume at any time."
                            >⏸ Pause</button>
                          : <button
                              onClick={() => handleResume(sub.subname)}
                              disabled={actionLoading}
                              className="text-xs text-green-500/80 hover:text-green-400 border border-green-900/60 hover:border-green-700 px-2 py-1 rounded disabled:opacity-40 flex items-center gap-1"
                              title="Resume — ALTER SUBSCRIPTION ENABLE. Continues from last confirmed LSN."
                            >▶ Resume</button>
                        }
                        <button
                          onClick={() => setConfirmStop(sub.subname)}
                          disabled={actionLoading || !sub.subenabled}
                          className="text-xs text-orange-400 hover:text-orange-300 border border-orange-800 px-2 py-1 rounded disabled:opacity-40 flex items-center gap-1"
                          title="Stop replication gracefully (disable + drop slot)"
                        >
                          <Square size={10} /> Stop
                        </button>
                        <button
                          onClick={() => setConfirmReset(sub.subname)}
                          disabled={actionLoading}
                          className="text-xs text-red-400 hover:text-red-300 border border-red-800 px-2 py-1 rounded"
                        >
                          Reset
                        </button>
                        <button
                          onClick={() => handleVacuumOpen(sub.subname)}
                          disabled={actionLoading || !isSlotDropped(sub)}
                          title={isSlotDropped(sub) ? 'VACUUM (TRUNCATE ONLY) all destination tables — reclaims dead tuple storage' : 'Available only after slot is dropped (replication stopped)'}
                          className="text-xs text-teal-400/70 hover:text-teal-300 border border-teal-900/50 hover:border-teal-700 px-2 py-1 rounded disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          <Database size={10} /> Vacuum
                        </button>
                        <button
                          onClick={() => setConfirmDropSlot(sub.subslotname || sub.subname)}
                          disabled={actionLoading}
                          className="text-xs text-red-500/60 hover:text-red-400 border border-red-900/50 hover:border-red-800 px-2 py-1 rounded disabled:opacity-30"
                          title="Drop replication slot on source only. Use when slot is orphaned after Stop."
                        >
                          Drop slot
                        </button>
                        {/* Create indexes — useful after replication completes */}
                        {sub.subpublications?.length > 0 && (
                          <button
                            onClick={() => {
                              const pub = sub.subpublications[0]
                              setIndexPub(indexPub === pub ? null : pub)
                            }}
                            className={`text-xs px-2 py-1 rounded border flex items-center gap-1 transition-colors ${
                              indexPub === sub.subpublications[0]
                                ? 'border-purple-500 text-purple-300 bg-purple-900/20'
                                : 'border-gray-700 text-gray-400 hover:border-gray-500'
                            }`}
                            title="Create indexes on destination for this publication"
                          >
                            <Layers size={10} /> Indexes
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Add table to publication — opens modal tree picker */}
            <div className="px-4 py-3 border-t border-gray-700 flex items-center gap-3">
              <button
                onClick={() => {
                  const pubs = (subs as any[]).flatMap((s: any) => s.subpublications ?? [])
                  const uniquePubs = [...new Set<string>(pubs)]
                  setAddTablePub(uniquePubs[0] ?? null)
                  setAddTableResult('')
                }}
                className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5"
              >
                <PlusCircle size={12} /> Add table to publication...
              </button>
              {addTableResult && (
                <span className={`text-xs ${addTableResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {addTableResult}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Publication manager — shown when Manage clicked */}
      {managePub && (
        <PublicationManagerPanel
          pubName={managePub.pubName}
          database={managePub.database}
          subName={managePub.subName}
        />
      )}

      {/* Roles & Grants migration — always available */}
      <RolesSyncPanel />

      {/* Schema + Sequence panels — shown when a publication is selected */}
      {schemaPub && (
        <>
          <SchemaSyncPanel publication={schemaPub} />
          <SequenceSyncPanel />
        </>
      )}

      {/* Index panel — shown when "Indexes" button clicked on a subscription */}
      {indexPub && (
        <IndexSyncPanel publication={indexPub} />
      )}


      {/* Add table modal */}
      {addTablePub && (
        <AddTableModal
          pubName={addTablePub}
          onClose={() => setAddTablePub(null)}
          onAdded={handleAddTableDone}
        />
      )}

      {confirmStop && (
        <ConfirmModal
          title="Stop Replication"
          message={`Disable subscription "${confirmStop}" and drop its replication slot on source. Existing data on destination is preserved. You can restart replication later via Reset.`}
          confirmLabel="Stop"
          onConfirm={() => handleStop(confirmStop)}
          onCancel={() => setConfirmStop(null)}
        />
      )}
      {confirmReset && (
        <ConfirmModal
          title="Reset Replication"
          message={`This will drop subscription "${confirmReset}" and its slot, then recreate it from scratch. All data will be re-synced. This is destructive and may take a long time on large databases.`}
          confirmLabel="Reset"
          onConfirm={() => handleReset(confirmReset)}
          onCancel={() => setConfirmReset(null)}
        />
      )}
      {confirmDropSlot && (
        <ConfirmModal
          title="Drop Replication Slot"
          message={`Drop slot "${confirmDropSlot}"? This will prevent the subscriber from catching up and may require a full resync.`}
          confirmLabel="Drop Slot"
          onConfirm={() => handleDropSlot(confirmDropSlot)}
          onCancel={() => setConfirmDropSlot(null)}
        />
      )}

      {vacuumTarget && !vacuumResult && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
            <h3 className="text-lg font-bold text-teal-400 mb-1">Vacuum Destination Tables</h3>
            <p className="text-gray-400 text-xs mb-3">
              Runs <code className="bg-gray-800 px-1 rounded">VACUUM (TRUNCATE ONLY)</code> on all replicated tables.<br />
              This reclaims dead tuple storage without a full table scan.
            </p>
            <div className="bg-gray-800 rounded px-3 py-2 mb-4 text-xs">
              <span className="text-gray-500">Destination: </span>
              <span className="text-teal-300 font-mono">{vacuumTarget.destHost}</span>
            </div>
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-1">{vacuumTarget.tables.length} tables:</div>
              <div className="max-h-48 overflow-y-auto bg-gray-950 rounded border border-gray-800 px-3 py-2 space-y-0.5">
                {vacuumTarget.tables.map(t => (
                  <div key={t} className="font-mono text-xs text-gray-300">{t}</div>
                ))}
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setVacuumTarget(null)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
              >Cancel</button>
              <button
                onClick={handleVacuumRun}
                disabled={vacuumLoading}
                className="px-4 py-2 bg-teal-700 hover:bg-teal-600 rounded text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
              >
                {vacuumLoading ? <Spinner size={3} /> : <Database size={13} />}
                Run Vacuum
              </button>
            </div>
          </div>
        </div>
      )}

      {vacuumResult && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
            <h3 className="text-lg font-bold text-teal-400 mb-3">Vacuum Complete</h3>
            <div className="flex gap-4 mb-4 text-sm">
              <span className="text-green-400">✓ {vacuumResult.applied} succeeded</span>
              {vacuumResult.failed > 0 && <span className="text-red-400">✗ {vacuumResult.failed} failed</span>}
            </div>
            <div className="max-h-64 overflow-y-auto bg-gray-950 rounded border border-gray-800 px-3 py-2 space-y-1">
              {vacuumResult.results.map(r => (
                <div key={r.table} className="flex items-start gap-2 text-xs font-mono">
                  <span className={r.ok ? 'text-green-500' : 'text-red-400'}>{r.ok ? '✓' : '✗'}</span>
                  <span className={r.ok ? 'text-gray-300' : 'text-red-300'}>{r.table}</span>
                  {r.error && <span className="text-red-500 text-[10px] ml-1">{r.error}</span>}
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <button
                onClick={() => { setVacuumTarget(null); setVacuumResult(null) }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
              >Close</button>
            </div>
          </div>
        </div>
      )}

      {debugSub && (
        <DebugSubscriptionModal
          subName={debugSub.subName}
          database={debugSub.database}
          onClose={() => setDebugSub(null)}
        />
      )}

      {debugTarget && (
        <DebugTableModal
          schema={debugTarget.schema}
          table={debugTarget.table}
          database={debugTarget.database}
          subName={debugTarget.subName}
          onClose={() => setDebugTarget(null)}
        />
      )}
    </div>
  )
}
