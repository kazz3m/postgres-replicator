import { useState } from 'react'
import { replicationApi, SchemaInfo } from '../api/client'
import { Spinner } from '../components/Spinner'
import { ConfirmModal } from '../components/ConfirmModal'

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

// Extract "schema.table" from "db.schema.table" key (last 2 parts)
function toSchemaTable(key: string): string {
  const parts = key.split('.')
  return parts.length >= 3 ? parts.slice(1).join('.') : key
}

// Extract "schema" from "db.schema" key (last part)
function toSchema(key: string): string {
  const parts = key.split('.')
  return parts.length >= 2 ? parts.slice(1).join('.') : key
}

// Group keys by database (first part of key)
function groupByDb<T>(keys: Set<string>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const key of keys) {
    const db = key.split('.')[0]
    if (!result[db]) result[db] = []
    result[db].push(key)
  }
  return result
}

export function ReplicationSetupPage({ selectedTables, selectedSchemas, sourceDsn, pgMajor, schemaData }: Props) {
  const [pubName, setPubName] = useState('pg_sync_pub')
  const [subName, setSubName] = useState('pg_sync_sub')
  const [copyData, setCopyData] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [confirmAction, setConfirmAction] = useState<null | 'apply' | 'drop_pub' | 'drop_sub'>(null)

  const hasSelection = selectedTables.size > 0 || selectedSchemas.size > 0

  // totalBytes still works with schemaData (which is flat schema list for current db)
  const totalBytes = schemaData.reduce((sum, schema) => {
    if ([...selectedSchemas].some(k => toSchema(k) === schema.schema_name)) {
      return sum + schema.total_size_bytes
    }
    return sum + schema.tables.reduce((s, t) =>
      [...selectedTables].some(k => toSchemaTable(k) === `${t.schema_name}.${t.table_name}`)
        ? s + t.size_bytes : s, 0)
  }, 0)

  // Databases involved in selection
  const selectedDbs = new Set([
    ...[...selectedTables].map(k => k.split('.')[0]),
    ...[...selectedSchemas].map(k => k.split('.')[0]),
  ])
  const multiDb = selectedDbs.size > 1

  async function applyReplication() {
    setLoading(true); setError(''); setResult('')
    try {
      // For publication: strip db prefix — PostgreSQL only knows schema.table within a DB
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
      setResult(`Publication "${pubName}" and subscription "${subName}" created/updated successfully.`)
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
    } finally {
      setLoading(false); setConfirmAction(null)
    }
  }

  async function dropSubscription() {
    setLoading(true); setError('')
    try {
      await replicationApi.dropSubscription(subName)
      setResult(`Subscription "${subName}" dropped.`)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false); setConfirmAction(null)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-lg font-bold">Replication Setup</h2>

      {!hasSelection && (
        <div className="text-yellow-400 bg-yellow-950 border border-yellow-800 rounded px-3 py-2 text-sm">
          No tables or schemas selected. Go to the Analysis tab to select what to replicate.
        </div>
      )}

      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-gray-300">Selection Summary</h3>
        {multiDb && (
          <div className="text-xs text-yellow-400 bg-yellow-950/30 border border-yellow-800 rounded px-3 py-2">
            ⚠️ Tables from multiple databases selected ({Array.from(selectedDbs).join(', ')}).
            PostgreSQL logical replication works per-database — each database needs a separate publication/subscription pair.
            Only one database's tables will be included in this publication.
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
            <span className="text-blue-300 break-all">
              {Array.from(selectedTables).map(toSchemaTable).join(', ')}
            </span>
          </div>
        )}
      </div>

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
          <input
            type="checkbox"
            checked={copyData}
            onChange={e => setCopyData(e.target.checked)}
            className="accent-blue-500"
          />
          <span className="text-gray-300">Copy existing data (initial sync)</span>
        </label>
      </div>

      {hasSelection && (
        <div className="text-sm text-gray-300">
          Total data to sync: <span className="text-white font-semibold">{formatBytes(totalBytes)}</span>
          {totalBytes > 10 * 1024 * 1024 * 1024 && (
            <span className="text-yellow-400 ml-2">⚠️ Large dataset — initial sync may take a long time</span>
          )}
        </div>
      )}

      <div className="text-xs text-blue-400 bg-blue-950 border border-blue-800 rounded px-3 py-2">
        ℹ️ Tables missing on destination will be detected automatically before applying replication.
        Use the <strong>Schema Sync</strong> panel in the Status tab to create them with one click.
      </div>

{error && <div className="text-red-400 text-sm bg-red-950 border border-red-800 rounded p-3">{error}</div>}
      {result && <div className="text-green-400 text-sm bg-green-950 border border-green-800 rounded p-3">{result}</div>}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => setConfirmAction('apply')}
          disabled={loading || !hasSelection}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-sm font-semibold flex items-center gap-2"
        >
          {loading && <Spinner size={3} />} Apply Replication
        </button>
        <button
          onClick={() => setConfirmAction('drop_sub')}
          disabled={loading}
          className="px-4 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 rounded text-sm flex items-center gap-2"
        >
          Drop Subscription
        </button>
        <button
          onClick={() => setConfirmAction('drop_pub')}
          disabled={loading}
          className="px-4 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 rounded text-sm flex items-center gap-2"
        >
          Drop Publication
        </button>
      </div>

      {confirmAction === 'apply' && (
        <ConfirmModal
          title="Apply Replication"
          message={`This will create or replace publication "${pubName}" on source and subscription "${subName}" on destination. Existing replication will be interrupted and restarted.`}
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
