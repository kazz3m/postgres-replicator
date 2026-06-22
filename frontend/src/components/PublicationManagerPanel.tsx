import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { replicationApi, analysisApi } from '../api/client'
import { Spinner } from './Spinner'
import { AlertTriangle, CheckCircle, Plus, Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  pubName: string
  database: string
  subName?: string
}

export function PublicationManagerPanel({ pubName, database, subName }: Props) {
  const [removing, setRemoving] = useState<string | null>(null)  // "schema" or "schema.table"
  const [refreshing, setRefreshing] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [collapsedSchemas, setCollapsedSchemas] = useState<Set<string>>(new Set())
  const [confirmDropSchema, setConfirmDropSchema] = useState<string | null>(null)

  // Schema picker for adding tables
  const [addSchema, setAddSchema] = useState('')
  const [addTable, setAddTable] = useState('')
  const [adding, setAdding] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  const { data: cfg, refetch: refetchCfg, isLoading } = useQuery({
    queryKey: ['pub-config', pubName, database],
    queryFn: () => replicationApi.publicationConfig(pubName, database).then(r => r.data),
  })

  const { data: schemas } = useQuery({
    queryKey: ['schema-list-mgr', database],
    queryFn: () => analysisApi.databaseSchemaList(database).then(r => r.data),
    enabled: showAdd,
  })

  const { data: tables } = useQuery({
    queryKey: ['schema-tables-mgr', database, addSchema],
    queryFn: () => analysisApi.schemaTables(database, addSchema).then(r => r.data),
    enabled: showAdd && !!addSchema,
  })

  async function handleRemoveTable(table: string) {
    setRemoving(table); setMsg(null)
    try {
      await replicationApi.dropTableFromPublication(pubName, table, database)
      setMsg({ ok: true, text: `Removed ${table} from publication.` })
      refetchCfg()
    } catch (e: any) {
      setMsg({ ok: false, text: e.response?.data?.detail || e.message })
    } finally {
      setRemoving(null)
    }
  }

  async function handleRemoveSchema(schema: string) {
    setRemoving(schema); setMsg(null); setConfirmDropSchema(null)
    try {
      const res = await replicationApi.dropSchemaFromPublication(pubName, schema, database)
      const dropped = res.data.tables_dropped
      setMsg({ ok: true, text: `Removed ${dropped.length} table(s) from schema "${schema}".` })
      refetchCfg()
    } catch (e: any) {
      setMsg({ ok: false, text: e.response?.data?.detail || e.message })
    } finally {
      setRemoving(null)
    }
  }

  async function handleAdd() {
    if (!addSchema || !addTable) return
    const qualified = `${addSchema}.${addTable}`
    setAdding(true); setMsg(null)
    try {
      await replicationApi.addTableToPublication(pubName, qualified, database)
      setMsg({ ok: true, text: `Added ${qualified} to publication. Subscriptions refreshed.` })
      refetchCfg()
      setAddTable(''); setShowAdd(false)
    } catch (e: any) {
      setMsg({ ok: false, text: e.response?.data?.detail || e.message })
    } finally {
      setAdding(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true); setMsg(null)
    try {
      const res = await replicationApi.refreshPublicationSubscriptions(pubName, database)
      const { refreshed, errors } = res.data as { refreshed: string[]; errors: { sub: string; error: string }[] }
      if (errors.length === 0) {
        setMsg({ ok: true, text: `Refreshed ${refreshed.length} subscription(s): ${refreshed.join(', ')}` })
      } else {
        setMsg({ ok: false, text: `Errors: ${errors.map(e => `${e.sub}: ${e.error}`).join('; ')}` })
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e.response?.data?.detail || e.message })
    } finally {
      setRefreshing(false)
    }
  }

  function toggleSchema(schema: string) {
    setCollapsedSchemas(prev => {
      const next = new Set(prev)
      next.has(schema) ? next.delete(schema) : next.add(schema)
      return next
    })
  }

  const currentTables: string[] = cfg?.tables ?? []

  // Group by schema
  const bySchema = new Map<string, string[]>()
  for (const t of currentTables) {
    const dot = t.indexOf('.')
    const schema = dot >= 0 ? t.slice(0, dot) : ''
    const tname = dot >= 0 ? t.slice(dot + 1) : t
    if (!bySchema.has(schema)) bySchema.set(schema, [])
    bySchema.get(schema)!.push(tname)
  }
  const sortedSchemas = [...bySchema.keys()].sort()

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <span className="font-semibold text-gray-300 text-sm font-mono">{pubName}</span>
          <span className="ml-2 text-xs text-gray-500">{database}</span>
          {!isLoading && (
            <span className="ml-2 text-xs text-gray-500">{currentTables.length} tables</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAdd(v => !v)}
            className="flex items-center gap-1 text-xs bg-blue-900/40 hover:bg-blue-800/60 border border-blue-700/60 text-blue-300 px-2 py-1 rounded transition-colors"
          >
            <Plus size={11} /> Add table
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 px-2 py-1 rounded disabled:opacity-50 transition-colors"
            title="ALTER SUBSCRIPTION ... REFRESH PUBLICATION on all linked subscriptions"
          >
            {refreshing ? <Spinner size={2} /> : <RefreshCw size={11} />}
            Refresh subscriptions
          </button>
          <button onClick={() => refetchCfg()} className="text-gray-600 hover:text-gray-300 p-1">
            <RefreshCw size={11} />
          </button>
        </div>
      </div>

      {/* Message */}
      {msg && (
        <div className={clsx('px-4 py-2 text-xs flex items-start gap-1.5 border-b',
          msg.ok ? 'text-green-400 border-green-900 bg-green-950/20' : 'text-red-400 border-red-900 bg-red-950/20'
        )}>
          {msg.ok ? <CheckCircle size={11} className="shrink-0 mt-0.5" /> : <AlertTriangle size={11} className="shrink-0 mt-0.5" />}
          {msg.text}
        </div>
      )}

      {/* Add table form */}
      {showAdd && (
        <div className="px-4 py-3 border-b border-gray-700 bg-gray-950/30 flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Schema</label>
            <select value={addSchema} onChange={e => { setAddSchema(e.target.value); setAddTable('') }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500">
              <option value="">— select —</option>
              {schemas?.map(s => <option key={s.schema_name} value={s.schema_name}>{s.schema_name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Table</label>
            <select value={addTable} onChange={e => setAddTable(e.target.value)}
              disabled={!addSchema}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-50 min-w-48">
              <option value="">— select —</option>
              {tables
                ?.filter(t => !currentTables.includes(`${addSchema}.${t.table_name}`))
                .map(t => <option key={t.table_name} value={t.table_name}>{t.table_name}</option>)}
            </select>
          </div>
          <button onClick={handleAdd} disabled={!addSchema || !addTable || adding}
            className="flex items-center gap-1 text-xs bg-blue-800 hover:bg-blue-700 px-3 py-1.5 rounded disabled:opacity-50">
            {adding ? <Spinner size={2} /> : <Plus size={11} />} Add
          </button>
          <button onClick={() => setShowAdd(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
        </div>
      )}

      {/* Confirm drop schema */}
      {confirmDropSchema && (
        <div className="px-4 py-3 border-b border-red-900/50 bg-red-950/20 flex items-center gap-3 text-xs">
          <AlertTriangle size={13} className="text-red-400 shrink-0" />
          <span className="text-red-300">
            Remove all <span className="font-mono font-semibold">{bySchema.get(confirmDropSchema)?.length}</span> tables
            from schema <span className="font-mono font-semibold">"{confirmDropSchema}"</span> from the publication?
          </span>
          <div className="flex gap-2 ml-auto shrink-0">
            <button
              onClick={() => setConfirmDropSchema(null)}
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
            >Cancel</button>
            <button
              onClick={() => handleRemoveSchema(confirmDropSchema)}
              className="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-white font-semibold flex items-center gap-1"
            >
              <Trash2 size={10} /> Remove schema
            </button>
          </div>
        </div>
      )}

      {/* Table list grouped by schema */}
      {isLoading ? (
        <div className="p-4 flex items-center gap-2 text-gray-500 text-xs"><Spinner size={3} /> Loading...</div>
      ) : currentTables.length === 0 ? (
        <div className="p-4 text-xs text-gray-500">No tables in this publication.</div>
      ) : (
        <div className="max-h-[32rem] overflow-y-auto">
          {sortedSchemas.map(schema => {
            const schemaTables = bySchema.get(schema)!.sort()
            const collapsed = collapsedSchemas.has(schema)
            const isRemovingSchema = removing === schema
            return (
              <div key={schema} className="border-b border-gray-800 last:border-0">
                {/* Schema header row */}
                <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-950/60 sticky top-0 z-10">
                  <button
                    onClick={() => toggleSchema(schema)}
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 flex-1 text-left"
                  >
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span className="font-mono font-semibold text-blue-300">{schema}</span>
                    <span className="text-gray-600">({schemaTables.length})</span>
                  </button>
                  <button
                    onClick={() => setConfirmDropSchema(schema)}
                    disabled={!!removing}
                    className="flex items-center gap-1 text-xs text-red-500/60 hover:text-red-400 border border-red-900/40 hover:border-red-800 px-1.5 py-0.5 rounded disabled:opacity-30 transition-colors"
                    title={`Remove all tables from schema "${schema}"`}
                  >
                    {isRemovingSchema ? <Spinner size={2} /> : <Trash2 size={9} />}
                    Remove schema
                  </button>
                </div>

                {/* Tables */}
                {!collapsed && (
                  <div>
                    {schemaTables.map(tname => {
                      const qualified = `${schema}.${tname}`
                      const isRemovingTable = removing === qualified
                      return (
                        <div key={tname} className="flex items-center border-b border-gray-800/50 last:border-0 hover:bg-gray-800/30 px-4 py-1 group">
                          <span className="font-mono text-xs text-gray-400 flex-1">{tname}</span>
                          <button
                            onClick={() => handleRemoveTable(qualified)}
                            disabled={!!removing}
                            className="flex items-center gap-1 text-xs text-red-500/40 hover:text-red-400 border border-transparent hover:border-red-900/40 px-1.5 py-0.5 rounded disabled:opacity-30 transition-colors opacity-0 group-hover:opacity-100"
                            title={`ALTER PUBLICATION ${pubName} DROP TABLE ${qualified}`}
                          >
                            {isRemovingTable ? <Spinner size={2} /> : <Trash2 size={9} />}
                            Remove
                          </button>
                        </div>
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
  )
}
