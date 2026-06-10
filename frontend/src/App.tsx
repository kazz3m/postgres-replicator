import { useState, useEffect } from 'react'
import { WorkspacePicker, WorkspaceSnapshot } from './pages/WorkspacePicker'
import { ConnectionPage } from './pages/ConnectionPage'
import { AnalysisPage } from './pages/AnalysisPage'
import { ReplicationSetupPage } from './pages/ReplicationSetupPage'
import { StatusPage } from './pages/StatusPage'
import { SchemaDumpPage } from './pages/SchemaDumpPage'
import { connectionsApi, analysisApi, SchemaInfo } from './api/client'
import { ConnectionProfile, ReplicationConfig, touchProfile, updateProfile } from './utils/profiles'
import { PublicationServerConfig } from './api/client'
import { randomPrefix, LABEL_MAX } from './pages/ReplicationSetupPage'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'

type AppStage = 'loading' | 'picker' | 'connecting' | 'connected'
type Tab = 'analysis' | 'setup' | 'status' | 'schema-dump'

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
  const [stage, setStage] = useState<AppStage>('loading')
  const [sourceDsn, setSourceDsn] = useState('')
  const [destDsn, setDestDsn] = useState('')
  const [pgMajor, setPgMajor] = useState(0)
  const [tab, setTab] = useState<Tab>('analysis')
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [initialSnapshot, setInitialSnapshot] = useState<WorkspaceSnapshot | null>(null)
  // Map of pub_name → ReplicationConfig persisted per-publication
  const [replConfigs, setReplConfigs] = useState<Record<string, ReplicationConfig>>({})
  // Publication currently active in Setup tab (pre-filled from server or saved config)
  const [activeSetupPub, setActiveSetupPub] = useState<string | undefined>(undefined)

  const saved = loadSelection()
  const [selectedTables, setSelectedTables] = useState<Set<string>>(saved.tables)
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(saved.schemas)

  const { data: schemaData } = useQuery<SchemaInfo[]>({
    queryKey: ['schemas'],
    queryFn: () => analysisApi.schemas().then(r => r.data),
    enabled: stage === 'connected',
  })

  // On mount: check if backend already has a live connection (page refresh scenario).
  // If yes, skip picker and restore the workspace directly.
  useEffect(() => {
    connectionsApi.status().then(r => {
      if (r.data.connected) {
        setSourceDsn(r.data.source_dsn ?? '')
        setDestDsn(r.data.dest_dsn ?? '')
        if (r.data.pg_major) setPgMajor(r.data.pg_major)
        setStage('connected')
      } else {
        setStage('picker')
      }
    }).catch(() => setStage('picker'))
  }, [])

  // ── Workspace Picker callbacks ────────────────────────────────────────────

  function handleNewWorkspace() {
    setStage('connecting')
  }

  function handleLoadWorkspace(profile: ConnectionProfile, snapshot: WorkspaceSnapshot) {
    setSourceDsn(profile.source_dsn)
    setDestDsn(profile.dest_dsn)
    setActiveProfileId(profile.id)
    setInitialSnapshot(snapshot)
    void touchProfile(profile.id)

    // Restore saved table selection from the profile
    if (profile.selected_tables || profile.selected_schemas) {
      const tables = new Set<string>(profile.selected_tables ?? [])
      const schemas = new Set<string>(profile.selected_schemas ?? [])
      setSelectedTables(tables)
      setSelectedSchemas(schemas)
      persistSelection(tables, schemas)
    }

    // Restore replication configs (pub_name → config map)
    const configs: Record<string, ReplicationConfig> = { ...(profile.replication_configs ?? {}) }
    // Migrate legacy single replication_config if present
    if (profile.replication_config && !configs[profile.replication_config.pub_name]) {
      configs[profile.replication_config.pub_name] = profile.replication_config
    }
    if (Object.keys(configs).length > 0) {
      setReplConfigs(configs)

      // If profile has no table selection but configs have tables, restore from first config
      const hasProfileSelection = (profile.selected_tables?.length ?? 0) > 0 || (profile.selected_schemas?.length ?? 0) > 0
      if (!hasProfileSelection) {
        const firstCfg = Object.values(configs)[0]
        if (firstCfg?.database && firstCfg.tables && firstCfg.tables.length > 0) {
          const tables = new Set(firstCfg.tables.map(t => `${firstCfg.database}.${t}`))
          setSelectedTables(tables)
          setSelectedSchemas(new Set())
          persistSelection(tables, new Set())
        } else if (firstCfg?.database && firstCfg.schemas && firstCfg.schemas.length > 0) {
          const schemas = new Set(firstCfg.schemas.map(s => `${firstCfg.database}.${s}`))
          setSelectedTables(new Set())
          setSelectedSchemas(schemas)
          persistSelection(new Set(), schemas)
        }
      }
    }

    // Switch directly to Status tab to show live replication state
    setTab('status')
    setStage('connected')
  }

  // ── ConnectionPage callback ───────────────────────────────────────────────

  function handleConnected(srcDsn: string, dstDsn: string, major: number) {
    setSourceDsn(srcDsn)
    setDestDsn(dstDsn)
    setPgMajor(major)
    setInitialSnapshot(null)
    setStage('connected')
    setTab('analysis')
  }

  // ── Selection change ──────────────────────────────────────────────────────

  function handleSelectionChange(tables: Set<string>, schemas: Set<string>) {
    setSelectedTables(tables)
    setSelectedSchemas(schemas)
    persistSelection(tables, schemas)
    // Keep profile selection in sync so next load restores it
    if (activeProfileId) {
      void updateProfile(activeProfileId, {
        selected_tables: [...tables],
        selected_schemas: [...schemas],
      })
    }
  }

  // ── Replication config save ───────────────────────────────────────────────

  function handleReplConfigChange(cfg: ReplicationConfig) {
    // Enrich with current table selection if not already set
    const existing = replConfigs[cfg.pub_name]
    const enriched: ReplicationConfig = {
      ...cfg,
      tables: cfg.tables ?? existing?.tables,
      schemas: cfg.schemas ?? existing?.schemas,
      database: cfg.database ?? existing?.database,
    }
    setReplConfigs(prev => {
      const next = { ...prev, [enriched.pub_name]: enriched }
      if (activeProfileId) void updateProfile(activeProfileId, { replication_configs: next })
      return next
    })
  }

  // ── Open publication in Setup tab (from Analysis badge click) ─────────────

  function handleOpenPublication(pubServerConfig: PublicationServerConfig) {
    const saved = replConfigs[pubServerConfig.pub_name]
    const sub = pubServerConfig.subscriptions[0]

    const merged: ReplicationConfig = {
      pub_name: pubServerConfig.pub_name,
      sub_name: saved?.sub_name ?? sub?.sub_name ?? 'pg_sync_sub',
      copy_data: saved?.copy_data ?? true,
      database: pubServerConfig.database,
      // Prefer server-side table list (source of truth); fall back to saved
      tables: pubServerConfig.tables.length > 0 ? pubServerConfig.tables : (saved?.tables ?? []),
      schemas: pubServerConfig.schemas.length > 0 ? pubServerConfig.schemas : (saved?.schemas ?? []),
      last_applied: saved?.last_applied,
      last_status: saved?.last_status,
      last_error: saved?.last_error,
    }

    // Restore selectedTables/selectedSchemas from publication — prepend db prefix
    const db = pubServerConfig.database
    if (db && merged.tables && merged.tables.length > 0) {
      const tables = new Set(merged.tables.map(t => `${db}.${t}`))
      setSelectedTables(tables)
      setSelectedSchemas(new Set())
      persistSelection(tables, new Set())
      if (activeProfileId) {
        void updateProfile(activeProfileId, {
          selected_tables: [...tables],
          selected_schemas: [],
        })
      }
    } else if (db && merged.schemas && merged.schemas.length > 0) {
      const schemas = new Set(merged.schemas.map(s => `${db}.${s}`))
      setSelectedTables(new Set())
      setSelectedSchemas(schemas)
      persistSelection(new Set(), schemas)
      if (activeProfileId) {
        void updateProfile(activeProfileId, {
          selected_tables: [],
          selected_schemas: [...schemas],
        })
      }
    }

    setReplConfigs(prev => {
      const next = { ...prev, [merged.pub_name]: merged }
      if (activeProfileId) void updateProfile(activeProfileId, { replication_configs: next })
      return next
    })
    setActiveSetupPub(merged.pub_name)
    setTab('setup')
  }

  // ── Delete saved replication config ──────────────────────────────────────────

  function handleReplConfigDelete(pubName: string) {
    setReplConfigs(prev => {
      const next = { ...prev }
      delete next[pubName]
      if (activeProfileId) void updateProfile(activeProfileId, { replication_configs: next })
      return next
    })
    if (activeSetupPub === pubName) setActiveSetupPub(undefined)
  }

  // ── Create new replication from schema row in Analysis ───────────────────────

  function handleCreateReplication(db: string, schema: string) {
    const prefix = randomPrefix()
    const raw = `${db}_${schema}`
    const label = raw.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, LABEL_MAX)
    const pub_name = label ? `${prefix}_pub_${label}` : `${prefix}_pub`
    const sub_name = label ? `${prefix}_sub_${label}` : `${prefix}_sub`
    const cfg: ReplicationConfig = { pub_name, sub_name, copy_data: true, database: db }
    setReplConfigs(prev => {
      const next = { ...prev, [pub_name]: cfg }
      if (activeProfileId) void updateProfile(activeProfileId, { replication_configs: next })
      return next
    })
    // Note: selection is set by SchemaNode before calling this callback — do not clear it here
    setActiveSetupPub(pub_name)
    setTab('setup')
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  function handleDisconnect() {
    setStage('picker')
    setSelectedTables(new Set())
    setSelectedSchemas(new Set())
    setPgMajor(0)
    setActiveProfileId(null)
    setInitialSnapshot(null)
    setReplConfigs({})
    setActiveSetupPub(undefined)
    clearSelection()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (stage === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-400">
          <div className="w-5 h-5 border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin" />
          Connecting...
        </div>
      </div>
    )
  }

  if (stage === 'picker') {
    return (
      <WorkspacePicker
        onNewWorkspace={handleNewWorkspace}
        onLoadWorkspace={handleLoadWorkspace}
      />
    )
  }

  if (stage === 'connecting') {
    return (
      <ConnectionPage
        onConnected={(srcDsn, dstDsn, major) => handleConnected(srcDsn, dstDsn, major)}
        onBack={() => setStage('picker')}
      />
    )
  }

  // stage === 'connected'
  const tabs: { id: Tab; label: string }[] = [
    { id: 'analysis', label: 'Analysis' },
    { id: 'setup', label: 'Setup' },
    { id: 'status', label: 'Status' },
    { id: 'schema-dump', label: 'Schema Dump' },
  ]

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-900 border-b border-gray-700 px-6 py-3 flex items-center justify-between">
        <button
          onClick={handleDisconnect}
          className="text-blue-400 font-bold tracking-wide hover:text-blue-300 transition-colors"
          title="Back to workspace picker"
        >
          PG Replication Manager
        </button>
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
                {t.id === 'status' && initialSnapshot && (
                  <span className="ml-1.5 bg-green-700 text-white rounded-full text-xs px-1.5">
                    {initialSnapshot.subscriptions.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <button
            onClick={handleDisconnect}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            ← Workspaces
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
            onOpenPublication={handleOpenPublication}
            onCreateReplication={handleCreateReplication}
          />
        )}
        {tab === 'setup' && (
          <ReplicationSetupPage
            selectedTables={selectedTables}
            selectedSchemas={selectedSchemas}
            sourceDsn={sourceDsn}
            pgMajor={pgMajor}
            schemaData={schemaData ?? []}
            replConfigs={replConfigs}
            activeSetupPub={activeSetupPub}
            onReplConfigChange={handleReplConfigChange}
            onReplConfigDelete={handleReplConfigDelete}
          />
        )}
        {tab === 'status' && (
          <StatusPage initialSnapshot={initialSnapshot ?? undefined} />
        )}
        {tab === 'schema-dump' && (
          <SchemaDumpPage />
        )}
      </main>
    </div>
  )
}
