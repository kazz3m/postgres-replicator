import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { analysisApi, SchemaInfo } from '../api/client'
import { Spinner } from '../components/Spinner'
import { ChevronDown, ChevronRight, Database, Table } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  selectedTables: Set<string>
  selectedSchemas: Set<string>
  pgMajor: number
  onSelectionChange: (tables: Set<string>, schemas: Set<string>) => void
}

export function AnalysisPage({ selectedTables, selectedSchemas, pgMajor, onSelectionChange }: Props) {
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
  const { data, isLoading, error } = useQuery({
    queryKey: ['schemas'],
    queryFn: () => analysisApi.schemas().then(r => r.data),
  })

  function toggleSchema(name: string) {
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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Database Analysis</h2>
        <span className="text-gray-400 text-xs">
          {totalSelected > 0 ? `${selectedTables.size} tables + ${selectedSchemas.size} schemas selected` : 'Nothing selected'}
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

      <div className="space-y-2">
        {data?.map(schema => (
          <div key={schema.schema_name} className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
            <div
              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800"
              onClick={() => toggleSchema(schema.schema_name)}
            >
              {expandedSchemas.has(schema.schema_name) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Database size={14} className="text-blue-400" />
              <span className="font-semibold flex-1">{schema.schema_name}</span>
              <span className="text-gray-500 text-xs">{schema.tables.length} tables · {schema.total_size_pretty}</span>

              {pgMajor >= 15 && (
                <label className="flex items-center gap-1.5 ml-4 cursor-pointer" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedSchemas.has(schema.schema_name)}
                    onChange={() => toggleSchemaSelect(schema.schema_name, schema.tables)}
                    className="accent-blue-500"
                  />
                  <span className="text-xs text-gray-400">All schema</span>
                </label>
              )}
            </div>

            {expandedSchemas.has(schema.schema_name) && (
              <div className="border-t border-gray-700">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700">
                      <th className="px-4 py-2 text-left w-8"></th>
                      <th className="px-4 py-2 text-left">Table</th>
                      <th className="px-4 py-2 text-right">Size</th>
                      <th className="px-4 py-2 text-right">Rows (est.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.tables.map(table => {
                      const key = `${table.schema_name}.${table.table_name}`
                      const isSchemaSelected = selectedSchemas.has(schema.schema_name)
                      const isSelected = selectedTables.has(key) || isSchemaSelected
                      return (
                        <tr
                          key={key}
                          className={clsx('border-b border-gray-800 hover:bg-gray-800', {
                            'bg-blue-950/30': isSelected,
                          })}
                        >
                          <td className="px-4 py-2">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={isSchemaSelected}
                              onChange={() => toggleTableSelect(key, schema.schema_name)}
                              className="accent-blue-500"
                            />
                          </td>
                          <td className="px-4 py-2 flex items-center gap-2">
                            <Table size={12} className="text-gray-500" />
                            {table.table_name}
                          </td>
                          <td className="px-4 py-2 text-right text-gray-400">{table.size_pretty}</td>
                          <td className="px-4 py-2 text-right text-gray-400">{table.row_estimate.toLocaleString()}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
