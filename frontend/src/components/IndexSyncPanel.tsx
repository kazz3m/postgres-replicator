import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { replicationApi, IndexInfo, IndexCreateResult } from '../api/client'
import { Badge } from './Badge'
import { Spinner } from './Spinner'
import { RefreshCw, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  publication: string
}

export function IndexSyncPanel({ publication }: Props) {
  const [creating, setCreating] = useState(false)
  const [results, setResults] = useState<IndexCreateResult[] | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())  // index_name

  const { data: indexes, isLoading, refetch } = useQuery({
    queryKey: ['schema-indexes', publication],
    queryFn: () => replicationApi.listIndexes(publication).then(r => r.data),
    enabled: !!publication,
  })

  // Group by table
  const byTable: Record<string, IndexInfo[]> = {}
  for (const idx of indexes ?? []) {
    if (!byTable[idx.table]) byTable[idx.table] = []
    byTable[idx.table].push(idx)
  }
  const tables = Object.keys(byTable).sort()
  const totalIndexes = indexes?.length ?? 0

  function toggleTable(t: string) {
    setExpanded(prev => {
      const next = new Set(prev); next.has(t) ? next.delete(t) : next.add(t); return next
    })
  }

  function toggleIndex(name: string) {
    setSelected(prev => {
      const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next
    })
  }

  function toggleTableIndexes(t: string) {
    const idxs = byTable[t].map(i => i.index_name)
    const allSel = idxs.every(n => selected.has(n))
    setSelected(prev => {
      const next = new Set(prev)
      if (allSel) idxs.forEach(n => next.delete(n))
      else idxs.forEach(n => next.add(n))
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(indexes?.map(i => i.index_name) ?? []))
  }

  function deselectAll() {
    setSelected(new Set())
  }

  async function handleCreate() {
    setCreating(true); setError(''); setResults(null)
    // Build table list from selected indexes
    const tablesToSync = tables.filter(t =>
      byTable[t].some(i => selected.has(i.index_name))
    )
    try {
      const { data } = await replicationApi.createIndexes(undefined, tablesToSync)
      setResults(data)
      refetch()
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setCreating(false)
    }
  }

  function resultVariant(a: string): 'green' | 'red' | 'gray' {
    if (a === 'created') return 'green'
    if (a === 'error') return 'red'
    return 'gray'
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <span className="font-semibold text-gray-300">Index Management</span>
          <span className="ml-2 text-xs text-gray-500">
            Indexes are NOT replicated — create on destination after initial copy for best performance
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="p-1.5 rounded hover:bg-gray-700" title="Refresh">
            <RefreshCw size={13} />
          </button>
          {selected.size > 0 && (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="text-xs bg-purple-700 hover:bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded font-semibold flex items-center gap-1.5"
            >
              {creating && <Spinner size={3} />}
              Create {selected.size} index{selected.size !== 1 ? 'es' : ''}
            </button>
          )}
        </div>
      </div>

      {/* Recommendation note */}
      <div className="px-4 py-2 bg-blue-950/20 border-b border-blue-900/40 text-xs text-blue-300">
        <strong>Recommended:</strong> Create indexes <em>after</em> initial data copy completes (status = ready).
        Creating before replication slows down the INSERT-heavy copy phase.
        Use "Create indexes" in the Stop flow to apply them once replication finishes.
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-950/30 border-b border-red-900 flex gap-2">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {results && (
        <div className="px-4 py-3 border-b border-gray-700 space-y-1">
          {results.map(r => (
            <div key={r.index_name} className="flex items-start gap-2 text-xs">
              <Badge label={r.action} variant={resultVariant(r.action)} />
              <span className="font-mono text-gray-300">{r.index_name}</span>
              <span className="text-gray-500 text-xs">{r.table}</span>
              {r.detail && <span className="text-red-400">{r.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="p-4 flex items-center gap-2 text-sm text-gray-500"><Spinner /> Loading...</div>
      ) : totalIndexes === 0 ? (
        <div className="p-4 text-sm text-gray-500">No non-primary-key indexes found in publication.</div>
      ) : (
        <>
          {/* Select toolbar */}
          <div className="px-4 py-2 border-b border-gray-700 flex items-center gap-3 text-xs">
            <button onClick={selectAll} className="text-blue-400 hover:text-blue-300">Select all</button>
            <button onClick={deselectAll} className="text-gray-400 hover:text-gray-200">Deselect all</button>
            <span className="ml-auto text-gray-600">
              {selected.size}/{totalIndexes} selected
            </span>
          </div>

          {/* Tree */}
          <div className="divide-y divide-gray-800">
            {tables.map(t => {
              const idxs = byTable[t]
              const isExp = expanded.has(t)
              const selCount = idxs.filter(i => selected.has(i.index_name)).length
              const allSel = selCount === idxs.length
              const someSel = selCount > 0 && !allSel

              return (
                <div key={t}>
                  <div
                    className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-gray-800 select-none"
                    onClick={() => toggleTable(t)}
                  >
                    {isExp ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="font-mono text-gray-300 flex-1 text-xs">{t}</span>
                    <span className="text-xs text-gray-600">{idxs.length} index{idxs.length !== 1 ? 'es' : ''}</span>
                    <TableCheckbox
                      checked={allSel}
                      indeterminate={someSel}
                      onChange={() => toggleTableIndexes(t)}
                    />
                  </div>
                  {isExp && (
                    <div className="border-t border-gray-800 divide-y divide-gray-800/60">
                      {idxs.map(idx => (
                        <label
                          key={idx.index_name}
                          className={`flex items-start gap-3 pl-10 pr-4 py-2 cursor-pointer hover:bg-gray-800 ${
                            selected.has(idx.index_name) ? 'bg-purple-950/20' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(idx.index_name)}
                            onChange={() => toggleIndex(idx.index_name)}
                            className="accent-purple-500 cursor-pointer mt-0.5 shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-mono text-gray-300">{idx.index_name}</div>
                            <div className="text-xs text-gray-600 font-mono truncate mt-0.5" title={idx.index_def}>
                              {idx.index_def}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function TableCheckbox({
  checked, indeterminate, onChange,
}: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="accent-purple-500 cursor-pointer"
      onClick={e => e.stopPropagation()}
    />
  )
}

