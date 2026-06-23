import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { rolesApi, RoleStatement, StatementResult } from '../api/client'
import { Spinner } from './Spinner'
import {
  ChevronDown, ChevronRight, RefreshCw, Play, CheckCircle,
  XCircle, AlertTriangle, Copy, Eye, EyeOff,
} from 'lucide-react'
import clsx from 'clsx'

const KIND_LABEL: Record<string, string> = {
  create_role:              'CREATE ROLE',
  alter_role:               'ALTER ROLE',
  alter_role_set:           'ALTER ROLE SET',
  grant_membership:         'GRANT (membership)',
  grant_schema:             'GRANT (schema)',
  grant_table:              'GRANT (table)',
  grant_default:            'DEFAULT PRIVILEGES',
  grant_role_for_default:   'SET ROLE',
  revoke_role_after_default:'RESET ROLE',
  alter_owner:              'ALTER OWNER',
  create_extension:         'EXTENSION',
  comment:                  'skipped',
}

const KIND_COLOR: Record<string, string> = {
  create_role:              'text-green-400',
  alter_role:               'text-blue-400',
  alter_role_set:           'text-blue-300',
  grant_membership:         'text-purple-400',
  grant_schema:             'text-cyan-400',
  grant_table:              'text-cyan-300',
  grant_default:            'text-amber-400',
  grant_role_for_default:   'text-gray-500',
  revoke_role_after_default:'text-gray-500',
  alter_owner:              'text-orange-400',
  create_extension:         'text-teal-400',
  comment:                  'text-gray-500',
}

function StatementRow({ stmt, selected, onToggle }: {
  stmt: RoleStatement
  selected: boolean
  onToggle: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isComment = stmt.kind === 'comment'

  return (
    <div className={clsx('border-b border-gray-800 last:border-0', {
      'opacity-50': isComment,
      'bg-blue-950/20': selected && !isComment,
    })}>
      <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800/40">
        <input
          type="checkbox"
          checked={selected && !isComment}
          disabled={isComment}
          onChange={onToggle}
          className="accent-blue-500 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
        />
        <button
          className="shrink-0 text-gray-600 hover:text-gray-400"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        <span className={clsx('text-xs font-mono shrink-0 w-36', KIND_COLOR[stmt.kind] ?? 'text-gray-400')}>
          {KIND_LABEL[stmt.kind] ?? stmt.kind}
        </span>
        <span className="text-xs text-gray-300 font-mono flex-1 truncate">
          {stmt.sql.replace(/\n/g, ' ')}
        </span>
        {stmt.exists_on_dest && (
          <span className="text-xs text-gray-500 shrink-0">exists</span>
        )}
        {stmt.warning && (
          <span title={stmt.warning}>
            <AlertTriangle size={12} className="text-amber-400 shrink-0" />
          </span>
        )}
      </div>
      {expanded && (
        <div className="px-10 pb-2">
          <pre className="text-xs bg-gray-950 border border-gray-800 rounded p-2 whitespace-pre-wrap text-gray-300 font-mono">
            {stmt.sql}
          </pre>
          {stmt.warning && (
            <p className="text-xs text-amber-400 mt-1 flex items-center gap-1">
              <AlertTriangle size={11} /> {stmt.warning}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ResultRow({ r }: { r: StatementResult }) {
  const [expanded, setExpanded] = useState(!r.ok)
  return (
    <div className={clsx('border-b border-gray-800 last:border-0 text-xs', {
      'bg-green-950/20': r.ok,
      'bg-red-950/30': !r.ok,
    })}>
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        {r.ok
          ? <CheckCircle size={12} className="text-green-400 shrink-0" />
          : <XCircle size={12} className="text-red-400 shrink-0" />}
        <span className="font-mono text-gray-300 flex-1 truncate">{r.sql.replace(/\n/g, ' ')}</span>
        {r.error && <ChevronDown size={11} className="text-gray-500 shrink-0" />}
      </div>
      {expanded && r.error && (
        <div className="px-8 pb-2 text-red-300 font-mono text-xs bg-red-950/20 py-1 px-4">
          {r.error}
        </div>
      )}
    </div>
  )
}

export function RolesSyncPanel() {
  const [includeDatabases, setIncludeDatabases] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [applying, setApplying] = useState(false)
  const [applyResults, setApplyResults] = useState<StatementResult[] | null>(null)
  const [stopOnError, setStopOnError] = useState(false)
  const [showSkipped, setShowSkipped] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [filterKind, setFilterKind] = useState<string>('all')

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['roles-diff', includeDatabases],
    queryFn: () => rolesApi.diff(includeDatabases).then(r => r.data),
    enabled: expanded,
    staleTime: 60_000,
  })

  const statements = data?.statements ?? []
  const filtered = filterKind === 'all'
    ? statements
    : statements.filter(s => s.kind === filterKind)

  // Auto-select all non-comment on first load
  const prevLen = filtered.length
  if (data && selected.size === 0 && filtered.length > 0) {
    const autoSel = new Set<number>()
    filtered.forEach((s, i) => { if (s.kind !== 'comment') autoSel.add(i) })
    if (autoSel.size > 0) setSelected(autoSel)
  }

  function toggleAll() {
    if (selected.size === filtered.filter(s => s.kind !== 'comment').length) {
      setSelected(new Set())
    } else {
      const all = new Set<number>()
      filtered.forEach((s, i) => { if (s.kind !== 'comment') all.add(i) })
      setSelected(all)
    }
  }

  async function handleApply() {
    const stmts = filtered
      .filter((_, i) => selected.has(i))
      .map(s => ({ sql: s.sql, database: s.database, steps: s.steps }))
    if (stmts.length === 0) return
    setApplying(true)
    setApplyResults(null)
    try {
      const { data: res } = await rolesApi.apply(stmts, stopOnError)
      setApplyResults(res.results)
    } catch (e: any) {
      const msg = e.response?.data?.detail || e.message || 'Apply failed'
      setApplyResults([{ sql: '(request failed)', ok: false, error: msg }])
    } finally {
      setApplying(false)
    }
  }

  function copyAll() {
    const sqls = filtered.filter((_, i) => selected.has(i)).map(s => s.sql).join('\n')
    navigator.clipboard.writeText(sqls)
  }

  const kindCounts = statements.reduce<Record<string, number>>((acc, s) => {
    acc[s.kind] = (acc[s.kind] ?? 0) + 1
    return acc
  }, {})

  const selectableCount = filtered.filter(s => s.kind !== 'comment').length
  const allSelected = selected.size > 0 && selected.size === selectableCount

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-4 py-3 bg-gray-900 hover:bg-gray-800 select-none text-left"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-semibold text-sm flex-1">Roles & Grants Migration</span>
        {data && (
          <span className="text-xs text-gray-500">
            {statements.filter(s => s.kind !== 'comment').length} statements
            {!data.password_available && (
              <span className="ml-2 text-amber-400 flex items-center gap-1 inline-flex">
                <AlertTriangle size={11} /> passwords unavailable
              </span>
            )}
          </span>
        )}
        <span className="text-xs text-gray-600">pg_dumpall compatible</span>
      </button>

      {expanded && (
        <div className="bg-gray-900/50">
          {/* Options bar */}
          <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-700 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer text-gray-400">
              <input
                type="checkbox"
                checked={includeDatabases}
                onChange={e => setIncludeDatabases(e.target.checked)}
                className="accent-blue-500"
              />
              Include per-database grants
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-gray-400">
              <input
                type="checkbox"
                checked={stopOnError}
                onChange={e => setStopOnError(e.target.checked)}
                className="accent-blue-500"
              />
              Stop on first error
            </label>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-1 text-gray-400 hover:text-gray-200 ml-auto disabled:opacity-50"
            >
              <RefreshCw size={11} className={clsx({ 'animate-spin': isFetching })} />
              Refresh
            </button>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400">
              <Spinner size={4} /> Analysing roles and grants...
            </div>
          )}

          {error && (
            <div className="px-4 py-3 text-sm text-red-400">
              Failed to load roles diff. Check backend logs.
            </div>
          )}

          {data && !isLoading && (
            <>
              {data.dest_is_cloudsql && (
                <div className="mx-4 mt-3 text-xs text-blue-400 bg-blue-950/30 border border-blue-800 rounded px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>
                    Destination is <strong>Cloud SQL</strong> — <code>SUPERUSER</code> / <code>NOSUPERUSER</code> options
                    are automatically stripped from all statements (not supported by Cloud SQL).
                  </span>
                </div>
              )}
              {!data.password_available && (
                <div className="mx-4 mt-3 text-xs text-amber-400 bg-amber-950/30 border border-amber-800 rounded px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>
                    Password hashes are not readable (Cloud SQL / RDS restriction).
                    Password statements are commented out — set passwords manually on destination after applying.
                  </span>
                </div>
              )}

              {/* Filter + toolbar */}
              <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-800 flex-wrap">
                <select
                  value={filterKind}
                  onChange={e => { setFilterKind(e.target.value); setSelected(new Set()) }}
                  className="text-xs bg-gray-800 border border-gray-600 rounded px-2 py-1 text-gray-300"
                >
                  <option value="all">All ({statements.filter(s => s.kind !== 'comment').length})</option>
                  {Object.entries(kindCounts).map(([k, n]) => (
                    <option key={k} value={k}>{KIND_LABEL[k] ?? k} ({n})</option>
                  ))}
                </select>

                <button onClick={toggleAll} className="text-xs text-blue-400 hover:text-blue-300">
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>

                <span className="text-xs text-gray-500 ml-auto">
                  {selected.size} / {selectableCount} selected
                </span>

                <button
                  onClick={copyAll}
                  disabled={selected.size === 0}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-40"
                  title="Copy selected SQL to clipboard"
                >
                  <Copy size={11} /> Copy SQL
                </button>

                <button
                  onClick={handleApply}
                  disabled={applying || selected.size === 0}
                  className="flex items-center gap-1.5 text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white px-3 py-1 rounded"
                >
                  {applying ? <Spinner size={3} /> : <Play size={11} />}
                  Apply {selected.size} statement{selected.size !== 1 ? 's' : ''}
                </button>
              </div>

              {/* Statement list */}
              <div className="border-t border-gray-800 max-h-96 overflow-y-auto">
                {filtered.length === 0 && (
                  <div className="px-4 py-4 text-xs text-gray-500 text-center">
                    No statements to show.
                  </div>
                )}
                {filtered.map((stmt, i) => (
                  <StatementRow
                    key={i}
                    stmt={stmt}
                    selected={selected.has(i)}
                    onToggle={() => {
                      setSelected(prev => {
                        const next = new Set(prev)
                        next.has(i) ? next.delete(i) : next.add(i)
                        return next
                      })
                    }}
                  />
                ))}
              </div>

              {/* Skipped system roles */}
              {data.skipped_system_roles.length > 0 && (
                <div className="px-4 py-2 border-t border-gray-800">
                  <button
                    onClick={() => setShowSkipped(s => !s)}
                    className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
                  >
                    {showSkipped ? <EyeOff size={11} /> : <Eye size={11} />}
                    {data.skipped_system_roles.length} system roles skipped
                  </button>
                  {showSkipped && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {data.skipped_system_roles.map(r => (
                        <span key={r} className="text-xs font-mono text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">{r}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Apply results */}
          {applyResults && (
            <div className="border-t border-gray-700">
              <div className="px-4 py-2 text-xs flex items-center gap-3">
                <span className="text-green-400">
                  <CheckCircle size={12} className="inline mr-1" />
                  {applyResults.filter(r => r.ok).length} applied
                </span>
                {applyResults.filter(r => !r.ok).length > 0 && (
                  <span className="text-red-400">
                    <XCircle size={12} className="inline mr-1" />
                    {applyResults.filter(r => !r.ok).length} failed
                  </span>
                )}
              </div>
              <div className="max-h-64 overflow-y-auto">
                {applyResults.map((r, i) => <ResultRow key={i} r={r} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
