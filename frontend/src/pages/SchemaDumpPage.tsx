import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { schemaDumpApi, analysisApi, SchemaDumpConfig } from '../api/client'
import { Spinner } from '../components/Spinner'
import { AlertTriangle, CheckCircle, Database, Download, Play, Settings, ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'

export function SchemaDumpPage() {
  const [pgDumpPath, setPgDumpPath] = useState('')
  const [savingConfig, setSavingConfig] = useState(false)
  const [configMsg, setConfigMsg] = useState('')

  const [selectedDb, setSelectedDb] = useState('')
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set())
  const [dumping, setDumping] = useState(false)
  const [applying, setApplying] = useState(false)
  const [stopOnError, setStopOnError] = useState(false)
  const [statements, setStatements] = useState<string[] | null>(null)
  const [dumpStrategy, setDumpStrategy] = useState('')
  const [applyResults, setApplyResults] = useState<{ applied: number; failed: number; results: { sql: string; ok: boolean; error?: string }[] } | null>(null)
  const [error, setError] = useState('')
  const [expandedStmt, setExpandedStmt] = useState<Set<number>>(new Set())
  const [selectedStmts, setSelectedStmts] = useState<Set<number>>(new Set())

  const { data: cfg, refetch: refetchCfg } = useQuery({
    queryKey: ['schema-dump-config'],
    queryFn: () => schemaDumpApi.getConfig().then(r => r.data),
  })

  const { data: databases } = useQuery({
    queryKey: ['databases'],
    queryFn: () => analysisApi.databases().then(r => r.data),
  })

  const { data: schemas } = useQuery({
    queryKey: ['schema-list', selectedDb],
    queryFn: () => analysisApi.databaseSchemaList(selectedDb).then(r => r.data),
    enabled: !!selectedDb,
  })

  useEffect(() => {
    if (cfg) setPgDumpPath(cfg.pg_dump_path)
  }, [cfg])

  // auto-select all schemas when db changes
  useEffect(() => {
    if (schemas) setSelectedSchemas(new Set(schemas.map(s => s.schema_name)))
  }, [schemas])

  async function saveConfig() {
    setSavingConfig(true); setConfigMsg('')
    try {
      await schemaDumpApi.setConfig(pgDumpPath)
      setConfigMsg('Saved.')
      refetchCfg()
    } catch (e: any) {
      setConfigMsg(e.response?.data?.detail || e.message)
    } finally {
      setSavingConfig(false)
    }
  }

  async function runDump() {
    if (!selectedDb) return
    setDumping(true); setError(''); setStatements(null); setApplyResults(null); setSelectedStmts(new Set())
    try {
      const { data } = await schemaDumpApi.dump(selectedDb, [...selectedSchemas])
      setStatements(data.statements)
      setDumpStrategy(data.strategy)
      setSelectedStmts(new Set(data.statements.map((_, i) => i)))
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setDumping(false)
    }
  }

  async function runApply() {
    if (!statements || !selectedDb) return
    const toApply = statements.filter((_, i) => selectedStmts.has(i))
    if (!toApply.length) return
    setApplying(true); setError(''); setApplyResults(null)
    try {
      const { data } = await schemaDumpApi.apply(selectedDb, toApply, stopOnError)
      setApplyResults(data)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setApplying(false)
    }
  }

  function toggleSchema(s: string) {
    setSelectedSchemas(prev => {
      const n = new Set(prev)
      n.has(s) ? n.delete(s) : n.add(s)
      return n
    })
  }

  function toggleStmt(i: number) {
    setSelectedStmts(prev => {
      const n = new Set(prev)
      n.has(i) ? n.delete(i) : n.add(i)
      return n
    })
  }

  const strategy = cfg?.strategy ?? 'generator'

  return (
    <div className="space-y-4">
      {/* pg_dump config */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Settings size={14} className="text-gray-400" />
          <span className="font-semibold text-gray-300 text-sm">pg_dump configuration</span>
          <span className={clsx('ml-auto text-xs px-2 py-0.5 rounded border',
            strategy === 'pg_dump'
              ? 'bg-green-950 border-green-800 text-green-300'
              : 'bg-gray-800 border-gray-700 text-gray-400'
          )}>
            {strategy === 'pg_dump' ? '✓ using pg_dump' : 'using built-in generator'}
          </span>
        </div>
        {strategy === 'generator' && (
          <div className="mb-3 flex items-start gap-2 bg-yellow-950/40 border border-yellow-800/60 rounded p-2.5 text-xs text-yellow-300">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            No pg_dump binary configured — using built-in DDL generator. Generator covers common objects
            (tables, sequences, indexes, views, functions, types) but pg_dump is more complete and battle-tested.
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={pgDumpPath}
            onChange={e => setPgDumpPath(e.target.value)}
            placeholder="/usr/bin/pg_dump  (leave empty to use built-in generator)"
            className="flex-1 bg-gray-800 border border-gray-600 focus:border-blue-500 rounded px-3 py-1.5 text-sm font-mono text-white outline-none"
          />
          <button onClick={saveConfig} disabled={savingConfig}
            className="flex items-center gap-1.5 text-xs bg-blue-800 hover:bg-blue-700 px-3 py-1.5 rounded disabled:opacity-50">
            {savingConfig ? <Spinner size={2} /> : null} Save
          </button>
        </div>
        {configMsg && (
          <p className={clsx('mt-1.5 text-xs', configMsg === 'Saved.' ? 'text-green-400' : 'text-red-400')}>
            {configMsg}
          </p>
        )}
      </div>

      {/* Source selection */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Database size={14} className="text-gray-400" />
          <span className="font-semibold text-gray-300 text-sm">Source database & schemas</span>
        </div>
        <div className="flex flex-wrap gap-3 items-start">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Database</label>
            <select
              value={selectedDb}
              onChange={e => { setSelectedDb(e.target.value); setStatements(null); setApplyResults(null) }}
              className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-white outline-none focus:border-blue-500"
            >
              <option value="">— select —</option>
              {databases?.map(db => (
                <option key={db.database} value={db.database}>{db.database}</option>
              ))}
            </select>
          </div>

          {schemas && schemas.length > 0 && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Schemas
                <button onClick={() => setSelectedSchemas(new Set(schemas.map(s => s.schema_name)))}
                  className="ml-2 text-blue-400 hover:text-blue-300">all</button>
                <button onClick={() => setSelectedSchemas(new Set())}
                  className="ml-1 text-gray-500 hover:text-gray-300">none</button>
              </label>
              <div className="flex flex-wrap gap-1.5 max-w-xl">
                {schemas.map(s => (
                  <button key={s.schema_name}
                    onClick={() => toggleSchema(s.schema_name)}
                    className={clsx('text-xs px-2 py-0.5 rounded border transition-colors',
                      selectedSchemas.has(s.schema_name)
                        ? 'bg-blue-900/40 border-blue-700 text-blue-300'
                        : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-500'
                    )}>
                    {s.schema_name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-3">
          <button
            onClick={runDump}
            disabled={!selectedDb || selectedSchemas.size === 0 || dumping}
            className="flex items-center gap-1.5 text-sm bg-blue-800 hover:bg-blue-700 px-4 py-2 rounded disabled:opacity-50 font-semibold"
          >
            {dumping ? <Spinner size={3} /> : <Download size={13} />}
            Generate schema DDL
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-950/40 border border-red-800 rounded p-3 text-xs text-red-300">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {/* Statements preview */}
      {statements && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-3">
            <span className="font-semibold text-gray-300 text-sm">
              {statements.length} statements
              <span className="ml-2 text-xs text-gray-500 font-normal">via {dumpStrategy}</span>
            </span>
            <span className="text-xs text-gray-500">{selectedStmts.size} selected</span>
            <button onClick={() => setSelectedStmts(new Set(statements.map((_, i) => i)))}
              className="text-xs text-blue-400 hover:text-blue-300">select all</button>
            <button onClick={() => setSelectedStmts(new Set())}
              className="text-xs text-gray-500 hover:text-gray-300">deselect all</button>
            <div className="ml-auto flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                <input type="checkbox" checked={stopOnError}
                  onChange={e => setStopOnError(e.target.checked)}
                  className="accent-blue-500" />
                Stop on error
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">
                  dest: <span className="text-blue-300 font-mono">{selectedDb}</span>
                </span>
                <button
                  onClick={runApply}
                  disabled={applying || selectedStmts.size === 0}
                  className="flex items-center gap-1.5 text-sm bg-green-800 hover:bg-green-700 px-4 py-1.5 rounded disabled:opacity-50 font-semibold"
                >
                  {applying ? <Spinner size={3} /> : <Play size={13} />}
                  Apply {selectedStmts.size} on destination
                </button>
              </div>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-gray-800">
            {statements.map((stmt, i) => {
              const isExp = expandedStmt.has(i)
              const isSel = selectedStmts.has(i)
              const applyRes = applyResults?.results[applyResults.results.findIndex((_, j) => {
                // match by position in selected list
                const selArr = [...selectedStmts].sort((a, b) => a - b)
                return selArr[j] === i
              })]
              return (
                <div key={i} className={clsx('text-xs', isSel ? '' : 'opacity-40')}>
                  <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800/50">
                    <input type="checkbox" checked={isSel} onChange={() => toggleStmt(i)}
                      className="accent-blue-500 shrink-0" />
                    <button onClick={() => {
                      setExpandedStmt(prev => {
                        const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n
                      })
                    }} className="shrink-0 text-gray-600 hover:text-gray-400">
                      {isExp ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </button>
                    <span className="font-mono text-gray-400 flex-1 truncate">
                      {stmt.split('\n')[0].slice(0, 100)}
                    </span>
                    {applyRes && (
                      applyRes.ok
                        ? <CheckCircle size={11} className="text-green-400 shrink-0" />
                        : <span className="text-red-400 shrink-0" title={applyRes.error}>✗</span>
                    )}
                  </div>
                  {isExp && (
                    <pre className="px-8 pb-2 font-mono text-gray-300 whitespace-pre-wrap text-[11px] bg-gray-950/40">
                      {stmt}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Apply results summary */}
      {applyResults && (
        <div className={clsx('border rounded-lg p-4 text-sm',
          applyResults.failed === 0
            ? 'bg-green-950/20 border-green-800'
            : 'bg-yellow-950/20 border-yellow-800'
        )}>
          <div className="flex items-center gap-2 mb-2">
            {applyResults.failed === 0
              ? <CheckCircle size={14} className="text-green-400" />
              : <AlertTriangle size={14} className="text-yellow-400" />}
            <span className="font-semibold text-gray-300">
              Applied {applyResults.applied} · Failed {applyResults.failed}
            </span>
          </div>
          {applyResults.failed > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {applyResults.results.filter(r => !r.ok).map((r, i) => (
                <div key={i} className="text-xs text-red-300">
                  <span className="font-mono text-gray-500">{r.sql}…</span>
                  <span className="ml-2 text-red-400">{r.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
