import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { connectionsApi, ConnectionStatus } from '../api/client'
import { Spinner } from '../components/Spinner'
import { Badge } from '../components/Badge'
import { ChevronDown, ChevronRight, Trash2, BookOpen, Save } from 'lucide-react'
import { loadProfiles, saveProfile, deleteProfile, ConnectionProfile } from '../utils/profiles'
import { shortDsn } from '../utils/maskDsn'

interface Props {
  onConnected: (srcDsn: string, dstDsn: string, major: number) => void
  onBack?: () => void
}

function getConnectionHint(error: string): string | null {
  if (error.includes('pg_hba.conf') || error.includes('no pg_hba.conf entry'))
    return 'Hint: Add a replication entry to pg_hba.conf on source: "host replication <user> <dest_ip>/32 md5"'
  if (error.includes('password authentication failed'))
    return 'Hint: Check username and password in the DSN.'
  if (error.includes('Connection refused'))
    return 'Hint: Verify host, port, and that PostgreSQL accepts remote connections (listen_addresses).'
  return null
}

function DsnInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
}) {
  return (
    <div>
      <label className="block text-gray-400 mb-1 text-xs uppercase tracking-wider">{label}</label>
      <input
        type="text"
        className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? 'postgresql://user:pass@host:5432/db'}
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  )
}

export function ConnectionPage({ onConnected, onBack }: Props) {
  const [sourceDsn, setSourceDsn] = useState('postgresql://user:pass@source-host:5432/dbname')
  const [sourceReplDsn, setSourceReplDsn] = useState('')
  const [destDsn, setDestDsn] = useState('postgresql://user:pass@dest-host:5432/dbname')

  const [loading, setLoading] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionStatus | null>(null)
  const [error, setError] = useState('')

  const queryClient = useQueryClient()
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: loadProfiles })
  const [profilesOpen, setProfilesOpen] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const [saveFormOpen, setSaveFormOpen] = useState(false)
  const [profileName, setProfileName] = useState('')

  function loadProfile(p: ConnectionProfile) {
    setSourceDsn(p.source_dsn)
    setSourceReplDsn(p.source_repl_dsn)
    setDestDsn(p.dest_dsn)
    setTestResult(null)
    setError('')
  }

  async function handleDeleteProfile(id: string) {
    await deleteProfile(id)
    queryClient.invalidateQueries({ queryKey: ['profiles'] })
    setDeleteConfirm(null)
  }

  async function handleSaveProfile() {
    if (!profileName.trim()) return
    await saveProfile({
      name: profileName.trim(),
      source_dsn: sourceDsn,
      source_repl_dsn: sourceReplDsn,
      dest_dsn: destDsn,
    })
    queryClient.invalidateQueries({ queryKey: ['profiles'] })
    setProfileName('')
    setSaveFormOpen(false)
    setProfilesOpen(true)
  }

  async function handleTest() {
    setLoading(true); setError(''); setTestResult(null); setSaveFormOpen(false)
    try {
      const { data } = await connectionsApi.test({
        source_dsn: sourceDsn,
        dest_dsn: destDsn,
        source_repl_dsn: sourceReplDsn || undefined,
      })
      setTestResult(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleConnect() {
    setLoading(true); setError('')
    try {
      const { data } = await connectionsApi.connect({
        source_dsn: sourceDsn,
        dest_dsn: destDsn,
        source_repl_dsn: sourceReplDsn || undefined,
      })
      const major = data.source_version?.major ?? 0
      onConnected(sourceDsn, destDsn, major)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }

  const testOk = testResult?.source_ok && testResult?.dest_ok
  const hint = error ? getConnectionHint(error) : null

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-4">
        {onBack && (
          <button
            onClick={onBack}
            className="mb-5 text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
          >
            ← Back to workspaces
          </button>
        )}
        <h1 className="text-2xl font-bold text-blue-400">New Workspace</h1>

        {/* ── Saved profiles ── */}
        {profiles.length > 0 && (
          <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
            <button
              className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-gray-300 hover:bg-gray-800 transition-colors"
              onClick={() => setProfilesOpen(o => !o)}
            >
              {profilesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <BookOpen size={14} className="text-blue-400" />
              <span className="flex-1 text-left">Saved Profiles</span>
              <span className="text-xs bg-blue-900 text-blue-300 rounded-full px-2 py-0.5">
                {profiles.length}
              </span>
            </button>
            {profilesOpen && (
              <div className="border-t border-gray-700 divide-y divide-gray-800">
                {profiles.map(p => (
                  <div key={p.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-800/50">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-gray-200 truncate">{p.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5 truncate">
                        <span className="text-gray-400">src:</span> {shortDsn(p.source_dsn)}
                        {p.source_repl_dsn && (
                          <span className="ml-2 text-blue-500">[+repl]</span>
                        )}
                        {'  '}
                        <span className="text-gray-400">dst:</span> {shortDsn(p.dest_dsn)}
                      </div>
                    </div>
                    <button
                      onClick={() => loadProfile(p)}
                      className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800 hover:border-blue-600 px-2.5 py-1 rounded shrink-0"
                    >
                      Load
                    </button>
                    {deleteConfirm === p.id ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-xs text-red-400">Delete?</span>
                        <button
                          onClick={() => handleDeleteProfile(p.id)}
                          className="text-xs text-red-400 hover:text-red-300 border border-red-800 px-2 py-1 rounded"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 px-2 py-1 rounded"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(p.id)}
                        className="text-gray-600 hover:text-red-400 shrink-0 p-1 rounded hover:bg-red-950/30"
                        title="Delete profile"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Source ── */}
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-blue-400 mb-1">
            Source (Publisher)
          </div>
          <DsnInput
            label="Admin DSN"
            value={sourceDsn}
            onChange={setSourceDsn}
            hint="Used for management queries (analysis, create publication, monitoring). Needs CREATE PUBLICATION or superuser."
          />
          <DsnInput
            label="Replication DSN (optional)"
            value={sourceReplDsn}
            onChange={setSourceReplDsn}
            hint="Used in CREATE SUBSCRIPTION CONNECTION clause. Must have REPLICATION attribute and SELECT on published tables. Leave empty to reuse Admin DSN."
          />
        </div>

        {/* ── Destination ── */}
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-green-400 mb-1">
            Destination (Subscriber)
          </div>
          <DsnInput
            label="Admin DSN"
            value={destDsn}
            onChange={setDestDsn}
            hint="Used for management queries (create subscription, monitor). Needs CREATE SUBSCRIPTION or superuser."
          />
        </div>

        {/* ── Errors ── */}
        {error && (
          <div className="text-sm bg-red-950 border border-red-800 rounded p-3 space-y-1">
            <div className="text-red-400">{error}</div>
            {hint && <div className="text-yellow-400 text-xs">{hint}</div>}
          </div>
        )}

        {/* ── Test result ── */}
        {testResult && (
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-400 w-28">Source:</span>
              <Badge
                label={testResult.source_ok ? 'OK' : 'FAIL'}
                variant={testResult.source_ok ? 'green' : 'red'}
              />
              {testResult.source_version && (
                <span className="text-gray-400">PG {testResult.source_version.major}</span>
              )}
              {testResult.source_error && (
                <span className="text-red-400 text-xs">{testResult.source_error}</span>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-400 w-28">Destination:</span>
              <Badge
                label={testResult.dest_ok ? 'OK' : 'FAIL'}
                variant={testResult.dest_ok ? 'green' : 'red'}
              />
              {testResult.dest_version && (
                <span className="text-gray-400">PG {testResult.dest_version.major}</span>
              )}
              {testResult.dest_error && (
                <span className="text-red-400 text-xs">{testResult.dest_error}</span>
              )}
            </div>
            {testResult.warnings && testResult.warnings.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-gray-700 pt-2">
                {testResult.warnings.map((w, i) => (
                  <div key={i} className="text-yellow-400 text-xs flex gap-1.5">
                    <span className="shrink-0">⚠</span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Save as profile — only shown after successful test */}
            {testOk && (
              <div className="border-t border-gray-700 pt-3">
                {saveFormOpen ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={profileName}
                      onChange={e => setProfileName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSaveProfile()}
                      placeholder='Profile name, e.g. "prod → staging"'
                      className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                      autoFocus
                    />
                    <button
                      onClick={handleSaveProfile}
                      disabled={!profileName.trim()}
                      className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-sm font-semibold"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setSaveFormOpen(false); setProfileName('') }}
                      className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setSaveFormOpen(true)}
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
                  >
                    <Save size={12} />
                    Save as profile...
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Actions ── */}
        <div className="flex gap-3">
          <button
            onClick={handleTest}
            disabled={loading}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded text-sm flex items-center gap-2"
          >
            {loading && <Spinner size={3} />}
            Test Connection
          </button>
          <button
            onClick={handleConnect}
            disabled={loading || !sourceDsn || !destDsn}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-sm font-semibold flex items-center gap-2"
          >
            {loading && <Spinner size={3} />}
            Connect
          </button>
        </div>

        <p className="text-xs text-gray-600">
          DSNs are stored in memory and persisted locally. Passwords are never logged.
        </p>
      </div>
    </div>
  )
}
