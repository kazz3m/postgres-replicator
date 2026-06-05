import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { analysisApi, replicationApi, SchemaInfo } from '../api/client'
import { Spinner } from './Spinner'
import { Search, ChevronRight, ChevronDown, Database, Table, X, Plus } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  pubName: string
  onClose: () => void
  onAdded: (tables: string[], refreshed: string[]) => void
}

export function AddTableModal({ pubName, onClose, onAdded }: Props) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: schemas, isLoading } = useQuery({
    queryKey: ['schemas'],
    queryFn: () => analysisApi.schemas().then(r => r.data),
  })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const q = search.trim().toLowerCase()

  const filtered = schemas
    ? schemas
        .map(s => ({
          ...s,
          tables: q
            ? s.tables.filter(
                t => t.table_name.toLowerCase().includes(q) || s.schema_name.toLowerCase().includes(q)
              )
            : s.tables,
        }))
        .filter(s => s.tables.length > 0)
    : []

  // Auto-expand schemas with matching tables when searching
  useEffect(() => {
    if (q && filtered.length > 0) {
      setExpanded(new Set(filtered.map(s => s.schema_name)))
    }
  }, [q])

  function toggleExpand(schema: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(schema) ? next.delete(schema) : next.add(schema)
      return next
    })
  }

  function toggleTable(key: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleSchema(schema: SchemaInfo) {
    const keys = schema.tables.map(t => `${t.schema_name}.${t.table_name}`)
    const allSelected = keys.every(k => selected.has(k))
    setSelected(prev => {
      const next = new Set(prev)
      if (allSelected) keys.forEach(k => next.delete(k))
      else keys.forEach(k => next.add(k))
      return next
    })
  }

  async function handleAdd() {
    if (selected.size === 0) return
    setLoading(true); setError('')
    const tables = Array.from(selected)
    const allRefreshed: string[] = []
    const errors: string[] = []

    for (const table of tables) {
      try {
        const { data } = await replicationApi.addTableToPublication(pubName, table)
        data.subscriptions_refreshed.forEach((s: string) => {
          if (!allRefreshed.includes(s)) allRefreshed.push(s)
        })
      } catch (e: any) {
        errors.push(`${table}: ${e.response?.data?.detail || e.message}`)
      }
    }

    setLoading(false)
    if (errors.length > 0) {
      setError(errors.join('\n'))
    } else {
      onAdded(tables, allRefreshed)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 shrink-0">
          <div>
            <h3 className="font-semibold text-gray-200">Add tables to publication</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="text-blue-400">{pubName}</span>
              {selected.size > 0 && (
                <span className="ml-2 text-blue-300">{selected.size} selected</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-700 text-gray-400">
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tables..."
              className="w-full bg-gray-800 border border-gray-600 rounded pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-6 flex items-center gap-2 text-sm text-gray-500">
              <Spinner /> Loading schemas...
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">
              {q ? `No tables matching "${search}"` : 'No tables found.'}
            </div>
          ) : (
            <div className="divide-y divide-gray-800">
              {filtered.map(schema => {
                const isExpanded = expanded.has(schema.schema_name)
                const schemaKeys = schema.tables.map(t => `${t.schema_name}.${t.table_name}`)
                const selectedCount = schemaKeys.filter(k => selected.has(k)).length
                const allSel = selectedCount === schemaKeys.length && schemaKeys.length > 0
                const someSel = selectedCount > 0 && !allSel

                return (
                  <div key={schema.schema_name}>
                    <div
                      className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-800 cursor-pointer select-none"
                      onClick={() => toggleExpand(schema.schema_name)}
                    >
                      <span className="text-gray-500 shrink-0">
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </span>
                      <Database size={13} className="text-blue-400 shrink-0" />
                      <span className="font-medium text-sm flex-1">{schema.schema_name}</span>
                      <span className="text-xs text-gray-500">{schema.tables.length} tables</span>
                      <SchemaCheckbox
                        checked={allSel}
                        indeterminate={someSel}
                        onChange={() => toggleSchema(schema)}
                      />
                    </div>
                    {isExpanded && (
                      <div className="border-t border-gray-800">
                        {schema.tables.map(t => {
                          const key = `${t.schema_name}.${t.table_name}`
                          const isSel = selected.has(key)
                          const isHighlighted = q && t.table_name.toLowerCase().includes(q)
                          return (
                            <label
                              key={key}
                              className={clsx(
                                'flex items-center gap-3 pl-9 pr-4 py-2 cursor-pointer hover:bg-gray-800 text-xs',
                                isSel && 'bg-blue-950/25',
                                isHighlighted && !isSel && 'bg-yellow-950/20',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={isSel}
                                onChange={() => toggleTable(key)}
                                className="accent-blue-500 cursor-pointer shrink-0"
                              />
                              <Table size={11} className="text-gray-500 shrink-0" />
                              <span className={clsx('flex-1', isHighlighted && !isSel && 'text-yellow-300')}>
                                {t.table_name}
                              </span>
                              <span className="text-gray-600">{t.size_pretty}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 text-xs text-red-400 bg-red-950/30 border-t border-red-900 shrink-0 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-700 shrink-0">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-200">
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={selected.size === 0 || loading}
            className="flex items-center gap-2 text-sm bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-4 py-2 rounded font-medium"
          >
            {loading ? <Spinner size={3} /> : <Plus size={14} />}
            Add {selected.size > 0 ? `${selected.size} table${selected.size !== 1 ? 's' : ''}` : 'tables'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SchemaCheckbox({
  checked, indeterminate, onChange,
}: {
  checked: boolean; indeterminate: boolean; onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="accent-blue-500 cursor-pointer shrink-0"
      onClick={e => e.stopPropagation()}
    />
  )
}
