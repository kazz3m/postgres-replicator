import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { analysisApi, SchemaInfo, DatabaseInfo } from '../api/client'
import { Spinner } from '../components/Spinner'
import { Badge } from '../components/Badge'
import {
  ChevronDown, ChevronRight, Database, HardDrive, Table,
  Search, ChevronsDownUp, ChevronsUpDown, PlusCircle, CheckCircle, AlertTriangle,
} from 'lucide-react'
import clsx from 'clsx'

interface Props {
  selectedTables: Set<string>      // "db.schema.table"
  selectedSchemas: Set<string>     // "db.schema"  (PG15+)
  pgMajor: number
  onSelectionChange: (tables: Set<string>, schemas: Set<string>) => void
}

// Three-part key helpers
function tableKey(db: string, schema: string, table: string) {
  return `${db}.${schema}.${table}`
}
function schemaKey(db: string, schema: string) {
  return `${db}.${schema}`
}

function SchemaCheckbox({
  checked, indeterminate, onChange,
}: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange}
      className="accent-blue-500 cursor-pointer" onClick={e => e.stopPropagation()} />
  )
}

// ── Per-database subtree (lazy loaded) ───────────────────────────────────────

interface DbNodeProps {
  db: DatabaseInfo
  pgMajor: number
  search: string
  selectedTables: Set<string>
  selectedSchemas: Set<string>
  onSelectionChange: (tables: Set<string>, schemas: Set<string>) => void
  initiallyExpanded: boolean
}

function DbNode({
  db, pgMajor, search, selectedTables, selectedSchemas, onSelectionChange, initiallyExpanded,
}: DbNodeProps) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [schemasExpanded, setSchemasExpanded] = useState<Set<string>>(new Set())
  const [ensuring, setEnsuring] = useState(false)
  const [ensureResult, setEnsureResult] = useState<{ status: string } | null>(null)

  const { data: schemas, isLoading, error } = useQuery({
    queryKey: ['db-schemas', db.database],
    queryFn: () => analysisApi.databaseSchemas(db.database).then(r => r.data),
    enabled: expanded,
    staleTime: 30_000,
  })

  // Map schema.table → publication names — loaded alongside schemas
  const { data: publishedMap = {} } = useQuery({
    queryKey: ['published-tables', db.database],
    queryFn: () => analysisApi.publishedTables(db.database).then(r => r.data),
    enabled: expanded,
    staleTime: 15_000,
  })

  const q = search.trim().toLowerCase()

  const filteredSchemas = schemas
    ? schemas.map(s => ({
        ...s,
        tables: q
          ? s.tables.filter(
              t => t.table_name.toLowerCase().includes(q) || s.schema_name.toLowerCase().includes(q),
            )
          : s.tables,
      })).filter(s => s.tables.length > 0)
    : []

  // Auto-expand schemas that match search
  useEffect(() => {
    if (q && filteredSchemas.length > 0) {
      setSchemasExpanded(new Set(filteredSchemas.map(s => s.schema_name)))
    }
  }, [q, schemas])

  // Count selected items in this db for the summary badge
  const dbSelectedTables = [...selectedTables].filter(k => k.startsWith(`${db.database}.`)).length
  const dbSelectedSchemas = [...selectedSchemas].filter(k => k.startsWith(`${db.database}.`)).length
  const hasSelection = dbSelectedTables > 0 || dbSelectedSchemas > 0

  async function handleEnsure(e: React.MouseEvent) {
    e.stopPropagation()
    setEnsuring(true); setEnsureResult(null)
    try {
      const { data } = await analysisApi.ensureDatabase(db.database)
      setEnsureResult(data)
      qc.invalidateQueries({ queryKey: ['cluster-databases'] })
    } finally {
      setEnsuring(false)
    }
  }

  function toggleSchemaExpand(name: string) {
    setSchemasExpanded(prev => {
      const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next
    })
  }

  function toggleSchemaSelect(schema: SchemaInfo) {
    const sKey = schemaKey(db.database, schema.schema_name)
    const newSchemas = new Set(selectedSchemas)
    const newTables = new Set(selectedTables)
    if (newSchemas.has(sKey)) {
      newSchemas.delete(sKey)
      schema.tables.forEach(t => newTables.delete(tableKey(db.database, schema.schema_name, t.table_name)))
    } else {
      newSchemas.add(sKey)
      schema.tables.forEach(t => newTables.delete(tableKey(db.database, schema.schema_name, t.table_name)))
    }
    onSelectionChange(newTables, newSchemas)
  }

  function toggleTableSelect(db_: string, schema: string, table: string) {
    const tKey = tableKey(db_, schema, table)
    const sKey = schemaKey(db_, schema)
    const newTables = new Set(selectedTables)
    const newSchemas = new Set(selectedSchemas)
    newSchemas.delete(sKey)
    newTables.has(tKey) ? newTables.delete(tKey) : newTables.add(tKey)
    onSelectionChange(newTables, newSchemas)
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      {/* Database header row */}
      <div
        className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-gray-800 select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-gray-500 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <HardDrive size={14} className="text-blue-400 shrink-0" />
        <span className="font-bold flex-1 truncate">{db.database}</span>
        <span className="text-gray-500 text-xs shrink-0">{db.size_pretty}</span>

        {/* Selection summary */}
        {hasSelection && (
          <span className="text-xs bg-blue-900/60 text-blue-300 rounded px-1.5 py-0.5 shrink-0">
            {dbSelectedSchemas > 0 && `${dbSelectedSchemas} schema${dbSelectedSchemas !== 1 ? 's' : ''}`}
            {dbSelectedSchemas > 0 && dbSelectedTables > 0 && ' + '}
            {dbSelectedTables > 0 && `${dbSelectedTables} table${dbSelectedTables !== 1 ? 's' : ''}`}
          </span>
        )}

        {/* Destination status + ensure button */}
        <div className="flex items-center gap-1.5 shrink-0 ml-2" onClick={e => e.stopPropagation()}>
          {db.exists_on_dest ? (
            <span className="flex items-center gap-1 text-xs text-green-500">
              <CheckCircle size={11} /> on dest
            </span>
          ) : (
            <>
              <span className="text-xs text-yellow-500 flex items-center gap-1">
                <AlertTriangle size={11} /> missing on dest
              </span>
              <button
                onClick={handleEnsure}
                disabled={ensuring}
                className="flex items-center gap-1 text-xs bg-yellow-800/60 hover:bg-yellow-700/60 border border-yellow-700 px-2 py-0.5 rounded disabled:opacity-50"
                title="CREATE DATABASE on destination"
              >
                {ensuring ? <Spinner size={2} /> : <PlusCircle size={10} />}
                Create
              </button>
            </>
          )}
          {ensureResult && (
            <span className={`text-xs ${ensureResult.status === 'created' ? 'text-green-400' : 'text-gray-400'}`}>
              {ensureResult.status === 'created' ? '✓ created' : '✓ exists'}
            </span>
          )}
        </div>
      </div>

      {/* Schema/table tree */}
      {expanded && (
        <div className="border-t border-gray-700">
          {isLoading && (
            <div className="px-6 py-3 flex items-center gap-2 text-xs text-gray-500">
              <Spinner size={3} /> Loading schemas...
            </div>
          )}
          {error && (
            <div className="px-6 py-3 text-xs text-red-400">
              Failed to load schemas for "{db.database}"
            </div>
          )}
          {!isLoading && !error && filteredSchemas.length === 0 && (
            <div className="px-6 py-3 text-xs text-gray-500">
              {q ? `No tables matching "${search}"` : 'No tables found.'}
            </div>
          )}
          {filteredSchemas.map(schema => {
            const sKey = schemaKey(db.database, schema.schema_name)
            const isSchemaChecked = selectedSchemas.has(sKey)
            const isSchemaExpanded = schemasExpanded.has(schema.schema_name)

            const selectedTableCount = schema.tables.filter(t =>
              selectedTables.has(tableKey(db.database, schema.schema_name, t.table_name))
            ).length
            const isIndeterminate = !isSchemaChecked && selectedTableCount > 0 && selectedTableCount < schema.tables.length
            const isAllTablesSelected = !isSchemaChecked && selectedTableCount === schema.tables.length && schema.tables.length > 0

            return (
              <div key={schema.schema_name} className="border-b border-gray-800 last:border-0">
                {/* Schema row */}
                <div
                  className="flex items-center gap-2 pl-8 pr-4 py-2.5 cursor-pointer hover:bg-gray-800 select-none"
                  onClick={() => toggleSchemaExpand(schema.schema_name)}
                >
                  <span className="text-gray-500 shrink-0">
                    {isSchemaExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </span>
                  <Database size={12} className="text-blue-400 shrink-0" />
                  <span className="font-semibold text-sm flex-1 truncate">{schema.schema_name}</span>
                  <span className="text-gray-500 text-xs shrink-0">
                    {schema.tables.length} tables · {schema.total_size_pretty}
                  </span>
                  {pgMajor >= 15 && (
                    <div
                      className="flex items-center gap-1.5 ml-3 pl-3 border-l border-gray-700 shrink-0"
                      onClick={e => e.stopPropagation()}
                    >
                      <SchemaCheckbox
                        checked={isSchemaChecked || isAllTablesSelected}
                        indeterminate={isIndeterminate}
                        onChange={() => toggleSchemaSelect(schema)}
                      />
                      <span className="text-xs text-gray-400">All schema</span>
                    </div>
                  )}
                </div>

                {/* Table list */}
                {isSchemaExpanded && (
                  <div className="bg-gray-950/40">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-600 border-b border-gray-800">
                          <th className="pl-16 pr-2 py-1.5 text-left w-8"></th>
                          <th className="px-2 py-1.5 text-left">Table</th>
                          <th className="px-2 py-1.5 text-right">Size</th>
                          <th className="px-2 py-1.5 text-right pr-4">Rows (est.)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {schema.tables.map(table => {
                          const tKey = tableKey(db.database, schema.schema_name, table.table_name)
                          const schemaTableKey = `${schema.schema_name}.${table.table_name}`
                          const isTableSchemaSelected = selectedSchemas.has(sKey)
                          const isSelected = selectedTables.has(tKey) || isTableSchemaSelected
                          const isHighlighted = q && table.table_name.toLowerCase().includes(q)

                          // Publications this table already belongs to
                          const inPublications: string[] = publishedMap[schemaTableKey] ?? []
                          const inPublication = inPublications.length > 0

                          return (
                            <tr
                              key={tKey}
                              className={clsx('border-b border-gray-800/50 hover:bg-gray-800 transition-colors', {
                                'bg-blue-950/30': isSelected,
                                'bg-yellow-950/20': isHighlighted && !isSelected,
                                'bg-amber-950/20': inPublication && !isSelected,
                              })}
                            >
                              <td className="pl-16 pr-2 py-1.5">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={isTableSchemaSelected}
                                  onChange={() => toggleTableSelect(db.database, schema.schema_name, table.table_name)}
                                  className="accent-blue-500 cursor-pointer disabled:opacity-40"
                                />
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Table size={11} className="text-gray-600 shrink-0" />
                                  <span className={clsx({ 'text-yellow-300': isHighlighted && !isSelected })}>
                                    {table.table_name}
                                  </span>
                                  {inPublications.map(pub => (
                                    <span
                                      key={pub}
                                      className="text-xs bg-amber-900/50 border border-amber-700/60 text-amber-300 rounded px-1.5 py-0.5 font-mono"
                                      title={`Already in publication: ${pub}`}
                                    >
                                      {pub}
                                    </span>
                                  ))}
                                  {table.replica_identity === 'nothing' && (
                                    <Badge label="NO REPLICATION" variant="red" />
                                  )}
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-right text-gray-500">{table.size_pretty}</td>
                              <td className="px-2 py-1.5 text-right text-gray-500 pr-4">
                                {table.row_estimate.toLocaleString()}
                              </td>
                            </tr>
                          )
                        })}
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

export function AnalysisPage({ selectedTables, selectedSchemas, pgMajor, onSelectionChange }: Props) {
  const [search, setSearch] = useState('')
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())

  const { data: databases, isLoading, error } = useQuery({
    queryKey: ['cluster-databases'],
    queryFn: () => analysisApi.databases().then(r => r.data),
  })

  // Auto-expand databases that have selected tables/schemas on mount
  useEffect(() => {
    if (!databases) return
    const toExpand = new Set<string>()
    for (const db of databases) {
      const hasSelection =
        [...selectedTables].some(k => k.startsWith(`${db.database}.`)) ||
        [...selectedSchemas].some(k => k.startsWith(`${db.database}.`))
      if (hasSelection) toExpand.add(db.database)
    }
    if (toExpand.size > 0) setExpandedDbs(prev => new Set([...prev, ...toExpand]))
  }, [databases])

  const totalSelectedTables = selectedTables.size
  const totalSelectedSchemas = selectedSchemas.size

  function selectAll() {
    // Not possible without loading all schemas; show a note
  }

  if (isLoading) return <div className="flex items-center gap-2 p-8"><Spinner /> Loading cluster databases...</div>
  if (error) return <div className="text-red-400 p-8">Failed to load databases from cluster.</div>

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Database Analysis</h2>
        <span className="text-gray-400 text-xs">
          {totalSelectedTables > 0 || totalSelectedSchemas > 0
            ? `${totalSelectedTables} table${totalSelectedTables !== 1 ? 's' : ''} + ${totalSelectedSchemas} schema${totalSelectedSchemas !== 1 ? 's' : ''} selected`
            : 'Nothing selected'}
        </span>
      </div>

      {/* Banners */}
      {pgMajor >= 15 && (
        <div className="text-xs text-blue-400 bg-blue-950 border border-blue-800 rounded px-3 py-2">
          PostgreSQL {pgMajor} detected — schema-level publications available.
          Selecting a schema replicates all current and future tables in it.
        </div>
      )}
      {pgMajor > 0 && pgMajor < 15 && (
        <div className="text-xs text-yellow-400 bg-yellow-950 border border-yellow-800 rounded px-3 py-2">
          PostgreSQL {pgMajor}: schema-level publications require PG 15+. Select individual tables.
        </div>
      )}
      <div className="text-xs text-orange-400 bg-orange-950 border border-orange-800 rounded px-3 py-2">
        ⚠️ Sequences (serial/identity columns) are NOT replicated. After failover, sync sequences manually.
      </div>
      <div className="text-xs text-blue-400 bg-blue-950 border border-blue-800 rounded px-3 py-2">
        ℹ️ Databases missing on destination can be created with the "Create" button per database row.
        Logical replication requires matching database names on source and destination.
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tables..."
            className="w-full bg-gray-800 border border-gray-600 rounded pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-blue-500"
          />
        </div>
        <button
          onClick={() => setExpandedDbs(new Set(databases?.map(d => d.database) ?? []))}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded"
        >
          <ChevronsDownUp size={12} /> Expand all
        </button>
        <button
          onClick={() => setExpandedDbs(new Set())}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded"
        >
          <ChevronsUpDown size={12} /> Collapse all
        </button>
        {(totalSelectedTables > 0 || totalSelectedSchemas > 0) && (
          <button
            onClick={() => onSelectionChange(new Set(), new Set())}
            className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded"
          >
            Deselect all
          </button>
        )}
      </div>

      {/* Database tree */}
      <div className="space-y-2">
        {databases?.length === 0 && (
          <div className="text-gray-500 text-sm py-4 text-center">No user databases found on cluster.</div>
        )}
        {databases?.map(db => (
          <DbNode
            key={db.database}
            db={db}
            pgMajor={pgMajor}
            search={search}
            selectedTables={selectedTables}
            selectedSchemas={selectedSchemas}
            onSelectionChange={onSelectionChange}
            initiallyExpanded={expandedDbs.has(db.database)}
          />
        ))}
      </div>
    </div>
  )
}
