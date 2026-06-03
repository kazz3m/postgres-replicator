import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { replicationApi, TableReplicationProgress, ReplicationSlotInfo, SubscriptionInfo } from '../api/client'
import { Badge } from '../components/Badge'
import { ConfirmModal } from '../components/ConfirmModal'
import { Spinner } from '../components/Spinner'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import type { WorkspaceSnapshot } from './WorkspacePicker'

function ProgressBar({ pct }: { pct: number | null | undefined }) {
  const v = pct ?? 0
  return (
    <div className="w-full bg-gray-800 rounded-full h-1.5">
      <div
        className="h-1.5 rounded-full bg-blue-500 transition-all"
        style={{ width: `${Math.min(100, v)}%` }}
      />
    </div>
  )
}

function statusVariant(s: string): 'green' | 'yellow' | 'blue' | 'red' | 'gray' {
  if (s === 'synced' || s === 'ready') return 'green'
  if (s === 'copying') return 'blue'
  if (s === 'initializing') return 'yellow'
  if (s === 'error') return 'red'
  return 'gray'
}

interface Props {
  initialSnapshot?: WorkspaceSnapshot
}

export function StatusPage({ initialSnapshot }: Props) {
  const [interval, setIntervalSecs] = useState(10)
  const [editInterval, setEditInterval] = useState(false)
  const [intervalInput, setIntervalInput] = useState('10')
  const [confirmReset, setConfirmReset] = useState<string | null>(null)
  const [confirmDropSlot, setConfirmDropSlot] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState('')

  const { data: progress, refetch: refetchProgress, isLoading: progressLoading } = useQuery({
    queryKey: ['progress'],
    queryFn: () => replicationApi.progress().then(r => r.data),
    refetchInterval: interval * 1000,
    initialData: initialSnapshot?.progress,
  })

  const { data: slots, refetch: refetchSlots, isLoading: slotsLoading } = useQuery({
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

  function refetchAll() { refetchProgress(); refetchSlots(); refetchSubs() }

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

      {/* Table progress */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 font-semibold text-gray-300">Table Replication Progress</div>
        {progressLoading ? (
          <div className="p-4 flex items-center gap-2"><Spinner /> Loading...</div>
        ) : !progress?.length ? (
          <div className="p-4 text-gray-500 text-sm">No tables tracked yet. Set up replication first.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700">
                <th className="px-4 py-2 text-left">Schema</th>
                <th className="px-4 py-2 text-left">Table</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Rows</th>
                <th className="px-4 py-2 text-left w-32">Progress</th>
              </tr>
            </thead>
            <tbody>
              {progress.map((row: TableReplicationProgress) => (
                <tr key={`${row.schema_name}.${row.table_name}`} className="border-b border-gray-800 hover:bg-gray-800">
                  <td className="px-4 py-2 text-gray-400">{row.schema_name}</td>
                  <td className="px-4 py-2">{row.table_name}</td>
                  <td className="px-4 py-2"><Badge label={row.status} variant={statusVariant(row.status)} /></td>
                  <td className="px-4 py-2 text-right text-gray-400">{row.total_rows?.toLocaleString() ?? '–'}</td>
                  <td className="px-4 py-2">
                    <ProgressBar pct={row.progress_pct} />
                    <span className="text-gray-500">{row.progress_pct != null ? `${row.progress_pct.toFixed(0)}%` : '–'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Subscriptions */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 font-semibold text-gray-300">Subscriptions</div>
        {!subs?.length ? (
          <div className="p-4 text-gray-500 text-sm">No subscriptions found.</div>
        ) : (
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
                  <td className="px-4 py-2 text-gray-400">{sub.subpublications?.join(', ')}</td>
                  <td className="px-4 py-2 text-gray-400">{sub.subslotname || '–'}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => setConfirmReset(sub.subname)}
                      disabled={actionLoading}
                      className="text-xs text-red-400 hover:text-red-300 border border-red-800 px-2 py-1 rounded"
                    >
                      Reset
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Slots */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 font-semibold text-gray-300">Replication Slots (Source)</div>
        {slotsLoading ? (
          <div className="p-4 flex items-center gap-2"><Spinner /> Loading...</div>
        ) : !slots?.length ? (
          <div className="p-4 text-gray-500 text-sm">No replication slots found.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700">
                <th className="px-4 py-2 text-left">Slot</th>
                <th className="px-4 py-2 text-left">Plugin</th>
                <th className="px-4 py-2 text-left">Active</th>
                <th className="px-4 py-2 text-right">Lag (bytes)</th>
                <th className="px-4 py-2 text-left">Flush LSN</th>
                <th className="px-4 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {slots?.map((slot: ReplicationSlotInfo) => (
                <tr key={slot.slot_name} className="border-b border-gray-800 hover:bg-gray-800">
                  <td className="px-4 py-2 font-semibold">{slot.slot_name}</td>
                  <td className="px-4 py-2 text-gray-400">{slot.plugin}</td>
                  <td className="px-4 py-2">
                    <Badge label={slot.active ? 'active' : 'inactive'} variant={slot.active ? 'green' : 'gray'} />
                  </td>
                  <td className="px-4 py-2 text-right text-gray-400">
                    {slot.lag_bytes != null
                      ? slot.lag_bytes > 1_000_000
                        ? <span className="text-yellow-400">{(slot.lag_bytes / 1_000_000).toFixed(1)} MB</span>
                        : `${slot.lag_bytes.toLocaleString()} B`
                      : '–'}
                  </td>
                  <td className="px-4 py-2 text-gray-400 font-mono">{slot.confirmed_flush_lsn || '–'}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => setConfirmDropSlot(slot.slot_name)}
                      disabled={actionLoading || slot.active}
                      className="text-xs text-red-400 hover:text-red-300 border border-red-800 px-2 py-1 rounded disabled:opacity-40"
                      title={slot.active ? 'Cannot drop active slot' : 'Drop slot'}
                    >
                      Drop
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
    </div>
  )
}
