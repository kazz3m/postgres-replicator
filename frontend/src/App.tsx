import { useState, useEffect } from 'react'
import { ConnectionPage } from './pages/ConnectionPage'
import { AnalysisPage } from './pages/AnalysisPage'
import { ReplicationSetupPage } from './pages/ReplicationSetupPage'
import { StatusPage } from './pages/StatusPage'
import { connectionsApi, analysisApi, SchemaInfo } from './api/client'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'

type Tab = 'analysis' | 'setup' | 'status'

const SESSION_TABLES_KEY = 'pg_sync_selected_tables'
const SESSION_SCHEMAS_KEY = 'pg_sync_selected_schemas'

function loadSelection(): { tables: Set<string>; schemas: Set<string> } {
  try {
    const t = sessionStorage.getItem(SESSION_TABLES_KEY)
    const s = sessionStorage.getItem(SESSION_SCHEMAS_KEY)
    return {
      tables: t ? new Set(JSON.parse(t)) : new Set(),
      schemas: s ? new Set(JSON.parse(s)) : new Set(),
    }
  } catch {
    return { tables: new Set(), schemas: new Set() }
  }
}

function persistSelection(tables: Set<string>, schemas: Set<string>) {
  sessionStorage.setItem(SESSION_TABLES_KEY, JSON.stringify([...tables]))
  sessionStorage.setItem(SESSION_SCHEMAS_KEY, JSON.stringify([...schemas]))
}

function clearSelection() {
  sessionStorage.removeItem(SESSION_TABLES_KEY)
  sessionStorage.removeItem(SESSION_SCHEMAS_KEY)
}

export default function App() {
  const [connected, setConnected] = useState(false)
  const [sourceDsn, setSourceDsn] = useState('')
  const [destDsn, setDestDsn] = useState('')
  const [pgMajor, setPgMajor] = useState(0)
  const [tab, setTab] = useState<Tab>('analysis')

  const saved = loadSelection()
  const [selectedTables, setSelectedTables] = useState<Set<string>>(saved.tables)
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(saved.schemas)

  const { data: schemaData } = useQuery<SchemaInfo[]>({
    queryKey: ['schemas'],
    queryFn: () => analysisApi.schemas().then(r => r.data),
    enabled: connected,
  })

  // On mount: check if backend already has a saved connection (e.g. after page refresh
  // or frontend restart). If so, restore connected state and pgMajor without requiring
  // the user to go through the connection form again.
  useEffect(() => {
    connectionsApi.status().then(r => {
      if (r.data.connected) {
        setConnected(true)
        setSourceDsn(r.data.source_dsn ?? '')
        setDestDsn(r.data.dest_dsn ?? '')
        // Fix: restore pgMajor from the status endpoint so schema-level publication
        // checkbox and version banners work correctly after a page refresh.
        if (r.data.pg_major) {
          setPgMajor(r.data.pg_major)
        }
      }
    }).catch(() => {})
  }, [])

  function handleConnected(srcDsn: string, dstDsn: string, major: number) {
    setConnected(true)
    setSourceDsn(srcDsn)
    setDestDsn(dstDsn)
    setPgMajor(major)
    setTab('analysis')
  }

  function handleSelectionChange(tables: Set<string>, schemas: Set<string>) {
    setSelectedTables(tables)
    setSelectedSchemas(schemas)
    persistSelection(tables, schemas)
  }

  function handleDisconnect() {
    setConnected(false)
    setSelectedTables(new Set())
    setSelectedSchemas(new Set())
    setPgMajor(0)
    clearSelection()
  }

  if (!connected) {
    return (
      <ConnectionPage
        onConnected={(srcDsn, dstDsn, major) => handleConnected(srcDsn, dstDsn, major)}
      />
    )
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'analysis', label: 'Analysis' },
    { id: 'setup', label: 'Setup' },
    { id: 'status', label: 'Status' },
  ]

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-900 border-b border-gray-700 px-6 py-3 flex items-center justify-between">
        <span className="text-blue-400 font-bold tracking-wide">PG Replication Manager</span>
        <div className="flex items-center gap-6">
          <nav className="flex gap-1">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={clsx('px-3 py-1.5 rounded text-sm', {
                  'bg-blue-700 text-white': tab === t.id,
                  'text-gray-400 hover:text-gray-200 hover:bg-gray-800': tab !== t.id,
                })}
              >
                {t.label}
                {t.id === 'analysis' && (selectedTables.size + selectedSchemas.size) > 0 && (
                  <span className="ml-1.5 bg-blue-500 text-white rounded-full text-xs px-1.5">
                    {selectedTables.size + selectedSchemas.size}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <button
            onClick={handleDisconnect}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            Disconnect
          </button>
        </div>
      </header>

      <main className="flex-1">
        {tab === 'analysis' && (
          <AnalysisPage
            selectedTables={selectedTables}
            selectedSchemas={selectedSchemas}
            pgMajor={pgMajor}
            onSelectionChange={handleSelectionChange}
          />
        )}
        {tab === 'setup' && (
          <ReplicationSetupPage
            selectedTables={selectedTables}
            selectedSchemas={selectedSchemas}
            sourceDsn={sourceDsn}
            pgMajor={pgMajor}
            schemaData={schemaData ?? []}
          />
        )}
        {tab === 'status' && <StatusPage />}
      </main>
    </div>
  )
}
