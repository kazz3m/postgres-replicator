import { useState, useEffect, useRef, useCallback } from 'react'
import { replicationApi, SchemaInfo, TableSchemaDiff, SchemaSyncResult } from '../api/client'
import { ReplicationConfig } from '../utils/profiles'
import { Spinner } from '../components/Spinner'
import { ConfirmModal } from '../components/ConfirmModal'
import { Badge } from '../components/Badge'
import { CheckCircle, AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Circle, XCircle, Loader } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  selectedTables: Set<string>   // "db.schema.table"
  selectedSchemas: Set<string>  // "db.schema"
  sourceDsn: string
  pgMajor: number
  schemaData: SchemaInfo[]
  replConfigs?: Record<string, ReplicationConfig>   // all saved configs, keyed by pub_name
  activeSetupPub?: string                           // pub to pre-select on mount
  onReplConfigChange?: (cfg: ReplicationConfig) => void
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

// ── Name helpers ──────────────────────────────────────────────────────────────

function randomPrefix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function buildPubName(prefix: string, label: string): string {
  const l = label.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')
  return l ? `${prefix}_pg_sync_pub_${l}` : `${prefix}_pg_sync_pub`
}

function buildSubName(prefix: string, label: string): string {
  const l = label.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')
  return l ? `${prefix}_pg_sync_sub_${l}` : `${prefix}_pg_sync_sub`
}

/** Extract prefix + label from an existing name that follows the convention. */
function parsePubSubName(name: string): { prefix: string; label: string } | null {
  // Matches: {8chars}_pg_sync_{pub|sub}_{label} or {8chars}_pg_sync_{pub|sub}
  const m = name.match(/^([a-z0-9]{8})_pg_sync_(?:pub|sub)(?:_(.+))?$/)
  if (!m) return null
  return { prefix: m[1], label: m[2] ?? '' }
}

function extractError(e: any): string {
  return e?.response?.data?.detail
    || e?.response?.data?.message
    || (typeof e?.response?.data === 'string' ? e.response.data : null)
    || e?.message
    || 'Unknown error'
}

function toSchema(key: string): string {
  const parts = key.split('.')
  return parts.length >= 2 ? parts.slice(1).join('.') : key
}

// ── Apply progress modal ──────────────────────────────────────────────────────

type StepState = 'pending' | 'running' | 'ok' | 'error'

interface Step {
  label: string
  state: StepState
  detail?: string
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'running') return <Loader size={14} className="text-blue-400 animate-spin shrink-0" />
  if (state === 'ok')      return <CheckCircle size={14} className="text-green-400 shrink-0" />
  if (state === 'error')   return <XCircle size={14} className="text-red-400 shrink-0" />
  return <Circle size={14} className="text-gray-600 shrink-0" />
}

interface ApplyModalProps {
  pubName: string
  subName: string
  steps: Step[]
  done: boolean
  onClose: () => void
  onConfirm: () => void
}

function ApplyModal({ pubName, subName, steps, done, onClose, onConfirm }: ApplyModalProps) {
  const started = steps.some(s => s.state !== 'pending')
  const hasError = steps.some(s => s.state === 'error')

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl">
        <div className="px-6 pt-5 pb-3">
          <h3 className="text-lg font-bold text-gray-200">Apply Replication</h3>
          <p className="text-xs text-gray-500 mt-1">
            Publication <span className="text-blue-300 font-mono">"{pubName}"</span> →{' '}
            Subscription <span className="text-blue-300 font-mono">"{subName}"</span>
          </p>
          <p className="text-xs text-gray-600 mt-1">
            The destination PostgreSQL will connect back to the source using the replication DSN.
            Both servers must be able to reach each other over the network.
          </p>
        </div>

        {/* Steps */}
        <div className="px-6 pb-4 space-y-2">
          {steps.map((step, i) => (
            <div key={i} className="flex items-start gap-3">
              <StepIcon state={step.state} />
              <div className="min-w-0">
                <span className={clsx('text-sm', {
                  'text-gray-400': step.state === 'pending',
                  'text-blue-300': step.state === 'running',
                  'text-green-300': step.state === 'ok',
                  'text-red-300': step.state === 'error',
                })}>
                  {step.label}
                </span>
                {step.detail && (
                  <p className="text-xs text-gray-500 mt-0.5 break-words">{step.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 pb-5 flex gap-3 justify-end border-t border-gray-800 pt-4">
          {!started && (
            <>
              <button onClick={onClose}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm">
                Cancel
              </button>
              <button onClick={onConfirm}
                className="px-4 py-2 bg-blue-700 hover:bg-blue-600 rounded text-sm font-semibold">
                Apply
              </button>
            </>
          )}
          {started && !done && (
            <span className="text-xs text-gray-500 flex items-center gap-1.5">
              <Spinner size={3} /> Working...
            </span>
          )}
          {done && (
            <button onClick={onClose}
              className={clsx('px-4 py-2 rounded text-sm font-semibold', hasError
                ? 'bg-gray-700 hover:bg-gray-600'
                : 'bg-green-700 hover:bg-green-600'
              )}>
              {hasError ? 'Close' : 'Done'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
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
      setError(extractError(e))
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
      setError(extractError(e))
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

export function ReplicationSetupPage({ selectedTables, selectedSchemas, sourceDsn, pgMajor, schemaData, replConfigs = {}, activeSetupPub, onReplConfigChange }: Props) {
  // Derive the active config: activeSetupPub hint → first saved → defaults
  const activeConfig: ReplicationConfig = (activeSetupPub && replConfigs[activeSetupPub])
    ? replConfigs[activeSetupPub]
    : Object.values(replConfigs)[0] ?? { pub_name: '', sub_name: '', copy_data: true }

  function initFromConfig(cfg: ReplicationConfig): { prefix: string; label: string } {
    const parsed = parsePubSubName(cfg.pub_name)
    if (parsed) return parsed
    // Legacy / non-standard name — keep as label, generate fresh prefix
    return { prefix: randomPrefix(), label: cfg.pub_name.replace(/^pg_sync_pub_?/, '') }
  }

  const initParsed = initFromConfig(activeConfig)
  const [prefix, setPrefix] = useState(initParsed.prefix || randomPrefix())
  const [label, setLabel] = useState(initParsed.label)
  const [copyData, setCopyData] = useState(activeConfig.copy_data)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [confirmAction, setConfirmAction] = useState<null | 'drop_pub' | 'drop_sub'>(null)
  const [schemaOk, setSchemaOk] = useState(false)
  const [showApplyModal, setShowApplyModal] = useState(false)
  const [applySteps, setApplySteps] = useState<Step[]>([])
  const [applyDone, setApplyDone] = useState(false)

  // Derived names — always consistent
  const pubName = buildPubName(prefix, label)
  const subName = buildSubName(prefix, label)

  // When activeSetupPub changes (badge click in Analysis → Setup tab), switch config
  const prevActivePub = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!activeSetupPub || activeSetupPub === prevActivePub.current) return
    prevActivePub.current = activeSetupPub
    const cfg = replConfigs[activeSetupPub]
    if (cfg) {
      const p = parsePubSubName(cfg.pub_name)
      setPrefix(p?.prefix ?? randomPrefix())
      setLabel(p?.label ?? '')
      setCopyData(cfg.copy_data)
    } else {
      setPrefix(randomPrefix())
      setLabel('')
    }
    setResult(''); setError('')
  }, [activeSetupPub, replConfigs])

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

  function initSteps(): Step[] {
    return [
      { label: `Create publication "${pubName}" on source`, state: 'pending' },
      { label: `Verify all tables exist on destination`, state: 'pending' },
      { label: `Create subscription "${subName}" on destination`, state: 'pending' },
    ]
  }

  function setStep(i: number, patch: Partial<Step>) {
    setApplySteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  }

  async function applyReplication() {
    const steps = initSteps()
    setApplySteps(steps)
    setApplyDone(false)
    setLoading(true); setError(''); setResult('')

    const target = selectedSchemas.size > 0
      ? { schemas: Array.from(selectedSchemas).map(toSchema) }
      : { tables: Array.from(selectedTables).map(toSchemaTable) }

    // Step 1 — create publication
    setStep(0, { state: 'running' })
    try {
      await replicationApi.createPublication({ publication_name: pubName, target })
      setStep(0, { state: 'ok', detail: `FOR ${selectedSchemas.size > 0 ? 'TABLES IN SCHEMA' : 'TABLE'} ${selectedSchemas.size > 0 ? Array.from(selectedSchemas).map(toSchema).join(', ') : Array.from(selectedTables).map(toSchemaTable).slice(0, 3).join(', ') + (selectedTables.size > 3 ? ` +${selectedTables.size - 3} more` : '')}` })
    } catch (e: any) {
      const msg = extractError(e)
      setStep(0, { state: 'error', detail: msg })
      setApplyDone(true); setLoading(false)
      return
    }

    // Step 2 — verify tables (subscription create will also check, but show it explicitly)
    setStep(1, { state: 'running' })
    try {
      if (selectedTables.size > 0) {
        const { data: diffs } = await replicationApi.schemaCheck(Array.from(selectedTables).map(toSchemaTable))
        const missing = diffs.filter(d => !d.exists_on_dest)
        if (missing.length > 0) {
          setStep(1, { state: 'error', detail: `Missing on destination: ${missing.map(d => d.table).join(', ')}` })
          setApplyDone(true); setLoading(false)
          return
        }
      }
      setStep(1, { state: 'ok', detail: 'All tables present on destination' })
    } catch (e: any) {
      setStep(1, { state: 'error', detail: extractError(e) })
      setApplyDone(true); setLoading(false)
      return
    }

    // Step 3 — create subscription
    setStep(2, { state: 'running' })
    try {
      await replicationApi.createSubscription({
        subscription_name: subName,
        publication_name: pubName,
        source_dsn: sourceDsn,
        copy_data: copyData,
      })
      setStep(2, { state: 'ok', detail: copyData ? 'Initial data copy will begin shortly' : 'Replication active (no initial copy)' })
      setResult(`Publication "${pubName}" and subscription "${subName}" created successfully.`)
      onReplConfigChange?.({
        pub_name: pubName, sub_name: subName, copy_data: copyData,
        tables: tablesToCheck,
        schemas: Array.from(selectedSchemas).map(toSchema),
        database: replConfigs[pubName]?.database,
        last_applied: new Date().toISOString(), last_status: 'ok', last_error: undefined,
      })
    } catch (e: any) {
      const msg = extractError(e)
      setStep(2, { state: 'error', detail: msg })
      setError(msg)
      onReplConfigChange?.({
        pub_name: pubName, sub_name: subName, copy_data: copyData,
        tables: tablesToCheck,
        schemas: Array.from(selectedSchemas).map(toSchema),
        database: replConfigs[pubName]?.database,
        last_applied: new Date().toISOString(), last_status: 'error', last_error: msg,
      })
    } finally {
      setApplyDone(true); setLoading(false)
    }
  }

  async function dropPublication() {
    setLoading(true); setError('')
    try {
      await replicationApi.dropPublication(pubName)
      setResult(`Publication "${pubName}" dropped.`)
    } catch (e: any) {
      setError(extractError(e))
    } finally { setLoading(false); setConfirmAction(null) }
  }

  async function dropSubscription() {
    setLoading(true); setError('')
    try {
      await replicationApi.dropSubscription(subName)
      setResult(`Subscription "${subName}" dropped.`)
    } catch (e: any) {
      setError(extractError(e))
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

      {/* Saved publication configs — quick switch */}
      {Object.keys(replConfigs).length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Saved configs:</span>
          {Object.values(replConfigs).map(cfg => {
            const parsed = parsePubSubName(cfg.pub_name)
            const display = parsed
              ? <><span className="text-gray-600">{parsed.prefix}_</span>{parsed.label || 'pg_sync'}</>
              : cfg.pub_name
            return (
              <button
                key={cfg.pub_name}
                onClick={() => {
                  const p = parsePubSubName(cfg.pub_name)
                  setPrefix(p?.prefix ?? randomPrefix())
                  setLabel(p?.label ?? '')
                  setCopyData(cfg.copy_data)
                  setResult(''); setError('')
                }}
                className={clsx('text-xs px-2.5 py-1 rounded border font-mono transition-colors', {
                  'border-blue-500 text-blue-300 bg-blue-900/20': pubName === cfg.pub_name,
                  'border-gray-700 text-gray-400 hover:border-gray-500': pubName !== cfg.pub_name,
                })}
                title={cfg.pub_name}
              >
                {display}
                {cfg.last_status === 'ok' && <CheckCircle size={10} className="inline ml-1 text-green-400" />}
                {cfg.last_status === 'error' && <AlertTriangle size={10} className="inline ml-1 text-red-400" />}
              </button>
            )
          })}
        </div>
      )}

      {/* Last apply status for current pub */}
      {replConfigs[pubName]?.last_applied && (
        <div className={clsx('text-xs rounded px-3 py-2 flex items-center gap-2', {
          'bg-green-950/30 border border-green-800 text-green-400': replConfigs[pubName].last_status === 'ok',
          'bg-red-950/30 border border-red-800 text-red-400': replConfigs[pubName].last_status === 'error',
          'bg-yellow-950/30 border border-yellow-800 text-yellow-400': replConfigs[pubName].last_status === 'partial',
        })}>
          {replConfigs[pubName].last_status === 'ok' ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
          Last apply: <strong>{replConfigs[pubName].last_status}</strong>
          {' · '}{new Date(replConfigs[pubName].last_applied!).toLocaleString()}
          {replConfigs[pubName].last_error && (
            <span className="text-xs text-red-300 ml-1 truncate" title={replConfigs[pubName].last_error}>
              — {replConfigs[pubName].last_error!.slice(0, 120)}{replConfigs[pubName].last_error!.length > 120 ? '…' : ''}
            </span>
          )}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-gray-300">Configuration</h3>

        <div className="grid grid-cols-[120px_1fr] gap-3 items-end">
          {/* Prefix */}
          <div>
            <label className="block text-gray-400 mb-1 text-xs uppercase tracking-wider">
              Prefix
              <span className="normal-case text-gray-600 ml-1">(8 chars)</span>
            </label>
            <div className="flex gap-1">
              <input
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
                value={prefix}
                maxLength={8}
                onChange={e => setPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8))}
              />
              <button
                type="button"
                onClick={() => setPrefix(randomPrefix())}
                className="shrink-0 px-2 py-2 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-400 hover:text-gray-200"
                title="Generate new random prefix"
              >↻</button>
            </div>
          </div>

          {/* Label */}
          <div>
            <label className="block text-gray-400 mb-1 text-xs uppercase tracking-wider">
              Label
              <span className="normal-case text-gray-600 ml-1">(optional — identifies this replication)</span>
            </label>
            <input
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
              value={label}
              placeholder="e.g. sasstaging_all"
              onChange={e => setLabel(e.target.value)}
            />
          </div>
        </div>

        {/* Preview */}
        <div className="bg-gray-800/60 rounded px-3 py-2.5 space-y-1 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 w-24 shrink-0">Publication:</span>
            <span className="text-blue-300">{pubName}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500 w-24 shrink-0">Subscription:</span>
            <span className="text-green-300">{subName}</span>
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
          onClick={() => { setShowApplyModal(true) }}
          disabled={loading || !canApply}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-sm font-semibold flex items-center gap-2"
          title={!schemaOk && tablesToCheck.length > 0 ? 'Fix missing/incompatible tables on destination first' : undefined}
        >
          Apply Replication
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

      {showApplyModal && (
        <ApplyModal
          pubName={pubName}
          subName={subName}
          steps={applySteps}
          done={applyDone}
          onClose={() => { setShowApplyModal(false); setApplySteps([]); setApplyDone(false) }}
          onConfirm={applyReplication}
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
