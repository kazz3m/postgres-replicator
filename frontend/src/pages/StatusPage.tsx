import React, { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { replicationApi, connectionsApi, ReplicationSlotInfo, SubscriptionInfo, TableCopyProgress, CopyProgressResponse, ReplicationCapacity, UnusedPublication } from '../api/client'
import { Badge } from '../components/Badge'
import { DebugTableModal } from '../components/DebugTableModal'
import { DebugSubscriptionModal } from '../components/DebugSubscriptionModal'
import { PublicationManagerPanel } from '../components/PublicationManagerPanel'
import { ConfirmModal } from '../components/ConfirmModal'
import { Spinner } from '../components/Spinner'
import { SequenceSyncPanel } from '../components/SequenceSyncPanel'
import { SchemaSyncPanel } from '../components/SchemaSyncPanel'
import { IndexSyncPanel } from '../components/IndexSyncPanel'
import { RolesSyncPanel } from '../components/RolesSyncPanel'
import { RefreshCw, AlertTriangle, Square, Layers, Database, ChevronDown, ChevronRight, FlaskConical, Bug, CheckCircle, XCircle, Circle, Loader, Trash2, Link, ChevronUp } from 'lucide-react'
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

function fmtEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function lagColor(bytes: number): string {
  if (bytes > 1024 ** 3) return 'text-red-400'       // > 1 GB
  if (bytes > 100 * 1024 * 1024) return 'text-yellow-400'  // > 100 MB
  return 'text-green-400'
}

function statusVariant(s: string): 'green' | 'yellow' | 'blue' | 'red' | 'gray' | 'orange' {
  if (s === 'synced' || s === 'ready') return 'green'
  if (s === 'copying') return 'blue'
  if (s === 'initializing' || s === 'catching up' || s === 'waiting') return 'yellow'
  if (s === 'slot pending') return 'orange'
  if (s === 'error' || s === 'locked') return 'red'
  return 'gray'
}

function CapacityPill({ label, used, max, active }: { label: string; used: number; max: number; active?: number }) {
  const pct = max > 0 ? used / max : 0
  const color = pct >= 0.9 ? 'text-red-400 border-red-800 bg-red-950/30'
    : pct >= 0.7 ? 'text-yellow-400 border-yellow-800 bg-yellow-950/30'
    : 'text-gray-400 border-gray-700 bg-gray-800/50'
  const barColor = pct >= 0.9 ? 'bg-red-500' : pct >= 0.7 ? 'bg-yellow-500' : 'bg-blue-500'
  return (
    <div className={`flex items-center gap-2 border rounded px-2.5 py-1 ${color}`} title={`${label}: ${used} used of ${max} max${active !== undefined ? `, ${active} active` : ''}`}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-baseline gap-1 whitespace-nowrap">
          <span className="font-semibold tabular-nums">{used}/{max}</span>
          <span className="text-[10px] opacity-70">{label}</span>
          {active !== undefined && active !== used && (
            <span className="text-[10px] opacity-60">({active} active)</span>
          )}
        </div>
        <div className="w-full bg-gray-700/50 rounded-full h-0.5">
          <div className={`h-0.5 rounded-full ${barColor}`} style={{ width: `${Math.min(100, pct * 100)}%` }} />
        </div>
      </div>
    </div>
  )
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
  const [confirmDropSub, setConfirmDropSub] = useState<{ subName: string; database?: string } | null>(null)
  const [confirmDropPub, setConfirmDropPub] = useState<{ subName: string; pubName: string; database?: string } | null>(null)
  const [editWorkers, setEditWorkers] = useState<{ subName: string; value: string } | null>(null)
  const [workersLoading, setWorkersLoading] = useState(false)
  const [vacuumTarget, setVacuumTarget] = useState<{ subName: string; destHost: string; tables: string[] } | null>(null)
  const [vacuumLoading, setVacuumLoading] = useState(false)
  const [vacuumResult, setVacuumResult] = useState<{ applied: number; failed: number; results: { table: string; ok: boolean; error?: string }[] } | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState('')
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
  // ANALYZE modal state
  const [analyzeModal, setAnalyzeModal] = useState<{
    tables: string[]; database?: string; allTables?: string[]
  } | null>(null)
  const [analyzeSteps, setAnalyzeSteps] = useState<{ table: string; status: 'pending' | 'running' | 'ok' | 'error'; error?: string }[]>([])
  const [analyzeRunning, setAnalyzeRunning] = useState(false)
  const [analyzeDone, setAnalyzeDone] = useState(false)
  const [statisticsTarget, setStatisticsTarget] = useState<number | ''>('')
  const analyzeSubRef = useRef<string | undefined>(undefined)
  // Table sort — shared across all subscriptions (same column/dir preference)
  type SortCol = 'table' | 'status'
  const [sortCol, setSortCol] = useState<SortCol>('table')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  function handleSort(col: SortCol) {
    if (col === sortCol) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const STATE_ORDER: Record<string, number> = {
    locked: 0, error: 1, 'catching up': 2, copying: 3, 'slot pending': 4, waiting: 5, initializing: 6, synced: 7, ready: 8, unknown: 9,
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
  // Unused publications
  const [unusedPubsExpanded, setUnusedPubsExpanded] = useState(true)
  const [confirmDropUnusedPub, setConfirmDropUnusedPub] = useState<UnusedPublication | null>(null)
  const [connectPubModal, setConnectPubModal] = useState<UnusedPublication | null>(null)
  const [connectForm, setConnectForm] = useState({ subName: '', slotName: '', copyData: true, truncateDest: false })
  const [connectLoading, setConnectLoading] = useState(false)
  const [connectError, setConnectError] = useState('')

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

  // Replication speed — rolling 10-sample average per subscription
  const SPEED_SAMPLES = 10
  const speedRef = useRef<Record<string, { bytes: number; ts: number; samples: number[]; avgMbps: number }>>({})
  const [speedVersion, setSpeedVersion] = useState(0)

  useEffect(() => {
    if (!copyData?.subscriptions) return
    const now = Date.now()
    let changed = false
    for (const sub of copyData.subscriptions) {
      const destCopied = sub.tables.reduce((s, t) => {
        if (['f','s','r','d'].includes(t.sub_state)) return s + t.table_size_bytes
        return s
      }, 0)
      const prev = speedRef.current[sub.sub_name]
      if (prev) {
        const dt = (now - prev.ts) / 1000
        if (dt >= 1) {
          const delta = destCopied - prev.bytes
          const mbps = delta > 0 ? delta / dt / (1024 * 1024) : 0
          const samples = [...prev.samples, mbps].slice(-SPEED_SAMPLES)
          const avgMbps = samples.reduce((a, b) => a + b, 0) / samples.length
          speedRef.current[sub.sub_name] = { bytes: destCopied, ts: now, samples, avgMbps }
          changed = true
        }
      } else {
        speedRef.current[sub.sub_name] = { bytes: destCopied, ts: now, samples: [], avgMbps: 0 }
      }
    }
    if (changed) setSpeedVersion(v => v + 1)
  }, [copyData])

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

  const { data: connState } = useQuery({
    queryKey: ['conn-status'],
    queryFn: () => connectionsApi.status().then(r => r.data),
    staleTime: 60_000,
  })

  const { data: unusedPubs, refetch: refetchUnusedPubs } = useQuery<UnusedPublication[]>({
    queryKey: ['unused-publications'],
    queryFn: () => replicationApi.unusedPublications().then(r => r.data),
    refetchInterval: interval * 1000,
  })

  const { data: capacity } = useQuery<ReplicationCapacity>({
    queryKey: ['capacity'],
    queryFn: () => replicationApi.capacity().then(r => r.data),
    refetchInterval: interval * 1000,
    retry: false,
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

  async function handleDropSubscription(subName: string, database?: string) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.dropSubscription(subName, database)
      refetchProgress(); refetchSlots(); refetchSubs(); refetchCopy()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false); setConfirmDropSub(null)
    }
  }

  async function handleDropPublication(pubName: string, database?: string) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.dropPublication(pubName, database)
      refetchProgress(); refetchSlots(); refetchSubs(); refetchCopy()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false); setConfirmDropPub(null)
    }
  }

  async function handleSetWorkers(_subName: string, workers: number) {
    setWorkersLoading(true)
    try {
      await replicationApi.setSyncWorkers('_global', workers)
      setEditWorkers(null)
      refetchSubs()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setWorkersLoading(false)
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

  function refetchAll() { refetchProgress(); refetchCopy(); refetchSlots(); refetchSubs(); refetchUnusedPubs() }

  async function handleDropUnusedPub(pub: UnusedPublication) {
    setActionLoading(true); setActionError('')
    try {
      await replicationApi.dropPublication(pub.pub_name, pub.database)
      refetchUnusedPubs()
    } catch (e: any) {
      setActionError(e.response?.data?.detail || e.message)
    } finally {
      setActionLoading(false); setConfirmDropUnusedPub(null)
    }
  }

  async function handleConnectSubscription() {
    if (!connectPubModal) return
    const subName = connectForm.subName.trim()
    if (!subName) { setConnectError('Subscription name is required'); return }
    setConnectLoading(true); setConnectError('')
    try {
      const sourceDsn = connState?.source_repl_dsn || connState?.source_dsn || ''
      await replicationApi.createSubscription({
        subscription_name: subName,
        publication_name: connectPubModal.pub_name,
        source_dsn: sourceDsn,
        copy_data: connectForm.copyData,
        slot_name: connectForm.slotName.trim() || undefined,
        database: connectPubModal.database,
        truncate_dest: connectForm.truncateDest,
      })
      setConnectPubModal(null)
      refetchAll()
    } catch (e: any) {
      setConnectError(e.response?.data?.detail || e.message)
    } finally {
      setConnectLoading(false)
    }
  }

  function openAnalyzeModal(tables: string[], database?: string, allTables?: string[]) {
    setAnalyzeModal({ tables, database, allTables })
    setAnalyzeSteps(tables.map(t => ({ table: t, status: 'pending' })))
    setAnalyzeRunning(false)
    setAnalyzeDone(false)
  }

  async function runAnalyze(tables: string[], database?: string) {
    setAnalyzeRunning(true)
    setAnalyzeDone(false)
    setAnalyzeSteps(tables.map(t => ({ table: t, status: 'pending' })))
    let currentTable = ''
    try {
      await replicationApi.analyzeTablesStream(
        tables, database,
        statisticsTarget !== '' ? statisticsTarget : undefined,
        (ev) => {
          if ('done' in ev && ev.done === true) {
            setAnalyzeDone(true)
            return
          }
          const e = ev as { table: string; ok: boolean; error?: string; done: number; total: number }
          currentTable = e.table
          setAnalyzeSteps(prev => prev.map(s =>
            s.table === e.table
              ? { ...s, status: e.ok ? 'ok' : 'error', error: e.error }
              : s.table === currentTable && s.status === 'pending'
                ? { ...s, status: 'running' }
                : s
          ))
          // mark next pending as running
          setAnalyzeSteps(prev => {
            const idx = prev.findIndex(s => s.table === e.table)
            if (idx + 1 < prev.length && prev[idx + 1].status === 'pending') {
              return prev.map((s, i) => i === idx + 1 ? { ...s, status: 'running' } : s)
            }
            return prev
          })
        }
      )
    } catch (e: any) {
      // mark remaining as error
      setAnalyzeSteps(prev => prev.map(s => s.status === 'pending' || s.status === 'running'
        ? { ...s, status: 'error', error: e?.message ?? 'Failed' } : s))
    } finally {
      setAnalyzeRunning(false)
      setAnalyzeDone(true)
      refetchCopy()
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Replication Status</h2>
        <div className="flex items-center gap-3 text-xs">
          {capacity && (
            <>
              <CapacityPill label="WAL senders" used={capacity.wal_senders_used} max={capacity.wal_senders_max} />
              <CapacityPill label="slots" used={capacity.slots_used} max={capacity.slots_max} active={capacity.slots_active} />
            </>
          )}
          {subs?.length > 0 && (subs[0] as any).max_sync_workers != null && (
            editWorkers?.subName === '__global__' ? (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500">sync workers:</span>
                <input
                  type="number" min={1} max={32}
                  value={editWorkers!.value}
                  onChange={e => setEditWorkers(prev => prev ? { ...prev, value: e.target.value } : null)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && editWorkers) handleSetWorkers('__global__', parseInt(editWorkers.value))
                    if (e.key === 'Escape') setEditWorkers(null)
                  }}
                  className="w-10 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-center outline-none focus:border-blue-500"
                  autoFocus
                />
                <button onClick={() => editWorkers && handleSetWorkers('__global__', parseInt(editWorkers.value))} disabled={workersLoading}
                  className="text-blue-400 hover:text-blue-300 border border-blue-800 px-1.5 py-0.5 rounded disabled:opacity-40">
                  {workersLoading ? '…' : 'Set'}
                </button>
                <button onClick={() => setEditWorkers(null)} className="text-gray-500 hover:text-gray-300">✕</button>
              </div>
            ) : (
              <button
                onClick={() => setEditWorkers({ subName: '__global__', value: String((subs[0] as any).max_sync_workers) })}
                className="flex flex-col gap-0.5 border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-gray-300 rounded px-2.5 py-1 bg-gray-800/50"
                title="Cluster-wide max_sync_workers_per_subscription — limits parallel sync slots during initial copy. Uses ALTER SYSTEM SET + pg_reload_conf. On Cloud SQL: GCP Console → Instance flags, or: gcloud sql instances patch INSTANCE --database-flags max_sync_workers_per_subscription=N"
              >
                <span className="font-semibold tabular-nums">{(subs[0] as any).max_sync_workers} <span className="font-normal opacity-70">sync workers</span></span>
                <div className="w-full bg-gray-700/50 rounded-full h-0.5" />
              </button>
            )
          )}
        </div>
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
          {(() => {
            void speedVersion
            const totalMbps = Object.values(speedRef.current).reduce((s, v) => s + v.avgMbps, 0)
            const anyActive = copyData?.subscriptions?.some(s => s.tables.some(t => t.status === 'copying'))
            if (!anyActive || totalMbps < 0.01) return null
            const label = totalMbps >= 1000
              ? `${(totalMbps / 1024).toFixed(1)} GB/s`
              : totalMbps >= 1
              ? `${totalMbps.toFixed(1)} MB/s`
              : `${(totalMbps * 1024).toFixed(0)} KB/s`
            // Total remaining across all active subscriptions
            const totalRemaining = (copyData?.subscriptions ?? []).reduce((sum, sub) => {
              const withSrc = sub.tables.filter(t => getSourceSize(sub.database, t.schema_name, t.table_name) != null)
              const srcTotal = withSrc.reduce((s, t) => s + (getSourceSize(sub.database, t.schema_name, t.table_name) ?? 0), 0)
              const copied = withSrc.reduce((s, t) => {
                const src = getSourceSize(sub.database, t.schema_name, t.table_name) ?? 0
                if (['f','s','r'].includes(t.sub_state)) return s + src
                if (t.sub_state === 'd' && t.status === 'copying') return s + Math.min(t.table_size_bytes, src)
                return s
              }, 0)
              return sum + Math.max(0, srcTotal - copied)
            }, 0)
            const etaSecs = totalRemaining > 0 ? totalRemaining / (totalMbps * 1024 * 1024) : null
            return (
              <span className="text-xs font-mono text-cyan-400 border border-cyan-800 bg-cyan-950/30 rounded px-2 py-0.5 flex items-center gap-1.5" title="Total copy speed (10-sample avg) across all active subscriptions">
                ⚡ {label} total
                {etaSecs != null && (
                  <span className="text-cyan-300/70">· ETA {fmtEta(etaSecs)}</span>
                )}
              </span>
            )
          })()}
          {(() => {
            void sourceSizesVersion
            const subs = copyData?.subscriptions ?? []
            let totalCopied = 0, totalSrc = 0
            for (const sub of subs) {
              for (const t of sub.tables) {
                const src = getSourceSize(sub.database, t.schema_name, t.table_name)
                if (src == null) continue
                totalSrc += src
                if (['f','s','r'].includes(t.sub_state)) totalCopied += src
                else if (t.sub_state === 'd' && t.status === 'copying') totalCopied += Math.min(t.table_size_bytes, src)
              }
            }
            if (totalSrc === 0) return null
            const pct = Math.min(100, totalCopied / totalSrc * 100)
            return (
              <div className="flex items-center gap-1.5 text-xs text-gray-400" title="Aggregate copy progress across all subscriptions">
                <span className="font-mono text-blue-300">{fmtBytes(totalCopied)}</span>
                <span className="text-gray-600">/</span>
                <span className="font-mono">{fmtBytes(totalSrc)}</span>
                <span className="text-gray-500">({pct.toFixed(1)}%)</span>
                <div className="w-20 bg-gray-700 rounded-full h-1">
                  <div className="bg-blue-500 h-1 rounded-full" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })()}
          {(() => {
            const activeCopying = (copyData?.subscriptions ?? []).flatMap(s => s.tables).filter(t => t.status === 'copying').length
            if (activeCopying === 0) return null
            return (
              <span className="flex items-center gap-1.5 text-xs text-blue-400 animate-pulse">
                <span className="w-2 h-2 rounded-full bg-blue-400 inline-block shrink-0" />
                {activeCopying} table{activeCopying !== 1 ? 's' : ''} copying
              </span>
            )
          })()}
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
        <table className="w-full text-xs table-fixed" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 24 }} /><col style={{ width: '16%' }} /><col style={{ width: '20%' }} /><col style={{ width: '26%' }} /><col style={{ width: '18%' }} /><col style={{ width: 96 }} /><col style={{ width: 70 }} /><col style={{ width: 88 }} />
          </colgroup>
          <tbody>
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
            // Only count actively copying tables (not 'waiting')
            if (t.sub_state === 'd' && t.status === 'copying') return s + Math.min(t.table_size_bytes, srcSize)
            return s
          }, 0)
          const copyPct = totalSourceBytes > 0 ? Math.min(100, totalCopiedBytes / totalSourceBytes * 100) : null
          const showCopyProgress = tablesWithSource.length > 0
          void speedVersion
          const mbps = speedRef.current[sub.sub_name]?.avgMbps ?? 0
          const hasActiveCopy = sub.tables.some(t => t.status === 'copying')
          const showSpeed = mbps > 0.01 && hasActiveCopy
          const remainingBytes = totalSourceBytes - totalCopiedBytes
          const etaSecs = showSpeed && remainingBytes > 0 ? remainingBytes / (mbps * 1024 * 1024) : null

          return (
            <React.Fragment key={sub.sub_name}>
              <tr className="border-b border-gray-800 hover:bg-gray-800/20">

                {/* col 1: icon */}
                <td className="pl-3 py-2 w-6"><Database size={11} className="text-gray-500" /></td>

                {/* col 2: name */}
                <td className="px-1.5 py-2"><span className="font-mono text-gray-300 font-medium truncate block">{sub.sub_name}</span></td>

                {/* col 3: badges */}
                <td className="px-1.5 py-2">
                  <div className="flex items-center gap-1 flex-wrap">
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
                      )}>{sub.repl_state}</span>
                    )}
                    {sub.database && (
                      <span className="text-xs bg-blue-950 border border-blue-800 text-blue-300 rounded px-1.5 py-0.5 font-mono">{sub.database}</span>
                    )}
                  </div>
                </td>

                {/* col 4: copy progress */}
                <td className="px-1.5 py-2">
                  <div className="flex items-center gap-1 text-xs flex-wrap">
                    {total > 0 && (
                      <span className={clsx('font-mono whitespace-nowrap', synced === total ? 'text-green-400' : 'text-blue-400')}>
                        {synced}/{total} synced
                      </span>
                    )}
                    {showCopyProgress && (
                      <>
                        <span className="text-gray-600">·</span>
                        <span className="font-mono text-blue-300 whitespace-nowrap">{fmtBytes(totalCopiedBytes)}</span>
                        <span className="text-gray-600">/</span>
                        <span className="font-mono text-gray-400 whitespace-nowrap">{fmtBytes(totalSourceBytes)}</span>
                        {copyPct != null && (
                          <>
                            <span className="text-gray-500 whitespace-nowrap">({copyPct.toFixed(1)}%)</span>
                            <div className="w-20"><ProgressBar pct={copyPct} color="blue" /></div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </td>

                {/* col 5: WAL lag + speed */}
                <td className="px-1.5 py-2">
                  <div className="flex items-center gap-1 text-xs flex-wrap">
                    <span className="text-gray-500 whitespace-nowrap">WAL lag:</span>
                    <span className={clsx('font-mono font-semibold whitespace-nowrap', lagColor(lag))}>{fmtBytes(lag)}</span>
                    {lag > 0 && (
                      <div className="w-14"><ProgressBar pct={Math.min(100, (lag / (1024 ** 3)) * 100)}
                        color={lag > 1024 ** 3 ? 'yellow' : lag > 100 * 1024 * 1024 ? 'yellow' : 'green'} /></div>
                    )}
                    {showSpeed && (
                      <>
                        <span className="font-mono text-cyan-400 whitespace-nowrap" title={`Avg of last ${speedRef.current[sub.sub_name]?.samples.length ?? 0} samples`}>
                          {mbps >= 1000 ? `${(mbps/1024).toFixed(1)} GB/s` : mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${(mbps*1024).toFixed(0)} KB/s`}
                        </span>
                        {etaSecs != null && (
                          <span className="text-gray-400 whitespace-nowrap" title="Estimated time remaining based on average speed">
                            ETA {fmtEta(etaSecs)}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </td>

                {/* col 6: analyze */}
                <td className="px-1.5 py-2 text-xs">
                  <div className="flex items-center gap-1">
                    {unanalyzed.length > 0 && (
                      <button
                        onClick={() => openAnalyzeModal(unanalyzed, sub.database ?? undefined, sub.tables.map(t => `${t.schema_name}.${t.table_name}`))}
                        className="flex items-center gap-0.5 bg-amber-900/40 hover:bg-amber-800/60 border border-amber-700/60 text-amber-300 px-1.5 py-0.5 rounded transition-colors whitespace-nowrap"
                      >
                        <FlaskConical size={10} />
                        {unanalyzed.length} to analyze
                      </button>
                    )}
                    <button
                      onClick={() => openAnalyzeModal(sub.tables.map(t => `${t.schema_name}.${t.table_name}`), sub.database ?? undefined)}
                      className="flex items-center gap-0.5 text-gray-600 hover:text-amber-400 border border-gray-700 hover:border-amber-700 px-1 py-0.5 rounded transition-colors"
                      title="Reanalyze all tables"
                    >
                      <RefreshCw size={10} />
                    </button>
                  </div>
                </td>

                {/* col 7: debug */}
                <td className="px-1 py-2 text-xs">
                  <button
                    onClick={() => setDebugSub({ subName: sub.sub_name, database: sub.database ?? '' })}
                    className="flex items-center gap-0.5 text-gray-600 hover:text-gray-300 border border-gray-700 hover:border-gray-500 px-1 py-0.5 rounded transition-colors whitespace-nowrap"
                    title="Debug subscription"
                  >
                    <Bug size={10} /> debug
                  </button>
                </td>

                {/* col 8: expand */}
                <td className="pr-3 py-2 text-xs text-right">
                  <button
                    onClick={() => toggleSubExpanded(sub.sub_name)}
                    className="flex items-center gap-0.5 text-gray-400 hover:text-gray-200 whitespace-nowrap ml-auto"
                  >
                    {subExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {subExpanded ? 'Hide tables' : 'Show tables'}
                  </button>
                </td>
              </tr>

              {/* Table list — lazy */}
              {subExpanded && sub.tables.length > 0 && (
                <tr><td colSpan={8} className="p-0">
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
                      const isCopying = row.status === 'copying'
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
                                  onClick={() => openAnalyzeModal([`${row.schema_name}.${row.table_name}`], sub.database ?? undefined)}
                                  className="bg-amber-900/40 hover:bg-amber-800/60 border border-amber-700/60 text-amber-300 px-1.5 py-0.5 rounded"
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
              </td></tr>
              )}
              {subExpanded && sub.tables.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-2 text-xs text-gray-500">No tables tracked for this subscription.</td></tr>
              )}
            </React.Fragment>
          )
        })}
          </tbody>
        </table>
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
                          disabled={actionLoading || sub.subenabled || !isSlotDropped(sub)}
                          title={sub.subenabled ? 'Stop or pause replication first before truncating' : !isSlotDropped(sub) ? 'Available only after slot is dropped (replication stopped)' : 'TRUNCATE all destination tables then VACUUM FULL — removes all data and reclaims disk space'}
                          className="text-xs text-teal-400/70 hover:text-teal-300 border border-teal-900/50 hover:border-teal-700 px-2 py-1 rounded disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          <Database size={10} /> Truncate
                        </button>
                        <button
                          onClick={() => setConfirmDropSub({ subName: sub.subname, database: getSubDatabase(sub.subname) ?? sub.database ?? undefined })}
                          disabled={actionLoading || sub.subenabled}
                          className="text-xs text-red-500/70 hover:text-red-400 border border-red-900/60 hover:border-red-800 px-2 py-1 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                          title={sub.subenabled ? 'Stop or pause replication first before dropping' : 'DROP SUBSCRIPTION on destination'}
                        >
                          Drop sub
                        </button>
                        {sub.subpublications?.length > 0 && (
                          <button
                            onClick={() => setConfirmDropPub({ subName: sub.subname, pubName: sub.subpublications[0], database: getSubDatabase(sub.subname) ?? sub.database ?? undefined })}
                            disabled={actionLoading || sub.subenabled}
                            className="text-xs text-red-500/70 hover:text-red-400 border border-red-900/60 hover:border-red-800 px-2 py-1 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                            title={sub.subenabled ? 'Stop or pause replication first before dropping publication' : 'DROP PUBLICATION on source'}
                          >
                            Drop pub
                          </button>
                        )}
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

      {/* Unused (orphaned) publications — publications on source with no subscription on dest */}
      {unusedPubs && unusedPubs.length > 0 && (
        <div className="bg-gray-900 border border-amber-800/50 rounded-lg overflow-hidden">
          <button
            className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-gray-800/30"
            onClick={() => setUnusedPubsExpanded(v => !v)}
          >
            <AlertTriangle size={14} className="text-amber-400 shrink-0" />
            <span className="font-semibold text-amber-300 flex-1">
              Unused Publications
              <span className="ml-2 text-xs font-normal text-amber-500">
                {unusedPubs.length} publication{unusedPubs.length !== 1 ? 's' : ''} on source with no subscription on destination
              </span>
            </span>
            {unusedPubsExpanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
          </button>

          {unusedPubsExpanded && (
            <div className="border-t border-gray-800 divide-y divide-gray-800">
              {unusedPubs.map(pub => (
                <div key={pub.pub_name} className="px-4 py-3 flex items-start gap-3">
                  <Layers size={13} className="text-gray-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-gray-200 font-medium">{pub.pub_name}</span>
                      {pub.database && (
                        <span className="text-xs bg-blue-950 border border-blue-800 text-blue-300 rounded px-1.5 py-0.5 font-mono">{pub.database}</span>
                      )}
                      <span className="text-xs text-gray-500">{pub.table_count} table{pub.table_count !== 1 ? 's' : ''}</span>
                      {pub.schemas.length > 0 && (
                        <span className="text-xs text-gray-500">· schemas: {pub.schemas.join(', ')}</span>
                      )}
                    </div>
                    {pub.tables.length > 0 && (
                      <div className="mt-1 text-xs text-gray-600 font-mono truncate" title={pub.tables.join(', ')}>
                        {pub.tables.slice(0, 5).join(', ')}{pub.tables.length > 5 ? ` +${pub.tables.length - 5} more` : ''}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        setConnectPubModal(pub)
                        const suggested = pub.pub_name.replace(/pub/gi, m => m === m.toUpperCase() ? 'SUB' : m[0] === m[0].toUpperCase() ? 'Sub' : 'sub')
                        setConnectForm({ subName: suggested, slotName: suggested, copyData: true, truncateDest: false })
                        setConnectError('')
                      }}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-blue-900/50 border border-blue-700 text-blue-300 hover:bg-blue-800/50"
                      title="Create a subscription on destination that connects to this publication"
                    >
                      <Link size={11} /> Connect
                    </button>
                    <button
                      onClick={() => setConfirmDropUnusedPub(pub)}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-red-950/50 border border-red-800/50 text-red-400 hover:bg-red-900/50"
                      title="Drop this publication from source"
                    >
                      <Trash2 size={11} /> Drop
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
      {confirmDropSub && (
        <ConfirmModal
          title="Drop Subscription"
          message={`Drop subscription "${confirmDropSub.subName}"${confirmDropSub.database ? ` (database: ${confirmDropSub.database})` : ''} from destination? The slot will also be removed. Replication will stop.`}
          confirmLabel="Drop Subscription"
          onConfirm={() => handleDropSubscription(confirmDropSub.subName, confirmDropSub.database)}
          onCancel={() => setConfirmDropSub(null)}
        />
      )}
      {confirmDropPub && (
        <ConfirmModal
          title="Drop Publication"
          message={`Drop publication "${confirmDropPub.pubName}" from source? This will stop replication for all subscribers of this publication.`}
          confirmLabel="Drop Publication"
          onConfirm={() => handleDropPublication(confirmDropPub.pubName, confirmDropPub.database)}
          onCancel={() => setConfirmDropPub(null)}
        />
      )}

      {vacuumTarget && !vacuumResult && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
            <h3 className="text-lg font-bold text-teal-400 mb-1">Truncate Destination Tables</h3>
            <p className="text-gray-400 text-xs mb-3">
              Runs <code className="bg-gray-800 px-1 rounded">TRUNCATE</code> then <code className="bg-gray-800 px-1 rounded">VACUUM FULL</code> on all replicated tables.<br />
              <span className="text-red-400">This removes ALL data from destination tables.</span> Use before re-syncing from source.
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
                Run Truncate
              </button>
            </div>
          </div>
        </div>
      )}

      {vacuumResult && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
            <h3 className="text-lg font-bold text-teal-400 mb-3">Truncate Complete</h3>
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

      {/* Analyze Modal */}
      {analyzeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
            <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between shrink-0">
              <span className="font-semibold text-gray-200 flex items-center gap-2">
                <FlaskConical size={14} className="text-amber-400" />
                ANALYZE {analyzeModal.tables.length} table{analyzeModal.tables.length !== 1 ? 's' : ''}
              </span>
              {!analyzeRunning && (
                <button onClick={() => setAnalyzeModal(null)} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
              )}
            </div>

            {/* Options — only before running */}
            {!analyzeRunning && !analyzeDone && (
              <div className="px-5 py-3 border-b border-gray-800 shrink-0">
                <label className="flex items-center gap-3 text-xs text-gray-400">
                  <span className="whitespace-nowrap">Statistics target</span>
                  <input
                    type="number"
                    min={1} max={10000}
                    placeholder="default (100)"
                    value={statisticsTarget}
                    onChange={e => setStatisticsTarget(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-32 bg-gray-800 border border-gray-600 rounded px-2 py-1 focus:outline-none focus:border-blue-500 text-gray-200"
                  />
                  <span className="text-gray-600">1–10000, default=100</span>
                </label>
                {analyzeModal.allTables && analyzeModal.allTables.length > analyzeModal.tables.length && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      id="analyze-all"
                      onChange={e => {
                        const next = e.target.checked ? analyzeModal.allTables! : analyzeModal.tables
                        setAnalyzeModal(m => m ? { ...m, tables: next } : m)
                        setAnalyzeSteps(next.map(t => ({ table: t, status: 'pending' })))
                      }}
                      className="accent-amber-500"
                    />
                    <label htmlFor="analyze-all">Include already-analyzed tables ({analyzeModal.allTables.length} total)</label>
                  </div>
                )}
              </div>
            )}

            {/* Progress list */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1">
              {analyzeRunning || analyzeDone ? analyzeSteps.map(step => (
                <div key={step.table} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0">
                    {step.status === 'pending' && <Circle size={11} className="text-gray-700" />}
                    {step.status === 'running' && <Loader size={11} className="text-blue-400 animate-spin" />}
                    {step.status === 'ok' && <CheckCircle size={11} className="text-green-400" />}
                    {step.status === 'error' && <XCircle size={11} className="text-red-400" />}
                  </span>
                  <span className={clsx('font-mono flex-1 truncate', {
                    'text-gray-600': step.status === 'pending',
                    'text-blue-300': step.status === 'running',
                    'text-gray-400': step.status === 'ok',
                    'text-red-400': step.status === 'error',
                  })}>{step.table}</span>
                  {step.error && <span className="text-red-500 text-xs truncate max-w-xs" title={step.error}>{step.error}</span>}
                </div>
              )) : (
                <div className="text-xs text-gray-500 py-2 max-h-48 overflow-y-auto space-y-0.5">
                  {analyzeModal.tables.map(t => <div key={t} className="font-mono text-gray-600">{t}</div>)}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 pb-4 pt-3 border-t border-gray-800 flex items-center justify-between shrink-0">
              {analyzeRunning && (
                <span className="text-xs text-gray-400 flex items-center gap-2">
                  <Spinner size={3} />
                  {analyzeSteps.filter(s => s.status === 'ok' || s.status === 'error').length} / {analyzeSteps.length}
                </span>
              )}
              {!analyzeRunning && analyzeDone && (
                <span className="text-xs text-green-400">
                  Done — {analyzeSteps.filter(s => s.status === 'ok').length} ok, {analyzeSteps.filter(s => s.status === 'error').length} errors
                </span>
              )}
              {!analyzeRunning && !analyzeDone && <span />}
              <div className="flex gap-2">
                {!analyzeRunning && !analyzeDone && (
                  <>
                    <button onClick={() => setAnalyzeModal(null)} className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">Cancel</button>
                    <button
                      onClick={() => runAnalyze(analyzeModal.tables, analyzeModal.database)}
                      className="text-xs px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 font-semibold text-white flex items-center gap-1.5"
                    >
                      <FlaskConical size={11} /> Run ANALYZE
                    </button>
                  </>
                )}
                {!analyzeRunning && analyzeDone && (
                  <button onClick={() => setAnalyzeModal(null)} className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200">Close</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmDropUnusedPub && (
        <ConfirmModal
          title="Drop Publication"
          message={`Drop publication "${confirmDropUnusedPub.pub_name}" from source database "${confirmDropUnusedPub.database}"? It has no active subscriptions so this is safe, but it cannot be undone without recreating it.`}
          confirmLabel="Drop Publication"
          onConfirm={() => handleDropUnusedPub(confirmDropUnusedPub)}
          onCancel={() => setConfirmDropUnusedPub(null)}
        />
      )}

      {connectPubModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md mx-4 flex flex-col">
            <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
              <Link size={14} className="text-blue-400" />
              <h3 className="font-bold text-blue-300">Connect to Publication</h3>
              <span className="ml-1 font-mono text-gray-400 text-sm">"{connectPubModal.pub_name}"</span>
            </div>
            <div className="px-5 py-4 space-y-4">
              <p className="text-xs text-gray-400">
                Creates a subscription on the <span className="text-gray-300">destination</span> that replicates from publication <span className="font-mono text-blue-300">{connectPubModal.pub_name}</span> on source database <span className="font-mono text-blue-300">{connectPubModal.database}</span>.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Subscription name <span className="text-red-400">*</span></label>
                  <input
                    type="text"
                    placeholder="e.g. my_sub"
                    value={connectForm.subName}
                    onChange={e => setConnectForm(f => ({ ...f, subName: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm font-mono focus:border-blue-500 outline-none"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    Replication slot name <span className="text-gray-600">(optional — leave blank to auto-generate)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. my_slot (auto if blank)"
                    value={connectForm.slotName}
                    onChange={e => setConnectForm(f => ({ ...f, slotName: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm font-mono focus:border-blue-500 outline-none"
                  />
                  <p className="text-xs text-gray-600 mt-1">Lowercase letters, digits, underscores only. Max 63 chars.</p>
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={connectForm.copyData}
                    onChange={e => setConnectForm(f => ({ ...f, copyData: e.target.checked }))}
                    className="accent-blue-500"
                  />
                  <span className="text-gray-300">Copy existing data (COPY DATA)</span>
                  <span className="text-xs text-gray-600">— uncheck to replicate only new changes</span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={connectForm.truncateDest}
                    onChange={e => setConnectForm(f => ({ ...f, truncateDest: e.target.checked }))}
                    className="accent-red-500 mt-0.5 shrink-0"
                  />
                  <div>
                    <span className="text-red-300 font-medium">TRUNCATE destination tables before connecting</span>
                    {(() => {
                      const dsn = connState?.dest_dsn
                      if (!dsn) return null
                      try {
                        const u = new URL(dsn)
                        const db = connectPubModal?.database ?? u.pathname.replace(/^\//, '')
                        const hint = `${u.hostname}${u.port ? ':' + u.port : ''}/${db}`
                        return (
                          <div className="text-xs text-red-500/80 mt-0.5 font-mono">
                            → will TRUNCATE on <span className="text-red-400">{hint}</span>
                            <span className="text-red-500/60 font-sans"> (only tables listed in this publication)</span>
                          </div>
                        )
                      } catch { return null }
                    })()}
                  </div>
                </label>
              </div>
              {connectError && (
                <div className="text-xs text-red-400 bg-red-950/50 border border-red-800 rounded p-2">{connectError}</div>
              )}
            </div>
            <div className="px-5 pb-4 border-t border-gray-800 pt-3 flex justify-end gap-2">
              <button
                onClick={() => { setConnectPubModal(null); setConnectError('') }}
                className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleConnectSubscription}
                disabled={connectLoading || !connectForm.subName.trim()}
                className="text-xs px-4 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white font-semibold flex items-center gap-1.5 disabled:opacity-40"
              >
                {connectLoading ? <><Spinner size={3} /> Creating…</> : <><Link size={11} /> Create Subscription</>}
              </button>
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
