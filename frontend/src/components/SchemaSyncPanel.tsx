import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { replicationApi, TableSchemaDiff, SchemaSyncResult } from '../api/client'
import { Badge } from './Badge'
import { Spinner } from './Spinner'
import { RefreshCw, ChevronDown, ChevronRight, AlertTriangle, CheckCircle } from 'lucide-react'

interface Props { publication: string }

export function SchemaSyncPanel({ publication }: Props) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)
  const [syncResults, setSyncResults] = useState<SchemaSyncResult[] | null>(null)
  const [error, setError] = useState('')

  const { data: diffs, isLoading, refetch } = useQuery({
    queryKey: ['schema-diff', publication],
    queryFn: () => replicationApi.schemaDiff(publication).then(r => r.data),
    enabled: !!publication,
  })

  const missing = diffs?.filter(d => !d.exists_on_dest) ?? []
  const incompatible = diffs?.filter(d => d.exists_on_dest && !d.compatible) ?? []
  const ok = diffs?.filter(d => d.exists_on_dest && d.compatible) ?? []

  async function handleSync() {
    setSyncing(true); setError(''); setSyncResults(null)
    try {
      const { data } = await replicationApi.schemaSync(publication)
      setSyncResults(data)
      refetch()
      qc.invalidateQueries({ queryKey: ['schema-diff'] })
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setSyncing(false)
    }
  }

  function toggleExpand(t: string) {
    setExpanded(prev => {
      const next = new Set(prev); next.has(t) ? next.delete(t) : next.add(t); return next
    })
  }

  function actionVariant(a: string): 'green' | 'red' | 'yellow' | 'gray' {
    if (a === 'created') return 'green'
    if (a === 'error' || a === 'incompatible') return 'red'
    if (a === 'already_exists') return 'gray'
    return 'gray'
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <span className="font-semibold text-gray-300">Schema Verification</span>
          <span className="ml-2 text-xs text-gray-500">
            DDL is NOT replicated — tables must exist on destination before subscription
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="p-1.5 rounded hover:bg-gray-700" title="Refresh">
            <RefreshCw size={13} />
          </button>
          {missing.length > 0 && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="text-xs bg-orange-700 hover:bg-orange-600 disabled:opacity-50 px-3 py-1.5 rounded font-semibold flex items-center gap-1.5"
            >
              {syncing && <Spinner size={3} />}
              Create {missing.length} missing table{missing.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-950/30 border-b border-red-900 flex gap-2">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {syncResults && (
        <div className="px-4 py-3 border-b border-gray-700 space-y-1">
          {syncResults.map(r => (
            <div key={r.table} className="flex items-start gap-2 text-xs">
              <Badge label={r.action} variant={actionVariant(r.action)} />
              <span className="font-mono text-gray-300">{r.table}</span>
              {r.detail && <span className="text-gray-500">{r.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {incompatible.length > 0 && (
        <div className="px-4 py-2 border-b border-yellow-900 bg-yellow-950/20">
          <div className="text-xs text-yellow-400 font-semibold mb-1 flex items-center gap-1.5">
            <AlertTriangle size={12} /> {incompatible.length} incompatible table{incompatible.length !== 1 ? 's' : ''} — column mismatch
          </div>
          <div className="text-xs text-gray-500">
            These tables exist on destination but have different column types. Manual intervention required.
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="p-4 flex items-center gap-2 text-sm text-gray-500"><Spinner /> Comparing schemas...</div>
      ) : !diffs?.length ? (
        <div className="p-4 text-sm text-gray-500">No tables found in publication.</div>
      ) : (
        <div className="divide-y divide-gray-800">
          {diffs.map((diff: TableSchemaDiff) => {
            const isExpanded = expanded.has(diff.table)
            const status = !diff.exists_on_dest ? 'missing'
              : !diff.compatible ? 'incompatible'
              : 'ok'
            const statusVariant = status === 'ok' ? 'green' : status === 'missing' ? 'red' : 'yellow'

            return (
              <div key={diff.table}>
                <div
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-800"
                  onClick={() => toggleExpand(diff.table)}
                >
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="font-mono text-gray-300 flex-1 text-xs">{diff.table}</span>
                  <Badge label={status} variant={statusVariant} />
                </div>
                {isExpanded && (
                  <div className="px-4 pb-3 pl-10">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-600">
                          <th className="text-left py-1">Column</th>
                          <th className="text-left py-1">Source type</th>
                          <th className="text-left py-1">Dest type</th>
                          <th className="text-left py-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.columns.map(col => (
                          <tr key={col.column_name} className={col.match ? '' : 'text-yellow-400'}>
                            <td className="py-0.5 font-mono pr-4">{col.column_name}</td>
                            <td className="py-0.5 font-mono pr-4 text-gray-400">{col.source_type}</td>
                            <td className="py-0.5 font-mono pr-4 text-gray-400">
                              {col.dest_type ?? <span className="text-red-400">missing</span>}
                            </td>
                            <td className="py-0.5">
                              {col.match
                                ? <CheckCircle size={11} className="text-green-600" />
                                : <AlertTriangle size={11} className="text-yellow-500" />}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!isLoading && diffs && (
        <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600 flex gap-4">
          <span className="text-green-600">{ok.length} OK</span>
          <span className="text-red-500">{missing.length} missing</span>
          <span className="text-yellow-500">{incompatible.length} incompatible</span>
          <span className="text-gray-600 ml-auto">Indexes are not created automatically — add after sync for performance.</span>
        </div>
      )}
    </div>
  )
}
