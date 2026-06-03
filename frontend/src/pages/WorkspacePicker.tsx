import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusCircle, FolderOpen, Trash2, ChevronRight, Activity, Clock } from 'lucide-react'
import { loadProfiles, deleteProfile, touchProfile, ConnectionProfile } from '../utils/profiles'
import { shortDsn } from '../utils/maskDsn'
import { connectionsApi, replicationApi, SubscriptionInfo, TableReplicationProgress, WorkerStat } from '../api/client'
import { Spinner } from '../components/Spinner'
import { Badge } from '../components/Badge'

export interface WorkspaceSnapshot {
  subscriptions: SubscriptionInfo[]
  progress: TableReplicationProgress[]
  workerStats: WorkerStat[]
}

interface Props {
  onNewWorkspace: () => void
  onLoadWorkspace: (profile: ConnectionProfile, snapshot: WorkspaceSnapshot) => void
}

function statusVariant(s: string): 'green' | 'yellow' | 'blue' | 'red' | 'gray' {
  if (s === 'synced' || s === 'ready') return 'green'
  if (s === 'copying') return 'blue'
  if (s === 'initializing') return 'yellow'
  if (s === 'error') return 'red'
  return 'gray'
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function ProgressBar({ pct }: { pct: number | null | undefined }) {
  const v = Math.min(100, pct ?? 0)
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-800 rounded-full h-1">
        <div className="h-1 rounded-full bg-blue-500 transition-all" style={{ width: `${v}%` }} />
      </div>
      <span className="text-gray-500 text-xs w-8 text-right">
        {pct != null ? `${Math.round(pct)}%` : '–'}
      </span>
    </div>
  )
}

async function fetchSnapshot(): Promise<WorkspaceSnapshot> {
  const [subsRes, progressRes, workerRes] = await Promise.allSettled([
    replicationApi.listSubscriptionsTyped(),
    replicationApi.progress(),
    replicationApi.workerStats(),
  ])
  return {
    subscriptions: subsRes.status === 'fulfilled' ? subsRes.value.data : [],
    progress: progressRes.status === 'fulfilled' ? progressRes.value.data : [],
    workerStats: workerRes.status === 'fulfilled' ? workerRes.value.data : [],
  }
}

export function WorkspacePicker({ onNewWorkspace, onLoadWorkspace }: Props) {
  const queryClient = useQueryClient()

  const { data: profiles = [], isLoading: profilesLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: loadProfiles,
  })

  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; msg: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; snapshot: WorkspaceSnapshot } | null>(null)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)

  async function handleLoad(profile: ConnectionProfile) {
    setLoading(profile.id)
    setError(null)
    try {
      await connectionsApi.connect({
        source_dsn: profile.source_dsn,
        dest_dsn: profile.dest_dsn,
        source_repl_dsn: profile.source_repl_dsn || undefined,
      })
      const snapshot = await fetchSnapshot()
      await touchProfile(profile.id)
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      onLoadWorkspace(profile, snapshot)
    } catch (e: any) {
      setError({ id: profile.id, msg: e.response?.data?.detail || e.message || 'Connection failed' })
    } finally {
      setLoading(null)
    }
  }

  async function handlePreview(profile: ConnectionProfile) {
    if (preview?.id === profile.id) { setPreview(null); return }
    setPreviewLoading(profile.id)
    try {
      await connectionsApi.connect({
        source_dsn: profile.source_dsn,
        dest_dsn: profile.dest_dsn,
        source_repl_dsn: profile.source_repl_dsn || undefined,
      })
      const snapshot = await fetchSnapshot()
      setPreview({ id: profile.id, snapshot })
    } catch {
      setPreview({ id: profile.id, snapshot: { subscriptions: [], progress: [], workerStats: [] } })
    } finally {
      setPreviewLoading(null)
    }
  }

  async function handleDelete(id: string) {
    await deleteProfile(id)
    queryClient.invalidateQueries({ queryKey: ['profiles'] })
    setDeleteConfirm(null)
    if (preview?.id === id) setPreview(null)
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-gray-950">
      <div className="w-full max-w-2xl space-y-6">

        <div>
          <h1 className="text-2xl font-bold text-blue-400">PG Replication Manager</h1>
          <p className="text-gray-500 text-sm mt-1">Choose a workspace to continue or start a new one.</p>
        </div>

        {/* New workspace */}
        <button
          onClick={onNewWorkspace}
          className="w-full flex items-center gap-3 bg-gray-900 border border-gray-700 hover:border-blue-600 hover:bg-gray-800 rounded-lg px-5 py-4 transition-colors group"
        >
          <PlusCircle size={20} className="text-blue-400 shrink-0" />
          <div className="text-left flex-1">
            <div className="font-semibold text-gray-200 group-hover:text-white">New Workspace</div>
            <div className="text-xs text-gray-500">Configure new source and destination connections</div>
          </div>
          <ChevronRight size={16} className="text-gray-600 group-hover:text-gray-400" />
        </button>

        {/* Saved workspaces */}
        {profilesLoading && (
          <div className="flex items-center gap-2 text-gray-500 text-sm py-2">
            <Spinner size={3} /> Loading workspaces...
          </div>
        )}

        {!profilesLoading && profiles.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-gray-500 px-1">
              <FolderOpen size={12} />
              Saved Workspaces
            </div>

            {profiles.map(profile => {
              const isLoading = loading === profile.id
              const isPreviewing = previewLoading === profile.id
              const thisPreview = preview?.id === profile.id ? preview.snapshot : null
              const thisError = error?.id === profile.id ? error.msg : null

              return (
                <div key={profile.id} className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-gray-200 truncate">{profile.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5 space-x-3">
                        <span>
                          <span className="text-gray-400">src</span> {shortDsn(profile.source_dsn)}
                          {profile.source_repl_dsn && <span className="text-blue-500 ml-1">[+repl]</span>}
                        </span>
                        <span>
                          <span className="text-gray-400">dst</span> {shortDsn(profile.dest_dsn)}
                        </span>
                      </div>
                    </div>

                    {profile.last_used && (
                      <div className="flex items-center gap-1 text-xs text-gray-600 shrink-0">
                        <Clock size={10} />
                        {relativeTime(profile.last_used)}
                      </div>
                    )}

                    <button
                      onClick={() => handlePreview(profile)}
                      disabled={!!loading || !!previewLoading}
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded disabled:opacity-40 shrink-0"
                      title="Preview active replications"
                    >
                      {isPreviewing ? <Spinner size={3} /> : <Activity size={12} />}
                      Preview
                    </button>

                    <button
                      onClick={() => handleLoad(profile)}
                      disabled={!!loading || !!previewLoading}
                      className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 border border-blue-800 hover:border-blue-600 px-3 py-1.5 rounded font-semibold disabled:opacity-40 shrink-0"
                    >
                      {isLoading ? <Spinner size={3} /> : null}
                      Open
                    </button>

                    {deleteConfirm === profile.id ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleDelete(profile.id)}
                          className="text-xs text-red-400 border border-red-800 px-2 py-1 rounded hover:bg-red-950"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="text-xs text-gray-400 border border-gray-700 px-2 py-1 rounded"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(profile.id)}
                        disabled={!!loading}
                        className="text-gray-600 hover:text-red-400 p-1 rounded hover:bg-red-950/20 disabled:opacity-40 shrink-0"
                        title="Delete workspace"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>

                  {thisError && (
                    <div className="px-4 py-2 text-xs text-red-400 bg-red-950/30 border-t border-red-900">
                      {thisError}
                    </div>
                  )}

                  {thisPreview && (
                    <div className="border-t border-gray-700 bg-gray-950/50">
                      {thisPreview.subscriptions.length === 0 && thisPreview.progress.length === 0 ? (
                        <div className="px-4 py-3 text-xs text-gray-500">
                          No active subscriptions found on destination.
                        </div>
                      ) : (
                        <div className="p-4 space-y-3">
                          {thisPreview.subscriptions.length > 0 && (
                            <div>
                              <div className="text-xs text-gray-400 font-semibold mb-1.5">Subscriptions</div>
                              <div className="space-y-1">
                                {thisPreview.subscriptions.map(sub => {
                                  const worker = thisPreview.workerStats.find(w => w.subname === sub.subname)
                                  const isAlive = worker?.pid != null
                                  return (
                                    <div key={sub.subname} className="flex items-center gap-2 text-xs">
                                      <span className="font-mono text-gray-300 w-40 truncate">{sub.subname}</span>
                                      <Badge label={sub.subenabled ? 'enabled' : 'disabled'} variant={sub.subenabled ? 'green' : 'red'} />
                                      {sub.subenabled && (
                                        <Badge label={isAlive ? 'worker running' : 'worker stopped'} variant={isAlive ? 'green' : 'red'} />
                                      )}
                                      <span className="text-gray-600">{sub.subpublications.join(', ')}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )}

                          {thisPreview.progress.length > 0 && (
                            <div>
                              <div className="text-xs text-gray-400 font-semibold mb-1.5">
                                Table Progress ({thisPreview.progress.length} tables)
                              </div>
                              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                                {thisPreview.progress.map(row => (
                                  <div
                                    key={`${row.schema_name}.${row.table_name}`}
                                    className="grid grid-cols-[1fr_60px_120px] items-center gap-2 text-xs"
                                  >
                                    <span className="font-mono text-gray-400 truncate">
                                      {row.schema_name}.{row.table_name}
                                    </span>
                                    <Badge label={row.status} variant={statusVariant(row.status)} />
                                    <ProgressBar pct={row.progress_pct} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!profilesLoading && profiles.length === 0 && (
          <p className="text-center text-gray-600 text-sm py-4">
            No saved workspaces yet. Create one by connecting and saving a profile.
          </p>
        )}
      </div>
    </div>
  )
}
