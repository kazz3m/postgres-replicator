import { useState, useEffect } from 'react'
import { ConnectionPage } from './pages/ConnectionPage'
import { AnalysisPage } from './pages/AnalysisPage'
import { ReplicationSetupPage } from './pages/ReplicationSetupPage'
import { StatusPage } from './pages/StatusPage'
import { connectionsApi, analysisApi, SchemaInfo } from './api/client'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'

type Tab = 'analysis' | 'setup' | 'status'

export default function App() {
  const [connected, setConnected] = useState(false)
  const [sourceDsn, setSourceDsn] = useState('')
  const [destDsn, setDestDsn] = useState('')
  const [pgMajor, setPgMajor] = useState(0)
  const [tab, setTab] = useState<Tab>('analysis')
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set())
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set())

  const { data: schemaData } = useQuery<SchemaInfo[]>({
    queryKey: ['schemas'],
    queryFn: () => analysisApi.schemas().then(r => r.data),
    enabled: connected,
  })

  useEffect(() => {
    connectionsApi.status().then(r => {
      if (r.data.connected) {
        setConnected(true)
        setSourceDsn(r.data.source_dsn)
        setDestDsn(r.data.dest_dsn)
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
            onClick={() => { setConnected(false); setSelectedTables(new Set()); setSelectedSchemas(new Set()) }}
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
            onSelectionChange={(t, s) => { setSelectedTables(t); setSelectedSchemas(s) }}
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
