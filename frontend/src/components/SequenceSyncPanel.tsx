import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { replicationApi, SequenceInfo } from '../api/client'
import { Badge } from './Badge'
import { Spinner } from './Spinner'
import { RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react'
import { ConfirmModal } from './ConfirmModal'

export function SequenceSyncPanel({ database }: { database?: string }) {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<any[] | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [error, setError] = useState('')

  const { data: sequences, isLoading, refetch } = useQuery({
    queryKey: ['sequences', database],
    queryFn: () => replicationApi.listSequences(database).then(r => r.data),
  })

  const needsSync = sequences?.filter(s => s.needs_sync) ?? []
  const upToDate = sequences?.filter(s => !s.needs_sync) ?? []

  async function handleSyncAll() {
    setSyncing(true); setError(''); setSyncResult(null)
    try {
      const { data } = await replicationApi.syncSequences(undefined, database)
      setSyncResult(data.synced)
      refetch()
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setSyncing(false); setConfirmAll(false)
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <span className="font-semibold text-gray-300">Sequence Synchronization</span>
          <span className="ml-2 text-xs text-gray-500">
            Sequences are NOT replicated — sync manually after initial copy or failover
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="p-1.5 rounded hover:bg-gray-700" title="Refresh">
            <RefreshCw size={13} />
          </button>
          {needsSync.length > 0 && (
            <button
              onClick={() => setConfirmAll(true)}
              disabled={syncing}
              className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-3 py-1.5 rounded font-semibold flex items-center gap-1.5"
            >
              {syncing && <Spinner size={3} />}
              Sync all ({needsSync.length})
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-950/30 border-b border-red-900 flex gap-2">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {syncResult && (
        <div className="px-4 py-2 text-xs text-green-400 bg-green-950/20 border-b border-green-900">
          <CheckCircle size={13} className="inline mr-1.5" />
          Synced {syncResult.length} sequence{syncResult.length !== 1 ? 's' : ''}.
        </div>
      )}

      {isLoading ? (
        <div className="p-4 flex items-center gap-2 text-sm text-gray-500"><Spinner /> Loading...</div>
      ) : !sequences?.length ? (
        <div className="p-4 text-sm text-gray-500">No sequences found on source.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-700 bg-gray-900/50">
              <th className="px-4 py-2 text-left">Sequence</th>
              <th className="px-4 py-2 text-left">Owned by</th>
              <th className="px-4 py-2 text-right">Source value</th>
              <th className="px-4 py-2 text-right">Dest value</th>
              <th className="px-4 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {[...needsSync, ...upToDate].map((seq: SequenceInfo) => (
              <tr key={seq.sequence_name} className="border-b border-gray-800 hover:bg-gray-800">
                <td className="px-4 py-2 font-mono text-gray-300">{seq.sequence_name}</td>
                <td className="px-4 py-2 text-gray-500 font-mono">
                  {seq.table_name !== seq.sequence_name
                    ? `${seq.table_name}.${seq.column_name}`
                    : seq.column_name}
                </td>
                <td className="px-4 py-2 text-right font-mono">{seq.source_value.toLocaleString()}</td>
                <td className="px-4 py-2 text-right font-mono text-gray-400">
                  {seq.dest_value != null ? seq.dest_value.toLocaleString() : <span className="text-yellow-500">missing</span>}
                </td>
                <td className="px-4 py-2">
                  {seq.needs_sync
                    ? <Badge label="needs sync" variant="yellow" />
                    : <Badge label="in sync" variant="green" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmAll && (
        <ConfirmModal
          title="Sync All Sequences"
          message={`Set ${needsSync.length} sequence(s) on destination to match source high-water marks. Uses setval(seq, max_value, true) — next generated value will be max+1. Safe to run during active replication.`}
          confirmLabel="Sync All"
          onConfirm={handleSyncAll}
          onCancel={() => setConfirmAll(false)}
        />
      )}
    </div>
  )
}
