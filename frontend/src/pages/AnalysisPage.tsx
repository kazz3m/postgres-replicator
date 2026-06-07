import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { analysisApi, replicationApi, DatabaseInfo, SchemaListItem, TableInfo, PublicationServerConfig } from '../api/client'
import { Spinner } from '../components/Spinner'
import { Badge } from '../components/Badge'
import {
  ChevronDown, ChevronRight, Database, HardDrive, Table,
  Search, ChevronsUpDown, PlusCircle, CheckCircle, AlertTriangle, Play,
} from 'lucide-react'
import clsx from 'clsx'

interface Props {
  selectedTables: Set<string>      // "db.schema.table"
  selectedSchemas: Set<string>     // "db.schema"  (PG15+)
  pgMajor: number
  onSelectionChange: (tables: Set<string>, schemas: Set<string>) => void
  onOpenPublication?: (config: PublicationServerConfig) => void
  onCreateReplication?: (db: string, schema: string) => void
}

function tableKey(db: string, schema: string, table: string) { return `${db}.${schema}.${table}` }
function schemaKey(db: string, schema: string) { return `${db}.${schema}` }

function SchemaCheckbox({ checked, indeterminate, onChange }: {
  checked: boolean; indeterminate: boolean; onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange}
      className="accent-blue-500 cursor-pointer" onClick={e => e.stopPropagation()} />
  )
}

// ── Publications panel — collapsible list of found publications in a DB ──────

interface PublicationsPanelProps {
  dbName: string
  publishedMap: Record<string, string[]>  // "schema.table" → [pub_names]
  onOpenPublication?: (config: PublicationServerConfig) => void
}

function PublicationsPanel({ dbName, publishedMap, onOpenPublication }: PublicationsPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [loadingPub, setLoadingPub] = useState<string | null>(null)
  const [expandedPubs, setExpandedPubs] = useState<Set<string>>(new Set())

  // Build a map: pub_name → table list
  const pubTables = Object.entries(publishedMap).reduce<Record<string, string[]>>((acc, [table, pubs]) => {
    pubs.forEach(pub => {
      if (!acc[pub]) acc[pub] = []
      acc[pub].push(table)
    })
    return acc
  }, {})

  const pubNames = Object.keys(pubTables).sort()
  if (pubNames.length === 0) return null

  async function handleOpen(pub: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!onOpenPublication) return
    setLoadingPub(pub)
    try {
      const { data } = await replicationApi.publicationConfig(pub)
      onOpenPublication(data)
    } catch {
      // ignore
    } finally {
      setLoadingPub(null)
    }
  }

  function togglePub(pub: string) {
    setExpandedPubs(prev => {
      const next = new Set(prev)
      next.has(pub) ? next.delete(pub) : next.add(pub)
      return next
    })
  }

  return (
    <div className="border-t border-gray-700 bg-gray-950/60">
      <button
        className="w-full flex items-center gap-2 px-4 py-2 text-xs text-amber-400 hover:bg-gray-800/60 select-none"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="font-semibold">{pubNames.length} publication{pubNames.length !== 1 ? 's' : ''} found on source</span>
        <span className="ml-1 text-gray-500">— click to manage</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-1.5">
          {pubNames.map(pub => {
            const tables = pubTables[pub]
            const isExpPub = expandedPubs.has(pub)
            return (
              <div key={pub} className="border border-amber-800/50 rounded bg-amber-950/20">
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-amber-900/20 select-none"
                  onClick={() => togglePub(pub)}
                >
                  {isExpPub ? <ChevronDown size={11} className="text-amber-500 shrink-0" /> : <ChevronRight size={11} className="text-amber-500 shrink-0" />}
                  <span className="font-mono text-xs text-amber-300 flex-1 truncate">{pub}</span>
                  <span className="text-xs text-gray-500 shrink-0">{tables.length} table{tables.length !== 1 ? 's' : ''}</span>
                  <button
                    onClick={e => handleOpen(pub, e)}
                    disabled={loadingPub === pub}
                    className="flex items-center gap-1 text-xs bg-blue-800/60 hover:bg-blue-700/60 border border-blue-700 text-blue-300 px-2 py-0.5 rounded disabled:opacity-50 shrink-0"
                    title="Open this publication in Setup tab"
                  >
                    {loadingPub === pub ? <Spinner size={2} /> : <Play size={10} />}
                    Manage
                  </button>
                </div>
                {isExpPub && (
                  <div className="px-3 pb-2">
                    <div className="flex flex-wrap gap-1">
                      {tables.map(t => (
                        <span key={t} className="font-mono text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded px-1.5 py-0.5">
                          {t}
                        </span>
                      ))}
                    </div>
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

// ── Schema node — lazy loads its own tables ───────────────────────────────────

interface SchemaNodeProps {
  dbName: string
  schema: SchemaListItem
  pgMajor: number
  search: string
  selectedTables: Set<string>
  selectedSchemas: Set<string>
  publishedMap: Record<string, string[]>
  onSelectionChange: (tables: Set<string>, schemas: Set<string>) => void
  onOpenPublication?: (config: PublicationServerConfig) => void
  onCreateReplication?: (db: string, schema: string) => void
  initiallyExpanded: boolean
}

function SchemaNode({
  dbName, schema, pgMajor, search, selectedTables, selectedSchemas,
  publishedMap, onSelectionChange, onOpenPublication, onCreateReplication, initiallyExpanded,
}: SchemaNodeProps) {
  const [loadingPub, setLoadingPub] = useState<string | null>(null)
  const [selectAllOnLoad, setSelectAllOnLoad] = useState(false)

  async function handlePubClick(pub: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!onOpenPublication) return
    setLoadingPub(pub)
    try {
      const { data } = await replicationApi.publicationConfig(pub)
      onOpenPublication(data)
    } catch {
      // ignore — badge stays static if fetch fails
    } finally {
      setLoadingPub(null)
    }
  }
  const [expanded, setExpanded] = useState(initiallyExpanded)

  const { data: tables, isLoading: tablesLoading } = useQuery({
    queryKey: ['schema-tables', dbName, schema.schema_name],
    queryFn: () => analysisApi.schemaTables(dbName, schema.schema_name).then(r => r.data),
    enabled: expanded,
    staleTime: 30_000,
  })

  const sKey = schemaKey(dbName, schema.schema_name)
  const isSchemaChecked = selectedSchemas.has(sKey)

  const q = search.trim().toLowerCase()
  const filteredTables = (tables ?? []).filter(t =>
    !q || t.table_name.toLowerCase().includes(q) || schema.schema_name.toLowerCase().includes(q)
  )

  // Auto-expand when search matches
  useEffect(() => {
    if (q && schema.schema_name.toLowerCase().includes(q)) setExpanded(true)
  }, [q])

  // When tables finish loading after "Create replication" click, select all free tables
  useEffect(() => {
    if (selectAllOnLoad && tables && tables.length > 0) {
      setSelectAllOnLoad(false)
      const free = tables.filter(t => (publishedMap[`${schema.schema_name}.${t.table_name}`] ?? []).length === 0)
      const newTables = new Set(selectedTables)
      const newSchemas = new Set(selectedSchemas)
      newSchemas.delete(sKey)
      free.forEach(t => newTables.add(tableKey(dbName, schema.schema_name, t.table_name)))
      onSelectionChange(newTables, newSchemas)
    }
  }, [tables, selectAllOnLoad])

  // Tables already in a publication — cannot be added to another replication
  function isInPublication(tableName: string): boolean {
    return (publishedMap[`${schema.schema_name}.${tableName}`] ?? []).length > 0
  }

  const freeTables = (tables ?? []).filter(t => !isInPublication(t.table_name))

  const selectedTableCount = (tables ?? []).filter(t =>
    selectedTables.has(tableKey(dbName, schema.schema_name, t.table_name))
  ).length
  const isIndeterminate = !isSchemaChecked && selectedTableCount > 0 && selectedTableCount < freeTables.length
  const isAllTablesSelected = !isSchemaChecked && freeTables.length > 0 && selectedTableCount === freeTables.length

  function toggleSchemaSelect() {
    const newSchemas = new Set(selectedSchemas)
    const newTables = new Set(selectedTables)
    if (newSchemas.has(sKey)) {
      newSchemas.delete(sKey)
      ;(tables ?? []).forEach(t => newTables.delete(tableKey(dbName, schema.schema_name, t.table_name)))
    } else {
      newSchemas.add(sKey)
      // Only add free tables — published ones stay blocked
      freeTables.forEach(t => newTables.delete(tableKey(dbName, schema.schema_name, t.table_name)))
    }
    onSelectionChange(newTables, newSchemas)
  }

  function selectAll() {
    const newTables = new Set(selectedTables)
    const newSchemas = new Set(selectedSchemas)
    newSchemas.delete(sKey)
    // Only select tables not already in a publication
    freeTables.forEach(t => newTables.add(tableKey(dbName, schema.schema_name, t.table_name)))
    onSelectionChange(newTables, newSchemas)
  }

  function deselectAll() {
    const newTables = new Set(selectedTables)
    const newSchemas = new Set(selectedSchemas)
    newSchemas.delete(sKey)
    ;(tables ?? []).forEach(t => newTables.delete(tableKey(dbName, schema.schema_name, t.table_name)))
    onSelectionChange(newTables, newSchemas)
  }

  function toggleTable(tableName: string) {
    if (isInPublication(tableName)) return  // guard — blocked at UI level too
    const tKey = tableKey(dbName, schema.schema_name, tableName)
    const newTables = new Set(selectedTables)
    const newSchemas = new Set(selectedSchemas)
    newSchemas.delete(sKey)
    newTables.has(tKey) ? newTables.delete(tKey) : newTables.add(tKey)
    onSelectionChange(newTables, newSchemas)
  }

  return (
    <div className="border-b border-gray-800 last:border-0">
      {/* Schema row */}
      <div
        className="flex items-center gap-2 pl-8 pr-4 py-2.5 cursor-pointer hover:bg-gray-800 select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-gray-500 shrink-0">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <Database size={12} className="text-blue-400 shrink-0" />
        <span className="font-semibold text-sm flex-1 truncate">{schema.schema_name}</span>
        <span className="text-gray-500 text-xs shrink-0">
          {schema.table_count} tables · {schema.total_size_pretty}
        </span>
        {/* Show blocked count once tables are loaded */}
        {tables && tables.length - freeTables.length > 0 && (
          <span className="text-xs text-amber-500/70 shrink-0">
            {tables.length - freeTables.length} in pub
          </span>
        )}
        {pgMajor >= 15 && (
          <div
            className="flex items-center gap-1.5 ml-3 pl-3 border-l border-gray-700 shrink-0"
            onClick={e => e.stopPropagation()}
          >
            <SchemaCheckbox
              checked={isSchemaChecked || isAllTablesSelected}
              indeterminate={isIndeterminate}
              onChange={toggleSchemaSelect}
            />
            <span className="text-xs text-gray-400">All schema</span>
          </div>
        )}
        {onCreateReplication && (
          <button
            onClick={e => {
              e.stopPropagation()
              if (tables && tables.length > 0) {
                // Tables already loaded — select all free ones immediately
                const newTables = new Set(selectedTables)
                const newSchemas = new Set(selectedSchemas)
                newSchemas.delete(sKey)
                freeTables.forEach(t => newTables.add(tableKey(dbName, schema.schema_name, t.table_name)))
                onSelectionChange(newTables, newSchemas)
              } else {
                // Expand to trigger lazy load, select all when loaded
                setExpanded(true)
                setSelectAllOnLoad(true)
              }
              onCreateReplication(dbName, schema.schema_name)
            }}
            className="flex items-center gap-1 text-xs bg-green-900/40 hover:bg-green-800/60 border border-green-700/60 hover:border-green-600 text-green-400 px-2 py-0.5 rounded ml-2 shrink-0 transition-colors"
            title={`Create new replication for schema "${schema.schema_name}"`}
          >
            <Play size={10} />
            Create replication
          </button>
        )}
      </div>

      {/* Table list — lazy loaded */}
      {expanded && (
        <div className="bg-gray-950/40">
          {tablesLoading && (
            <div className="pl-16 py-2 flex items-center gap-2 text-xs text-gray-500">
              <Spinner size={3} /> Loading tables...
            </div>
          )}
          {!tablesLoading && filteredTables.length === 0 && (
            <div className="pl-16 py-2 text-xs text-gray-500">
              {q ? `No tables matching "${q}"` : 'No tables.'}
            </div>
          )}
          {!tablesLoading && filteredTables.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-600 border-b border-gray-800">
                  <th className="pl-16 pr-2 py-1.5 text-left w-8">
                    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                      <button
                        className="text-blue-500 hover:text-blue-300 disabled:opacity-30 disabled:cursor-not-allowed"
                        title={freeTables.length === 0 ? 'All tables are in existing publications' : 'Select all free tables'}
                        disabled={freeTables.length === 0}
                        onClick={selectAll}
                      >all</button>
                      <span className="text-gray-700">/</span>
                      <button className="text-gray-500 hover:text-gray-300" title="Deselect all" onClick={deselectAll}>none</button>
                    </div>
                  </th>
                  <th className="px-2 py-1.5 text-left">Table</th>
                  <th className="px-2 py-1.5 text-right">Size</th>
                  <th className="px-2 py-1.5 text-right pr-4">Rows (est.)</th>
                </tr>
              </thead>
              <tbody>
                {filteredTables.map((table: TableInfo) => {
                  const tKey = tableKey(dbName, schema.schema_name, table.table_name)
                  const schemaTableKey = `${schema.schema_name}.${table.table_name}`
                  const isTableSchemaSelected = selectedSchemas.has(sKey)
                  const isSelected = selectedTables.has(tKey) || isTableSchemaSelected
                  const isHighlighted = q && table.table_name.toLowerCase().includes(q)
                  const inPublications: string[] = publishedMap[schemaTableKey] ?? []
                  const blockedByPub = inPublications.length > 0

                  return (
                    <tr
                      key={tKey}
                      className={clsx('border-b border-gray-800/50 transition-colors', {
                        'bg-blue-950/30': isSelected,
                        'bg-yellow-950/20': isHighlighted && !isSelected && !blockedByPub,
                        'bg-amber-950/20 opacity-75': blockedByPub,
                        'hover:bg-gray-800': !blockedByPub,
                      })}
                    >
                      <td className="pl-16 pr-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={isSelected && !blockedByPub}
                          disabled={isTableSchemaSelected || blockedByPub}
                          onChange={() => toggleTable(table.table_name)}
                          className="accent-blue-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                          title={blockedByPub ? `Already in publication: ${inPublications.join(', ')}` : undefined}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Table size={11} className="text-gray-600 shrink-0" />
                          <span className={clsx({ 'text-yellow-300': isHighlighted && !isSelected })}>
                            {table.table_name}
                          </span>
                          {inPublications.map(pub => (
                            <button
                              key={pub}
                              onClick={e => handlePubClick(pub, e)}
                              disabled={loadingPub === pub}
                              className="text-xs bg-amber-900/50 border border-amber-700/60 text-amber-300 hover:bg-amber-800/60 hover:border-amber-600 rounded px-1.5 py-0.5 font-mono flex items-center gap-1 transition-colors disabled:opacity-60"
                              title={`Click to open publication "${pub}" in Setup tab`}
                            >
                              {loadingPub === pub && <Spinner size={2} />}
                              {pub}
                            </button>
                          ))}
                          {table.is_partitioned && (
                            <Badge label="PARTITIONED" variant="yellow" />
                          )}
                          {table.is_partition && (
                            <Badge label="PARTITION" variant="gray" />
                          )}
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
          )}
        </div>
      )}
    </div>
  )
}

// ── Database node — lazy loads schema list ────────────────────────────────────

interface DbNodeProps {
  db: DatabaseInfo
  pgMajor: number
  search: string
  selectedTables: Set<string>
  selectedSchemas: Set<string>
  onSelectionChange: (tables: Set<string>, schemas: Set<string>) => void
  onOpenPublication?: (config: PublicationServerConfig) => void
  onCreateReplication?: (db: string, schema: string) => void
  initiallyExpanded: boolean
}

function DbNode({
  db, pgMajor, search, selectedTables, selectedSchemas, onSelectionChange, onOpenPublication, onCreateReplication, initiallyExpanded,
}: DbNodeProps) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [ensuring, setEnsuring] = useState(false)
  const [ensureResult, setEnsureResult] = useState<{ status: string } | null>(null)

  // Level 2: schema list (names + sizes, no tables) — loaded when db is expanded
  const { data: schemas, isLoading, error } = useQuery({
    queryKey: ['db-schema-list', db.database],
    queryFn: () => analysisApi.databaseSchemaList(db.database).then(r => r.data),
    enabled: expanded,
    staleTime: 30_000,
  })

  // Publication map — loaded alongside schema list
  const { data: publishedMap = {} } = useQuery({
    queryKey: ['published-tables', db.database],
    queryFn: () => analysisApi.publishedTables(db.database).then(r => r.data),
    enabled: expanded,
    staleTime: 15_000,
  })

  const q = search.trim().toLowerCase()

  // Filter schemas by search (schema name match — table matches handled inside SchemaNode)
  const filteredSchemas = (schemas ?? []).filter(s =>
    !q || s.schema_name.toLowerCase().includes(q)
  )

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

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      {/* Database header */}
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

        {hasSelection && (
          <span className="text-xs bg-blue-900/60 text-blue-300 rounded px-1.5 py-0.5 shrink-0">
            {dbSelectedSchemas > 0 && `${dbSelectedSchemas} schema${dbSelectedSchemas !== 1 ? 's' : ''}`}
            {dbSelectedSchemas > 0 && dbSelectedTables > 0 && ' + '}
            {dbSelectedTables > 0 && `${dbSelectedTables} table${dbSelectedTables !== 1 ? 's' : ''}`}
          </span>
        )}

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

      {/* Schema list — lazy loaded at db expand */}
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
              {q ? `No schemas matching "${q}"` : 'No schemas found.'}
            </div>
          )}
          {filteredSchemas.map(schema => (
            <SchemaNode
              key={schema.schema_name}
              dbName={db.database}
              schema={schema}
              pgMajor={pgMajor}
              search={search}
              selectedTables={selectedTables}
              selectedSchemas={selectedSchemas}
              publishedMap={publishedMap}
              onSelectionChange={onSelectionChange}
              onOpenPublication={onOpenPublication}
              onCreateReplication={onCreateReplication}
              initiallyExpanded={false}
            />
          ))}
        </div>
      )}
      {/* Publications panel — shown when db is expanded and publications exist */}
      {expanded && Object.keys(publishedMap).length > 0 && (
        <PublicationsPanel
          dbName={db.database}
          publishedMap={publishedMap}
          onOpenPublication={onOpenPublication}
        />
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AnalysisPage({ selectedTables, selectedSchemas, pgMajor, onSelectionChange, onOpenPublication, onCreateReplication }: Props) {
  const [search, setSearch] = useState('')

  const { data: databases, isLoading, error } = useQuery({
    queryKey: ['cluster-databases'],
    queryFn: () => analysisApi.databases().then(r => r.data),
  })

  const totalSelectedTables = selectedTables.size
  const totalSelectedSchemas = selectedSchemas.size

  if (isLoading) return <div className="flex items-center gap-2 p-8"><Spinner /> Loading cluster databases...</div>
  if (error) return <div className="text-red-400 p-8">Failed to load databases from cluster.</div>

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Database Analysis</h2>
        <span className="text-gray-400 text-xs">
          {totalSelectedTables > 0 || totalSelectedSchemas > 0
            ? `${totalSelectedTables} table${totalSelectedTables !== 1 ? 's' : ''} + ${totalSelectedSchemas} schema${totalSelectedSchemas !== 1 ? 's' : ''} selected`
            : 'Nothing selected'}
        </span>
      </div>

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
        ⚠️ Sequences (serial/identity columns) are NOT replicated. Use <strong>Sequence Sync</strong> in the Status tab (click a publication name to reveal the panel) after stopping or completing replication.
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
        {(totalSelectedTables > 0 || totalSelectedSchemas > 0) && (
          <button
            onClick={() => onSelectionChange(new Set(), new Set())}
            className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded"
          >
            <ChevronsUpDown size={12} className="inline mr-1" />
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
            onOpenPublication={onOpenPublication}
            onCreateReplication={onCreateReplication}
            initiallyExpanded={
              [...selectedTables].some(k => k.startsWith(`${db.database}.`)) ||
              [...selectedSchemas].some(k => k.startsWith(`${db.database}.`))
            }
          />
        ))}
      </div>
    </div>
  )
}
