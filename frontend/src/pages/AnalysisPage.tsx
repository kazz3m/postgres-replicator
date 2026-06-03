import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { analysisApi, SchemaInfo } from '../api/client'
import { Spinner } from '../components/Spinner'
import { Badge } from '../components/Badge'
import { ChevronDown, ChevronRight, Database, Table, Search, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  selectedTables: Set<string>
  selectedSchemas: Set<string>
  pgMajor: number
  onSelectionChange: (tables: Set<string>, schemas: Set<string>) => void
}

// Checkbox that supports indeterminate state via ref
function SchemaCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
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
      className="accent-blue-500 cursor-pointer"
      onClick={e => e.stopPropagation()}
    />
  )
}

export function AnalysisPage({ selectedTables, selectedSchemas, pgMajor, onSelectionChange }: Props) {
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['schemas'],
    queryFn: () => analysisApi.schemas().then(r => r.data),
  })

  // On mount / when data arrives, auto-expand schemas that have selected tables
  useEffect(() => {
    if (!data) return
    const toExpand = new Set<string>()
    for (const schema of data) {
      const hasSelected =
        selectedSchemas.has(schema.schema_name) ||
        schema.tables.some(t => selectedTables.has(`${t.schema_name}.${t.table_name}`))
      if (hasSelected) toExpand.add(schema.schema_name)
    }
    if (toExpand.size > 0) setExpandedSchemas(prev => new Set([...prev, ...toExpand]))
  }, [data]) // intentionally only on data load

  const q = search.trim().toLowerCase()

  const filteredSchemas = data
    ? data
        .map(schema => ({
          ...schema,
          tables: q
            ? schema.tables.filter(
                t =>
                  t.table_name.toLowerCase().includes(q) ||
                  schema.schema_name.toLowerCase().includes(q),
              )
            : schema.tables,
        }))
        .filter(s => s.tables.length > 0)
    : []

  const allSchemaNames = filteredSchemas.map(s => s.schema_name)

  function expandAll() {
    setExpandedSchemas(new Set(allSchemaNames))
  }
  function collapseAll() {
    setExpandedSchemas(new Set())
  }
  const allExpanded = allSchemaNames.length > 0 && allSchemaNames.every(n => expandedSchemas.has(n))

  function selectAllVisible() {
    const newTables = new Set(selectedTables)
    const newSchemas = new Set(selectedSchemas)
    for (const schema of filteredSchemas) {
      if (pgMajor >= 15) {
        newSchemas.add(schema.schema_name)
        schema.tables.forEach(t => newTables.delete(`${t.schema_name}.${t.table_name}`))
      } else {
        schema.tables.forEach(t => newTables.add(`${t.schema_name}.${t.table_name}`))
      }
    }
    onSelectionChange(newTables, newSchemas)
  }

  function deselectAll() {
    const newTables = new Set(selectedTables)
    const newSchemas = new Set(selectedSchemas)
    for (const schema of filteredSchemas) {
      newSchemas.delete(schema.schema_name)
      schema.tables.forEach(t => newTables.delete(`${t.schema_name}.${t.table_name}`))
    }
    onSelectionChange(newTables, newSchemas)
  }

  function toggleSchemaExpand(name: string) {
    setExpandedSchemas(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  function toggleSchemaSelect(schemaName: string, tables: SchemaInfo['tables']) {
    const newSchemas = new Set(selectedSchemas)
    const newTables = new Set(selectedTables)
    if (newSchemas.has(schemaName)) {
      newSchemas.delete(schemaName)
      tables.forEach(t => newTables.delete(`${t.schema_name}.${t.table_name}`))
    } else {
      newSchemas.add(schemaName)
      tables.forEach(t => newTables.delete(`${t.schema_name}.${t.table_name}`))
    }
    onSelectionChange(newTables, newSchemas)
  }

  function toggleTableSelect(key: string, schemaName: string) {
    const newTables = new Set(selectedTables)
    const newSchemas = new Set(selectedSchemas)
    newSchemas.delete(schemaName)
    newTables.has(key) ? newTables.delete(key) : newTables.add(key)
    onSelectionChange(newTables, newSchemas)
  }

  if (isLoading) return <div className="flex items-center gap-2 p-8"><Spinner /> Loading schemas...</div>
  if (error) return <div className="text-red-400 p-8">Failed to load schemas.</div>

  const totalSelected = selectedTables.size + selectedSchemas.size

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Database Analysis</h2>
        <span className="text-gray-400 text-xs">
          {totalSelected > 0
            ? `${selectedTables.size} table${selectedTables.size !== 1 ? 's' : ''} + ${selectedSchemas.size} schema${selectedSchemas.size !== 1 ? 's' : ''} selected`
            : 'Nothing selected'}
        </span>
      </div>

      {/* Version banners */}
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
        ⚠️ Sequences (serial/identity columns) are NOT replicated. After failover to destination,
        auto-increment values may conflict. Manually sync sequences after initial copy.
      </div>
      <div className="text-xs text-blue-400 bg-blue-950 border border-blue-800 rounded px-3 py-2">
        ℹ️ Partitioned tables: leaf partitions must exist on destination with identical structure.
        Root table selection replicates all partitions.
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
          onClick={allExpanded ? collapseAll : expandAll}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded"
          title={allExpanded ? 'Collapse all' : 'Expand all'}
        >
          {allExpanded ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
        <button
          onClick={selectAllVisible}
          className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800 hover:border-blue-600 px-2.5 py-1.5 rounded"
        >
          Select all
        </button>
        <button
          onClick={deselectAll}
          className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded"
        >
          Deselect all
        </button>
      </div>

      {/* Schema tree */}
      <div className="space-y-2">
        {filteredSchemas.length === 0 && (
          <div className="text-gray-500 text-sm py-4 text-center">
            {q ? `No tables matching "${search}"` : 'No tables found.'}
          </div>
        )}
        {filteredSchemas.map(schema => {
          const isExpanded = expandedSchemas.has(schema.schema_name)
          const isSchemaChecked = selectedSchemas.has(schema.schema_name)

          // indeterminate: some but not all tables individually selected (and schema not selected as whole)
          const selectedTableCount = schema.tables.filter(t =>
            selectedTables.has(`${t.schema_name}.${t.table_name}`)
          ).length
          const isIndeterminate =
            !isSchemaChecked && selectedTableCount > 0 && selectedTableCount < schema.tables.length
          const isAllTablesSelected =
            !isSchemaChecked && selectedTableCount === schema.tables.length && schema.tables.length > 0

          return (
            <div
              key={schema.schema_name}
              className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden"
            >
              {/* Schema row */}
              <div
                className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-gray-800 select-none"
                onClick={() => toggleSchemaExpand(schema.schema_name)}
              >
                <span className="text-gray-500">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <Database size={14} className="text-blue-400 shrink-0" />
                <span className="font-semibold flex-1 truncate">{schema.schema_name}</span>
                <span className="text-gray-500 text-xs shrink-0">
                  {schema.tables.length} tables · {schema.total_size_pretty}
                </span>

                {/* Schema-level checkbox — outside clickable expand area, PG15+ only */}
                {pgMajor >= 15 && (
                  <div
                    className="flex items-center gap-1.5 ml-3 pl-3 border-l border-gray-700 shrink-0"
                    onClick={e => e.stopPropagation()}
                  >
                    <SchemaCheckbox
                      checked={isSchemaChecked || isAllTablesSelected}
                      indeterminate={isIndeterminate}
                      onChange={() => toggleSchemaSelect(schema.schema_name, schema.tables)}
                    />
                    <span className="text-xs text-gray-400">All schema</span>
                  </div>
                )}
              </div>

              {/* Table list */}
              {isExpanded && (
                <div className="border-t border-gray-700">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-700 bg-gray-900/50">
                        <th className="px-4 py-2 text-left w-8"></th>
                        <th className="px-4 py-2 text-left">Table</th>
                        <th className="px-4 py-2 text-right">Size</th>
                        <th className="px-4 py-2 text-right">Rows (est.)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schema.tables.map(table => {
                        const key = `${table.schema_name}.${table.table_name}`
                        const isTableSchemaSelected = selectedSchemas.has(schema.schema_name)
                        const isSelected = selectedTables.has(key) || isTableSchemaSelected
                        const isHighlighted = q && table.table_name.toLowerCase().includes(q)

                        return (
                          <tr
                            key={key}
                            className={clsx('border-b border-gray-800 hover:bg-gray-800 transition-colors', {
                              'bg-blue-950/30': isSelected,
                              'bg-yellow-950/20': isHighlighted && !isSelected,
                            })}
                          >
                            <td className="px-4 py-2">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                disabled={isTableSchemaSelected}
                                onChange={() => toggleTableSelect(key, schema.schema_name)}
                                className="accent-blue-500 cursor-pointer disabled:opacity-40"
                              />
                            </td>
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-2">
                                <Table size={12} className="text-gray-500 shrink-0" />
                                <span className={clsx({ 'text-yellow-300': isHighlighted && !isSelected })}>
                                  {table.table_name}
                                </span>
                                {table.replica_identity === 'nothing' && (
                                  <span title="REPLICA IDENTITY NOTHING — UPDATE/DELETE will fail">
                                    <Badge label="NO REPLICATION" variant="red" />
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-2 text-right text-gray-400">{table.size_pretty}</td>
                            <td className="px-4 py-2 text-right text-gray-400">
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
    </div>
  )
}
