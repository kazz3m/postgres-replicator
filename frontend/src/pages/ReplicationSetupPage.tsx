import { useState, useEffect } from 'react'
import { replicationApi, SchemaInfo, TableSchemaDiff, SchemaSyncResult } from '../api/client'
import { Spinner } from '../components/Spinner'
import { ConfirmModal } from '../components/ConfirmModal'
import { Badge } from '../components/Badge'
import { CheckCircle, AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  selectedTables: Set<string>   // "db.schema.table"
  selectedSchemas: Set<string>  // "db.schema"
  sourceDsn: string
  pgMajor: number
  schemaData: SchemaInfo[]
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function toSchemaTable(key: string): string {
  const parts = key.split('.')
  return parts.length >= 3 ? parts.slice(1).join('.') : key
}

function toSchema(key: string): string {
  const parts = key.split('.')
  return parts.length >= 2 ? parts.slice(1).join('.') : key
}

// ── Schema check panel ────────────────────────────────────────────────────────

interface SchemaCheckPanelProps {
  tables: string[]   // "schema.table" — already stripped of db prefix
  onAllOk: (ok: boolean) => void
}

function SchemaCheckPanel({ tables, onAllOk }: SchemaCheckPanelProps) {
  const [diffs, setDiffs] = useState<TableSchemaDiff[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResults, setSyncResults] = useState<SchemaSyncResult[] | null>(null)
  const [createIndexes, setCreateIndexes] = useState<'before' | 'after'>('after')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  async function runCheck() {
    if (tables.length === 0) return
    setChecking(true); setError(''); setSyncResults(null)
    try {
      const { data } = await replicationApi.schemaCheck(tables)
      setDiffs(data)
      const allOk = data.every(d => d.exists_on_dest && d.compatible)
      onAllOk(allOk)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
      onAllOk(false)
    } finally {
      setChecking(false)
    }
  }

  async function runSync() {
    setSyncing(true); setError(''); setSyncResults(null)
    try {
      const { data } = await replicationApi.schemaSyncByTables(tables, createIndexes)
      setSyncResults(data)
      await runCheck()
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setSyncing(false)
    }
  }

  // Auto-check whenever table list changes
  useEffect(() => {
    if (tables.length > 0) runCheck()
    else { setDiffs(null); onAllOk(true) }
  }, [tables.join(',')])

  function toggleExpand(t: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n })
  }

  if (tables.length === 0) return null

  const missing = diffs?.filter(d => !d.exists_on_dest) ?? []
  const incompatible = diffs?.filter(d => d.exists_on_dest && !d.compatible) ?? []
  const ok = diffs?.filter(d => d.exists_on_dest && d.compatible) ?? []
  const allOk = diffs != null && missing.length === 0 && incompatible.length === 0

  return (
    <div className={clsx(
      'border rounded-lg overflow-hidden',
      allOk ? 'border-green-800 bg-green-950/20' : 'border-orange-800 bg-orange-950/20'
    )}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-700">
        <div className="flex items-center gap-2">
          {checking ? <Spinner size={3} /> : allOk
            ? <CheckCircle size={14} className="text-green-400" />
            : <AlertTriangle size={14} className="text-orange-400" />}
          <span className="font-semibold text-sm text-gray-300">
            Destination Schema Check
          </span>
          {diffs && !checking && (
            <span className="text-xs text-gray-500">
              {ok.length} ok · {missing.length} missing · {incompatible.length} incompatible
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!allOk && missing.length > 0 && diffs && (
            <>
              <select
                value={createIndexes}
                onChange={e => setCreateIndexes(e.target.value as 'before' | 'after')}
                className="text-xs bg-gray-800 border border-gray-600 rounded px-2 py-1 focus:outline-none"
              >
                <option value="after">Indexes: after replication</option>
                <option value="before">Indexes: before replication</option>
              </select>
              <button
                onClick={runSync}
                disabled={syncing}
                className="flex items-center gap-1.5 text-xs bg-orange-700 hover:bg-orange-600 disabled:opacity-50 px-3 py-1.5 rounded font-semibold"
              >
                {syncing && <Spinner size={3} />}
                Create {missing.length} missing table{missing.length !== 1 ? 's' : ''}
              </button>
            </>
          )}
          <button onClick={runCheck} disabled={checking} className="p-1.5 rounded hover:bg-gray-700" title="Re-check">
            <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-950/30 border-b border-red-900 flex gap-2">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {syncResults && (
        <div className="px-4 py-2 border-b border-gray-700 flex flex-wrap gap-2 text-xs">
          {syncResults.map(r => (
            <span key={r.table} className={clsx('flex items-center gap-1', {
              'text-green-400': r.action === 'created',
              'text-red-400': r.action === 'error',
              'text-gray-400': r.action === 'already_exists',
              'text-yellow-400': r.action === 'incompatible',
            })}>
              {r.action === 'created' ? '✓' : r.action === 'error' ? '✗' : '·'} {r.table}
            </span>
          ))}
        </div>
      )}

      {incompatible.length > 0 && (
        <div className="px-4 py-2 border-b border-yellow-900 bg-yellow-950/20 text-xs text-yellow-400">
          <AlertTriangle size={12} className="inline mr-1" />
          {incompatible.length} table{incompatible.length !== 1 ? 's' : ''} exist on destination but have incompatible columns — manual intervention required.
        </div>
      )}

      {/* Table list */}
      {diffs && diffs.length > 0 && (
        <div className="divide-y divide-gray-800/50 max-h-64 overflow-y-auto">
          {diffs.map(diff => {
            const status = !diff.exists_on_dest ? 'missing' : !diff.compatible ? 'incompatible' : 'ok'
            const isExp = expanded.has(diff.table)
            return (
              <div key={diff.table}>
                <div
                  className="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-gray-800/50 text-xs"
                  onClick={() => toggleExpand(diff.table)}
                >
                  {isExp ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="font-mono text-gray-300 flex-1">{diff.table}</span>
                  <Badge
                    label={status}
                    variant={status === 'ok' ? 'green' : status === 'missing' ? 'red' : 'yellow'}
                  />
                </div>
                {isExp && diff.columns.length > 0 && (
                  <div className="px-4 pb-2 pl-10 bg-gray-950/30">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-600">
                          <th className="text-left py-0.5 pr-4">Column</th>
                          <th className="text-left py-0.5 pr-4">Source type</th>
                          <th className="text-left py-0.5">Dest type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.columns.map(col => (
                          <tr key={col.column_name} className={col.match ? 'text-gray-500' : 'text-yellow-400'}>
                            <td className="font-mono pr-4 py-0.5">{col.column_name}</td>
                            <td className="font-mono pr-4 py-0.5">{col.source_type}</td>
                            <td className="font-mono py-0.5">
                              {col.dest_type ?? <span className="text-red-400">missing</span>}
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
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ReplicationSetupPage({ selectedTables, selectedSchemas, sourceDsn, pgMajor, schemaData }: Props) {
  const [pubName, setPubName] = useState('pg_sync_pub')
  const [subName, setSubName] = useState('pg_sync_sub')
  const [copyData, setCopyData] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [confirmAction, setConfirmAction] = useState<null | 'apply' | 'drop_pub' | 'drop_sub'>(null)
  const [schemaOk, setSchemaOk] = useState(false)

  const hasSelection = selectedTables.size > 0 || selectedSchemas.size > 0

  const totalBytes = schemaData.reduce((sum, schema) => {
    if ([...selectedSchemas].some(k => toSchema(k) === schema.schema_name))
      return sum + schema.total_size_bytes
    return sum + schema.tables.reduce((s, t) =>
      [...selectedTables].some(k => toSchemaTable(k) === `${t.schema_name}.${t.table_name}`)
        ? s + t.size_bytes : s, 0)
  }, 0)

  const selectedDbs = new Set([
    ...[...selectedTables].map(k => k.split('.')[0]),
    ...[...selectedSchemas].map(k => k.split('.')[0]),
  ])
  const multiDb = selectedDbs.size > 1

  // Tables for schema check — strip db prefix, deduplicate
  // For schema-level selections we can't know exact tables until pub exists,
  // so schema check only runs when individual tables are selected.
  const tablesToCheck = [...selectedTables].map(toSchemaTable)

  async function applyReplication() {
    setLoading(true); setError(''); setResult('')
    try {
      const target = selectedSchemas.size > 0
        ? { schemas: Array.from(selectedSchemas).map(toSchema) }
        : { tables: Array.from(selectedTables).map(toSchemaTable) }

      await replicationApi.createPublication({ publication_name: pubName, target })
      await replicationApi.createSubscription({
        subscription_name: subName,
        publication_name: pubName,
        source_dsn: sourceDsn,
        copy_data: copyData,
      })
      setResult(`Publication "${pubName}" and subscription "${subName}" created successfully.`)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false); setConfirmAction(null)
    }
  }

  async function dropPublication() {
    setLoading(true); setError('')
    try {
      await replicationApi.dropPublication(pubName)
      setResult(`Publication "${pubName}" dropped.`)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally { setLoading(false); setConfirmAction(null) }
  }

  async function dropSubscription() {
    setLoading(true); setError('')
    try {
      await replicationApi.dropSubscription(subName)
      setResult(`Subscription "${subName}" dropped.`)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally { setLoading(false); setConfirmAction(null) }
  }

  // Apply is allowed when: has selection AND (schema-level OR all tables ok on dest)
  const canApply = hasSelection && (selectedSchemas.size > 0 || schemaOk)

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-lg font-bold">Replication Setup</h2>

      {!hasSelection && (
        <div className="text-yellow-400 bg-yellow-950 border border-yellow-800 rounded px-3 py-2 text-sm">
          No tables or schemas selected. Go to the Analysis tab to select what to replicate.
        </div>
      )}

      {/* Selection summary */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-gray-300">Selection Summary</h3>
        {multiDb && (
          <div className="text-xs text-yellow-400 bg-yellow-950/30 border border-yellow-800 rounded px-3 py-2">
            ⚠️ Tables from multiple databases selected ({Array.from(selectedDbs).join(', ')}).
            PostgreSQL logical replication works per-database — each database needs a separate publication/subscription pair.
          </div>
        )}
        {selectedSchemas.size > 0 && (
          <div className="text-sm">
            <span className="text-gray-400">Schemas: </span>
            <span className="text-blue-300">{Array.from(selectedSchemas).map(toSchema).join(', ')}</span>
            {pgMajor >= 15 && <span className="text-gray-500 ml-2">(schema-level publication)</span>}
          </div>
        )}
        {selectedTables.size > 0 && (
          <div className="text-sm">
            <span className="text-gray-400">Tables: </span>
            <span className="text-blue-300 break-all">{Array.from(selectedTables).map(toSchemaTable).join(', ')}</span>
          </div>
        )}
        {hasSelection && (
          <div className="text-sm text-gray-400">
            Total data: <span className="text-white font-semibold">{formatBytes(totalBytes)}</span>
            {totalBytes > 10 * 1024 * 1024 * 1024 && (
              <span className="text-yellow-400 ml-2">⚠️ Large dataset — initial sync may take a long time</span>
            )}
          </div>
        )}
      </div>

      {/* Schema check — only for table-level selections */}
      {tablesToCheck.length > 0 && (
        <SchemaCheckPanel
          tables={tablesToCheck}
          onAllOk={setSchemaOk}
        />
      )}

      {/* Schema-level note — tables unknown until pub exists */}
      {selectedSchemas.size > 0 && selectedTables.size === 0 && (
        <div className="text-xs text-blue-400 bg-blue-950 border border-blue-800 rounded px-3 py-2">
          ℹ️ Schema-level publication selected — exact tables are resolved by PostgreSQL at replication time.
          After applying replication, use the <strong>Schema Sync</strong> panel in Status tab to verify and create any missing tables.
        </div>
      )}

      {/* Configuration */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-gray-300">Configuration</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-gray-400 mb-1 text-xs uppercase tracking-wider">Publication Name</label>
            <input
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              value={pubName}
              onChange={e => setPubName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-gray-400 mb-1 text-xs uppercase tracking-wider">Subscription Name</label>
            <input
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              value={subName}
              onChange={e => setSubName(e.target.value)}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <input type="checkbox" checked={copyData} onChange={e => setCopyData(e.target.checked)} className="accent-blue-500" />
          <span className="text-gray-300">Copy existing data (initial sync)</span>
        </label>
      </div>

      {error && <div className="text-red-400 text-sm bg-red-950 border border-red-800 rounded p-3">{error}</div>}
      {result && <div className="text-green-400 text-sm bg-green-950 border border-green-800 rounded p-3">{result}</div>}

      {/* Actions */}
      <div className="flex flex-wrap gap-3 items-center">
        <button
          onClick={() => setConfirmAction('apply')}
          disabled={loading || !canApply}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-sm font-semibold flex items-center gap-2"
          title={!schemaOk && tablesToCheck.length > 0 ? 'Fix missing/incompatible tables on destination first' : undefined}
        >
          {loading && <Spinner size={3} />} Apply Replication
        </button>
        {!canApply && tablesToCheck.length > 0 && (
          <span className="text-xs text-orange-400">
            Fix missing/incompatible tables above before applying
          </span>
        )}
        <div className="flex gap-2 ml-auto">
          <button onClick={() => setConfirmAction('drop_sub')} disabled={loading}
            className="px-3 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 rounded text-sm">
            Drop Subscription
          </button>
          <button onClick={() => setConfirmAction('drop_pub')} disabled={loading}
            className="px-3 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 rounded text-sm">
            Drop Publication
          </button>
        </div>
      </div>

      {confirmAction === 'apply' && (
        <ConfirmModal
          title="Apply Replication"
          message={`Create publication "${pubName}" on source and subscription "${subName}" on destination. Existing replication will be interrupted and restarted.`}
          confirmLabel="Apply"
          onConfirm={applyReplication}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'drop_pub' && (
        <ConfirmModal
          title="Drop Publication"
          message={`Drop publication "${pubName}" from source? This will stop replication.`}
          confirmLabel="Drop"
          onConfirm={dropPublication}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'drop_sub' && (
        <ConfirmModal
          title="Drop Subscription"
          message={`Drop subscription "${subName}" from destination? This will stop replication.`}
          confirmLabel="Drop"
          onConfirm={dropSubscription}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  )
}
