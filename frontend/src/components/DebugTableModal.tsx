import { useState } from 'react'
import { replicationApi } from '../api/client'
import { Spinner } from './Spinner'
import { X, RefreshCw, AlertTriangle, CheckCircle, Info } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  schema: string
  table: string
  database: string
  subName: string
  onClose: () => void
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{title}</div>
      {children}
    </div>
  )
}

function KV({ label, value, warn, ok }: { label: string; value: React.ReactNode; warn?: boolean; ok?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-xs py-0.5">
      <span className="text-gray-500 w-44 shrink-0">{label}</span>
      <span className={clsx('font-mono break-all', warn ? 'text-yellow-300' : ok ? 'text-green-400' : 'text-gray-200')}>
        {value ?? <span className="text-gray-600">—</span>}
      </span>
    </div>
  )
}

function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '—'
  if (b <= 0) return '0 B'
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`
  return `${(b / 1024 ** 4).toFixed(2)} TB`
}

const STATE_LABELS: Record<string, string> = {
  i: 'initializing', d: 'copying', f: 'catching up', s: 'synced', r: 'ready', e: 'error',
}

function LocksTable({ locks }: { locks: Record<string, unknown>[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500 border-b border-gray-700">
          <th className="text-left py-1 pr-2">PID</th>
          <th className="text-left py-1 pr-2">User</th>
          <th className="text-left py-1 pr-2">Mode</th>
          <th className="text-left py-1 pr-2">Granted</th>
          <th className="text-left py-1 pr-2">Age(s)</th>
          <th className="text-left py-1">Query</th>
        </tr>
      </thead>
      <tbody>
        {locks.map((l, i) => (
          <tr key={i} className={clsx('border-b border-gray-800', !l.granted && 'bg-red-950/30')}>
            <td className="py-1 pr-2 font-mono">{String(l.pid)}</td>
            <td className="py-1 pr-2 text-gray-400">{l.usename ? String(l.usename) : '—'}</td>
            <td className="py-1 pr-2 font-mono text-yellow-300 text-[10px]">{String(l.mode)}</td>
            <td className="py-1 pr-2">
              <span className={l.granted ? 'text-green-400' : 'text-red-400 font-bold'}>
                {l.granted ? '✓' : 'NO'}
              </span>
            </td>
            <td className="py-1 pr-2 font-mono">{l.query_age_s != null ? String(l.query_age_s) : '—'}</td>
            <td className="py-1 text-gray-400 truncate max-w-[200px]" title={String(l.query ?? '')}>{String(l.query ?? '—')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function DebugTableModal({ schema, table, database, subName, onClose }: Props) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await replicationApi.debugTable(schema, table, database, subName)
      setData(res.data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // auto-load on mount
  if (data === null && !loading && !error) load()

  const subRel = data?.subscription_rel as Record<string, unknown> | null | undefined
  const copyProgress = data?.copy_progress as Record<string, unknown> | null | undefined
  const destLocks = (data?.locks as Record<string, unknown>[] | undefined) ?? []
  const srcLocks = (data?.source_locks as Record<string, unknown>[] | undefined) ?? []
  const replBlockers = (data?.replication_blockers as Record<string, unknown>[] | undefined) ?? []
  const destTable = data?.dest_table as Record<string, unknown> | null | undefined
  const srcTable = data?.source_table as Record<string, unknown> | null | undefined
  const pubs = (data?.publications as Record<string, unknown>[] | undefined) ?? []
  const worker = data?.subscription_worker as Record<string, unknown> | null | undefined
  const slot = data?.replication_slot as Record<string, unknown> | null | undefined
  const replicaId = data?.replica_identity as string | undefined
  const schemaDiff = (data?.schema_diff as Record<string, unknown>[] | undefined) ?? []

  const blockedDestLocks = destLocks.filter(l => !l.granted)
  const blockedSrcLocks = srcLocks.filter(l => !l.granted)
  const schemaMismatches = schemaDiff.filter(c => !c.match)
  const stateRaw = subRel?.srsubstate as string | undefined
  const stateLabel = stateRaw ? (STATE_LABELS[stateRaw] ?? stateRaw) : undefined

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <div>
            <span className="font-mono text-gray-200 font-semibold">{schema}.<span className="text-white">{table}</span></span>
            <span className="ml-3 text-xs text-gray-500">{database} · {subName}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={load} disabled={loading}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded border border-gray-700 hover:border-gray-500 disabled:opacity-40">
              {loading ? <Spinner size={2} /> : <RefreshCw size={11} />}
              Refresh
            </button>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-200"><X size={16} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4 text-sm">
          {loading && !data && (
            <div className="flex items-center gap-2 text-gray-400 py-8 justify-center">
              <Spinner size={4} /> Loading diagnostics…
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 text-red-400 py-4">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {data && (
            <>
              {/* Alerts */}
              {blockedDestLocks.length > 0 && (
                <div className="mb-2 flex items-start gap-2 bg-red-950/60 border border-red-800 rounded p-3 text-xs text-red-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>{blockedDestLocks.length} blocked lock(s) on destination</strong> — a long-running transaction may be preventing COPY from progressing.</span>
                </div>
              )}
              {blockedSrcLocks.length > 0 && (
                <div className="mb-2 flex items-start gap-2 bg-red-950/60 border border-red-800 rounded p-3 text-xs text-red-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>{blockedSrcLocks.length} blocked lock(s) on source</strong> — may be blocking replication reads.</span>
                </div>
              )}
              {replBlockers.length > 0 && (
                <div className="mb-2 flex items-start gap-2 bg-red-950/60 border border-red-800 rounded p-3 text-xs text-red-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>{replBlockers.length} process(es) blocking replication worker on source</strong> — CREATE_REPLICATION_SLOT / COPY is waiting.</span>
                </div>
              )}
              {schemaMismatches.length > 0 && (
                <div className="mb-2 flex items-start gap-2 bg-yellow-950/60 border border-yellow-800 rounded p-3 text-xs text-yellow-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>{schemaMismatches.length} column mismatch(es)</strong> between source and destination schema.</span>
                </div>
              )}
              {!destTable && (
                <div className="mb-4 flex items-start gap-2 bg-yellow-950/60 border border-yellow-800 rounded p-3 text-xs text-yellow-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  Table does not exist on destination.
                </div>
              )}
              {pubs.length === 0 && (
                <div className="mb-4 flex items-start gap-2 bg-yellow-950/60 border border-yellow-800 rounded p-3 text-xs text-yellow-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  Table is not in any publication on source.
                </div>
              )}
              {replicaId === 'nothing' && (
                <div className="mb-4 flex items-start gap-2 bg-yellow-950/60 border border-yellow-800 rounded p-3 text-xs text-yellow-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  REPLICA IDENTITY is NOTHING — UPDATE/DELETE will not replicate.
                </div>
              )}

              <div className="grid grid-cols-2 gap-6">
                {/* Left: source */}
                <div>
                  <Section title="Source">
                    {srcTable ? (
                      <>
                        <KV label="OID" value={String(srcTable.oid)} />
                        <KV label="Size (relpages)" value={fmtBytes(srcTable.size_bytes as number)} />
                        <KV label="Row estimate" value={(srcTable.reltuples as number)?.toLocaleString()} />
                        <KV label="relkind" value={String(srcTable.relkind)} />
                        <KV label="Is partition" value={String(srcTable.relispartition)} />
                        {srcTable.partkeydef && <KV label="Partition key" value={String(srcTable.partkeydef)} />}
                        {srcTable.partbound && <KV label="Partition bound" value={String(srcTable.partbound)} />}
                        <KV label="Replica identity" value={replicaId}
                          warn={replicaId === 'nothing' || replicaId === 'full'}
                          ok={replicaId?.startsWith('default')} />
                      </>
                    ) : <span className="text-yellow-400 text-xs">Table not found on source</span>}
                  </Section>

                  <Section title="Publications">
                    {pubs.length > 0
                      ? pubs.map((p, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-xs text-green-400 py-0.5">
                            <CheckCircle size={10} /> {String(p.pubname)}
                          </div>
                        ))
                      : <span className="text-yellow-400 text-xs">Not in any publication</span>
                    }
                  </Section>

                  <Section title="Replication slot">
                    {slot ? (
                      <>
                        <KV label="Slot name" value={String(slot.slot_name)} />
                        <KV label="Active" value={String(slot.active)} ok={!!slot.active} warn={!slot.active} />
                        <KV label="WAL lag" value={fmtBytes(slot.lag_bytes as number)}
                          warn={(slot.lag_bytes as number) > 100 * 1024 * 1024} />
                        <KV label="Confirmed flush LSN" value={String(slot.confirmed_flush_lsn)} />
                      </>
                    ) : <span className="text-gray-500 text-xs">Slot not found</span>}
                  </Section>
                </div>

                {/* Right: dest */}
                <div>
                  <Section title="Destination table">
                    {destTable ? (
                      <>
                        <KV label="OID" value={String(destTable.oid)} />
                        <KV label="Size (live)" value={fmtBytes(destTable.size_bytes as number)} />
                        <KV label="Row estimate" value={(destTable.reltuples as number)?.toLocaleString()} />
                        <KV label="relkind" value={String(destTable.relkind)} />
                      </>
                    ) : <span className="text-yellow-400 text-xs">Table not found on destination</span>}
                  </Section>

                  <Section title="Subscription state">
                    {subRel ? (
                      <>
                        <KV label="srsubstate" value={`${stateRaw} — ${stateLabel}`}
                          ok={stateRaw === 'r' || stateRaw === 's'}
                          warn={stateRaw === 'e' || stateRaw === 'i'} />
                        <KV label="srsublsn" value={String(subRel.srsublsn ?? '—')} />
                      </>
                    ) : <span className="text-gray-500 text-xs">Not found in pg_subscription_rel</span>}
                  </Section>

                  <Section title="COPY progress (pg_stat_progress_copy)">
                    {copyProgress ? (
                      <>
                        <KV label="PID" value={String(copyProgress.pid)} />
                        <KV label="Phase" value={String(copyProgress.phase)} />
                        <KV label="Tuples processed" value={(copyProgress.tuples_processed as number)?.toLocaleString()} />
                        <KV label="Bytes processed" value={fmtBytes(copyProgress.bytes_processed as number)} />
                      </>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-gray-500">
                        <Info size={11} /> No active COPY process for this table
                      </div>
                    )}
                  </Section>

                  <Section title="Subscription worker">
                    {worker ? (
                      <>
                        <KV label="PID" value={String(worker.pid)} ok={!!worker.pid} warn={!worker.pid} />
                        <KV label="Received LSN" value={String(worker.received_lsn ?? '—')} />
                        <KV label="Last message" value={String(worker.last_msg_receipt_time ?? '—')} />
                      </>
                    ) : <span className="text-yellow-400 text-xs">Worker not running</span>}
                  </Section>
                </div>
              </div>

              {/* Replication blockers on source */}
              {replBlockers.length > 0 && (
                <Section title={`Replication blockers on source (${replBlockers.length})`}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-700">
                        <th className="text-left py-1 pr-3">Wait PID</th>
                        <th className="text-left py-1 pr-3">Wait user</th>
                        <th className="text-left py-1 pr-3">Hold PID</th>
                        <th className="text-left py-1 pr-3">Hold user</th>
                        <th className="text-left py-1 pr-3">Age (s)</th>
                        <th className="text-left py-1">Waiting statement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {replBlockers.map((b, i) => (
                        <tr key={i} className="border-b border-gray-800 bg-red-950/20">
                          <td className="py-1 pr-3 font-mono">{String(b.wait_pid)}</td>
                          <td className="py-1 pr-3 text-yellow-300">{String(b.wait_user)}</td>
                          <td className="py-1 pr-3 font-mono">{String(b.hold_pid)}</td>
                          <td className="py-1 pr-3 text-red-300">{String(b.hold_user)}</td>
                          <td className="py-1 pr-3 font-mono">{b.wait_age_s != null ? String(b.wait_age_s) : '—'}</td>
                          <td className="py-1 text-gray-300 truncate max-w-xs font-mono text-[10px]" title={String(b.wait_statement ?? '')}>{String(b.wait_statement ?? '—')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Locks tables — source + dest side by side */}
              {(srcLocks.length > 0 || destLocks.length > 0) && (
                <div className="grid grid-cols-2 gap-6">
                  <Section title={`Locks on source (${srcLocks.length})`}>
                    {srcLocks.length === 0
                      ? <span className="text-xs text-gray-500">No locks</span>
                      : <LocksTable locks={srcLocks} />}
                  </Section>
                  <Section title={`Locks on destination (${destLocks.length})`}>
                    {destLocks.length === 0
                      ? <span className="text-xs text-gray-500">No locks</span>
                      : <LocksTable locks={destLocks} />}
                  </Section>
                </div>
              )}

              {/* Schema diff */}
              {schemaDiff.length > 0 && (
                <Section title={`Schema diff (${schemaMismatches.length} mismatch${schemaMismatches.length !== 1 ? 'es' : ''})`}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-700">
                        <th className="text-left py-1 pr-3">Column</th>
                        <th className="text-left py-1 pr-3">Source type</th>
                        <th className="text-left py-1 pr-3">Dest type</th>
                        <th className="text-left py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schemaDiff.map((c, i) => {
                        const missing = c.missing_on_dest
                        const extra = c.extra_on_dest
                        const mismatch = !c.match && !missing && !extra
                        return (
                          <tr key={i} className={clsx('border-b border-gray-800',
                            missing ? 'bg-red-950/20' : extra ? 'bg-blue-950/20' : mismatch ? 'bg-yellow-950/20' : ''
                          )}>
                            <td className="py-1 pr-3 font-mono text-gray-200">{String(c.column_name)}</td>
                            <td className="py-1 pr-3 font-mono text-gray-300">{c.source_type ? String(c.source_type) : <span className="text-gray-600">—</span>}</td>
                            <td className="py-1 pr-3 font-mono text-gray-300">{c.dest_type ? String(c.dest_type) : <span className="text-gray-600">—</span>}</td>
                            <td className="py-1 font-mono">
                              {missing ? <span className="text-red-400">missing on dest</span>
                               : extra ? <span className="text-blue-400">extra on dest</span>
                               : mismatch ? <span className="text-yellow-400">type mismatch</span>
                               : <span className="text-green-500">✓</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Errors */}
              {(['dest_error','source_error','copy_progress_error','locks_error','source_locks_error','dest_table_error','subscription_rel_error','subscription_worker_error','schema_diff_error'] as const).some(k => data[k]) && (
                <div className="mt-2 space-y-0.5 text-xs text-red-400">
                  {(['dest_error','source_error','copy_progress_error','locks_error','source_locks_error','dest_table_error','subscription_rel_error','subscription_worker_error','schema_diff_error'] as const).map(k =>
                    data[k] != null ? <div key={k}>{k.replace(/_/g,' ')}: {String(data[k])}</div> : null
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
