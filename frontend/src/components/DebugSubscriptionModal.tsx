import { useState } from 'react'
import { replicationApi } from '../api/client'
import { Spinner } from './Spinner'
import { X, RefreshCw, AlertTriangle, CheckCircle, ShieldCheck, SkipForward } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  subName: string
  database: string
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

function KV({ label, value, warn, ok, mono = true }: { label: string; value: React.ReactNode; warn?: boolean; ok?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-xs py-0.5">
      <span className="text-gray-500 w-48 shrink-0">{label}</span>
      <span className={clsx(mono && 'font-mono', 'break-all', warn ? 'text-yellow-300' : ok ? 'text-green-400' : 'text-gray-200')}>
        {value ?? <span className="text-gray-600">—</span>}
      </span>
    </div>
  )
}

function fmtBytes(b: number | null | undefined): string {
  if (b == null || b < 0) return '—'
  if (b === 0) return '0 B'
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`
  return `${(b / 1024 ** 4).toFixed(2)} TB`
}

function truncate(s: string | null | undefined, n = 80): string {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function DebugSubscriptionModal({ subName, database, onClose }: Props) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [riApplying, setRiApplying] = useState(false)
  const [riResults, setRiResults] = useState<{ table: string; ok: boolean; error?: string }[] | null>(null)
  const [skipLsnModal, setSkipLsnModal] = useState(false)
  const [skipLsnValue, setSkipLsnValue] = useState('')
  const [skipLsnApplying, setSkipLsnApplying] = useState(false)
  const [skipLsnResult, setSkipLsnResult] = useState<{ ok: boolean; msg: string } | null>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await replicationApi.debugSubscription(subName, database)
      setData(res.data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (data === null && !loading && !error) load()

  type R = Record<string, unknown>
  const riIssues = (data?.replica_identity_issues as R[] | undefined) ?? []

  async function applyReplicaIdentityFull() {
    const tables = riIssues.filter(r => r.replica_identity !== 'full').map(r => String(r.qualified))
    if (!tables.length) return
    setRiApplying(true); setRiResults(null)
    try {
      const res = await replicationApi.setReplicaIdentityFull(tables, database)
      setRiResults(res.data.results)
      if (res.data.failed === 0) load() // refresh diagnostics
    } catch (e: unknown) {
      setRiResults([{ table: '—', ok: false, error: e instanceof Error ? e.message : String(e) }])
    } finally {
      setRiApplying(false)
    }
  }

  async function doSkipLsn() {
    if (!skipLsnValue.trim()) return
    setSkipLsnApplying(true); setSkipLsnResult(null)
    try {
      await replicationApi.skipLsn(subName, skipLsnValue.trim())
      setSkipLsnResult({ ok: true, msg: `Skipped to LSN ${skipLsnValue.trim()}. Apply worker will resume from the next transaction.` })
      setSkipLsnModal(false)
      setTimeout(load, 1500) // refresh after worker restarts
    } catch (e: unknown) {
      setSkipLsnResult({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setSkipLsnApplying(false)
    }
  }

  const sub         = data?.subscription as R | null | undefined
  const statRows    = (data?.stat_subscription as R[] | undefined) ?? []
  const applyWorker = statRows.find(r => r.rel_name == null)
  const syncWorkers = statRows.filter(r => r.rel_name != null)
  const origin      = (data?.replication_origin as R[] | undefined) ?? []
  const errCounts   = data?.error_counts as R | null | undefined
  const slot        = data?.replication_slot as R | null | undefined
  const statRepl    = data?.stat_replication as R | null | undefined
  const applyLocks  = (data?.apply_worker_locks as R[] | undefined) ?? []
  const walsenderBlockers = (data?.walsender_blockers as R[] | undefined) ?? []

  const applyDown   = !applyWorker?.pid
  const lagBytes    = slot?.lag_bytes as number | undefined
  const hasErrors   = errCounts && ((errCounts.apply_error_count as number) > 0 || (errCounts.sync_error_count as number) > 0)
  const blockedApplyLocks = applyLocks.filter(l => !l.granted)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <div>
            <span className="font-mono text-white font-semibold">{subName}</span>
            <span className="ml-3 text-xs text-gray-500">{database}</span>
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

        <div className="overflow-y-auto p-4 text-sm">
          {loading && !data && (
            <div className="flex items-center gap-2 text-gray-400 py-8 justify-center">
              <Spinner size={4} /> Loading diagnostics…
            </div>
          )}
          {error && <div className="flex items-center gap-2 text-red-400 py-4"><AlertTriangle size={14} />{error}</div>}

          {data && (
            <>
              {/* Alerts */}
              {applyDown && (
                <div className="mb-2 flex items-start gap-2 bg-red-950/60 border border-red-800 rounded p-3 text-xs text-red-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>Apply worker not running</strong> — subscription may be paused, crashed, or waiting for a conflict to resolve.</span>
                </div>
              )}
              {hasErrors && (
                <div className="mb-2 flex items-start gap-2 bg-red-950/60 border border-red-800 rounded p-3 text-xs text-red-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>Errors detected</strong> — apply errors: {String(errCounts?.apply_error_count)}, sync errors: {String(errCounts?.sync_error_count)}</span>
                </div>
              )}
              {blockedApplyLocks.length > 0 && (
                <div className="mb-2 flex items-start gap-2 bg-red-950/60 border border-red-800 rounded p-3 text-xs text-red-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>{blockedApplyLocks.length} lock(s) blocking apply worker on dest</strong></span>
                </div>
              )}
              {walsenderBlockers.length > 0 && (
                <div className="mb-2 flex items-start gap-2 bg-red-950/60 border border-red-800 rounded p-3 text-xs text-red-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>{walsenderBlockers.length} process(es) blocking WAL sender on source</strong></span>
                </div>
              )}
              {riIssues.length > 0 && (
                <div className="mb-2 flex items-start gap-2 bg-yellow-950/60 border border-yellow-800 rounded p-3 text-xs text-yellow-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>{riIssues.length} table(s) without PK or with REPLICA IDENTITY issues</strong> — UPDATE/DELETE may fail or not replicate correctly.</span>
                </div>
              )}
              {lagBytes != null && lagBytes > 10 * 1024 ** 3 && (
                <div className="mb-2 flex items-start gap-2 bg-yellow-950/60 border border-yellow-800 rounded p-3 text-xs text-yellow-300">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span><strong>WAL lag {fmtBytes(lagBytes)}</strong> — subscriber is significantly behind.</span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-6">
                {/* Left — source */}
                <div>
                  <Section title="Replication slot (source)">
                    {slot ? (
                      <>
                        <KV label="Slot name" value={String(slot.slot_name)} />
                        <KV label="Active" value={String(slot.active)} ok={!!slot.active} warn={!slot.active} />
                        <KV label="Active PID" value={slot.active_pid != null ? String(slot.active_pid) : undefined} />
                        <KV label="WAL lag" value={fmtBytes(slot.lag_bytes as number)}
                          warn={(slot.lag_bytes as number) > 100 * 1024 ** 2}
                          ok={(slot.lag_bytes as number) === 0} />
                        <KV label="Current WAL LSN" value={String(slot.current_wal_lsn)} />
                        <KV label="Confirmed flush LSN" value={String(slot.confirmed_flush_lsn)} />
                        <KV label="Restart LSN" value={String(slot.restart_lsn)} />
                      </>
                    ) : <span className="text-yellow-400 text-xs">Slot not found — may have been dropped</span>}
                  </Section>

                  <Section title="pg_stat_replication (source)">
                    {statRepl ? (
                      <>
                        <KV label="State" value={String(statRepl.state)}
                          ok={statRepl.state === 'streaming'}
                          warn={statRepl.state === 'catchup'} />
                        <KV label="Sync state" value={String(statRepl.sync_state)} />
                        <KV label="Client addr" value={String(statRepl.client_addr)} />
                        <KV label="Sent LSN" value={String(statRepl.sent_lsn)} />
                        <KV label="Write LSN" value={String(statRepl.write_lsn)} />
                        <KV label="Flush LSN" value={String(statRepl.flush_lsn)} />
                        <KV label="Replay LSN" value={String(statRepl.replay_lsn)} />
                        <KV label="Write lag" value={statRepl.write_lag ? String(statRepl.write_lag) : undefined} />
                        <KV label="Flush lag" value={statRepl.flush_lag ? String(statRepl.flush_lag) : undefined} />
                        <KV label="Replay lag" value={statRepl.replay_lag ? String(statRepl.replay_lag) : undefined} />
                        <KV label="Sent–replay diff" value={fmtBytes(statRepl.send_replay_diff as number)} warn={(statRepl.send_replay_diff as number) > 100 * 1024 ** 2} />
                      </>
                    ) : <span className="text-gray-500 text-xs">No active WAL sender for this subscription</span>}
                  </Section>

                  {/* Skip LSN */}
                  <Section title="Skip transaction (LSN)">
                    <p className="text-xs text-gray-500 mb-2">
                      Use when apply worker is stuck on an error (e.g. "could not map filenode to relation OID", duplicate key, missing row).
                      Skips one transaction at the given LSN. The recommended LSN to skip is <strong className="text-gray-300">Sent LSN</strong> from pg_stat_replication above — that is the transaction currently failing.
                    </p>
                    {skipLsnResult && (
                      <div className={clsx('mb-2 flex items-center gap-1.5 text-xs p-2 rounded border',
                        skipLsnResult.ok ? 'bg-green-950/40 border-green-800 text-green-300' : 'bg-red-950/40 border-red-800 text-red-300'
                      )}>
                        {skipLsnResult.ok ? <CheckCircle size={11} /> : <AlertTriangle size={11} />}
                        {skipLsnResult.msg}
                      </div>
                    )}
                    <button
                      onClick={() => {
                        const suggested = statRepl?.sent_lsn ? String(statRepl.sent_lsn) : ''
                        setSkipLsnValue(suggested)
                        setSkipLsnModal(true)
                        setSkipLsnResult(null)
                      }}
                      className="flex items-center gap-1.5 text-xs bg-orange-900/30 hover:bg-orange-800/50 border border-orange-700/60 text-orange-300 px-3 py-1.5 rounded transition-colors"
                    >
                      <SkipForward size={11} />
                      Skip LSN{statRepl?.sent_lsn ? ` (pre-fill: ${statRepl.sent_lsn})` : '…'}
                    </button>
                  </Section>

                  {walsenderBlockers.length > 0 && (
                    <Section title={`WAL sender blockers (${walsenderBlockers.length})`}>
                      <table className="w-full text-xs">
                        <thead><tr className="text-gray-500 border-b border-gray-700">
                          <th className="text-left py-1 pr-2">Hold PID</th>
                          <th className="text-left py-1 pr-2">Hold user</th>
                          <th className="text-left py-1 pr-2">Age(s)</th>
                          <th className="text-left py-1">Statement</th>
                        </tr></thead>
                        <tbody>
                          {walsenderBlockers.map((b, i) => (
                            <tr key={i} className="border-b border-gray-800 bg-red-950/20">
                              <td className="py-1 pr-2 font-mono">{String(b.hold_pid)}</td>
                              <td className="py-1 pr-2 text-red-300">{String(b.hold_user)}</td>
                              <td className="py-1 pr-2 font-mono">{b.wait_age_s != null ? String(b.wait_age_s) : '—'}</td>
                              <td className="py-1 font-mono text-[10px] text-gray-300" title={String(b.hold_stmt ?? '')}>{truncate(String(b.hold_stmt ?? ''), 60)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Section>
                  )}
                </div>

                {/* Right — dest */}
                <div>
                  <Section title="Subscription (dest)">
                    {sub ? (
                      <>
                        <KV label="Enabled" value={String(sub.subenabled)} ok={!!sub.subenabled} warn={!sub.subenabled} />
                        <KV label="Slot name" value={String(sub.subslotname)} />
                        <KV label="Publications" value={(sub.subpublications as string[])?.join(', ')} mono={false} />
                      </>
                    ) : <span className="text-gray-500 text-xs">Not found</span>}
                  </Section>

                  <Section title="Apply worker (pg_stat_subscription)">
                    {applyWorker ? (
                      <>
                        <KV label="PID" value={String(applyWorker.pid)} ok={!!applyWorker.pid} warn={!applyWorker.pid} />
                        <KV label="Received LSN" value={String(applyWorker.received_lsn ?? '—')} />
                        <KV label="Last msg send" value={String(applyWorker.last_msg_send_time ?? '—')} />
                        <KV label="Last msg receipt" value={String(applyWorker.last_msg_receipt_time ?? '—')} />
                        <KV label="Latest end LSN" value={String(applyWorker.latest_end_lsn ?? '—')} />
                        <KV label="Latest end time" value={String(applyWorker.latest_end_time ?? '—')} />
                      </>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-yellow-400">
                        <AlertTriangle size={11} /> Apply worker not running
                      </div>
                    )}
                  </Section>

                  {syncWorkers.length > 0 && (
                    <Section title={`Sync workers (${syncWorkers.length} active)`}>
                      {syncWorkers.map((w, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                          <CheckCircle size={10} className="text-blue-400 shrink-0" />
                          <span className="font-mono text-gray-300">{String(w.rel_name)}</span>
                          <span className="text-gray-500">pid:{String(w.pid)}</span>
                        </div>
                      ))}
                    </Section>
                  )}

                  {errCounts && (
                    <Section title="Error counts (pg_stat_subscription_stats)">
                      <KV label="Apply errors" value={String(errCounts.apply_error_count)}
                        warn={(errCounts.apply_error_count as number) > 0} ok={(errCounts.apply_error_count as number) === 0} />
                      <KV label="Sync errors" value={String(errCounts.sync_error_count)}
                        warn={(errCounts.sync_error_count as number) > 0} ok={(errCounts.sync_error_count as number) === 0} />
                    </Section>
                  )}

                  {origin.length > 0 && (
                    <Section title="Replication origin status">
                      {origin.map((o, i) => (
                        <div key={i} className="mb-1">
                          <KV label="Origin" value={String(o.external_id)} />
                          <KV label="Remote LSN" value={String(o.remote_lsn)} />
                          <KV label="Local LSN" value={String(o.local_lsn)} />
                        </div>
                      ))}
                    </Section>
                  )}
                </div>
              </div>

              {/* Apply worker locks */}
              {applyLocks.length > 0 && (
                <Section title={`Apply worker locks on dest (${applyLocks.length})`}>
                  <table className="w-full text-xs">
                    <thead><tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-1 pr-2">Mode</th>
                      <th className="text-left py-1 pr-2">Granted</th>
                      <th className="text-left py-1 pr-2">Relation</th>
                      <th className="text-left py-1 pr-2">State</th>
                      <th className="text-left py-1">Wait event</th>
                    </tr></thead>
                    <tbody>
                      {applyLocks.map((l, i) => (
                        <tr key={i} className={clsx('border-b border-gray-800', !l.granted && 'bg-red-950/30')}>
                          <td className="py-1 pr-2 font-mono text-yellow-300 text-[10px]">{String(l.mode)}</td>
                          <td className="py-1 pr-2">
                            <span className={l.granted ? 'text-green-400' : 'text-red-400 font-bold'}>
                              {l.granted ? '✓' : 'NO'}
                            </span>
                          </td>
                          <td className="py-1 pr-2 font-mono text-gray-300">{l.rel_name ? String(l.rel_name) : '—'}</td>
                          <td className="py-1 pr-2 text-gray-400">{String(l.state ?? '—')}</td>
                          <td className="py-1 text-gray-400">{l.wait_event ? `${l.wait_event_type}/${l.wait_event}` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Replica identity issues */}
              {riIssues.length > 0 && (
                <Section title={`Tables without PK or with REPLICA IDENTITY issues (${riIssues.length})`}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-gray-500">
                      Tables without a PRIMARY KEY cannot replicate UPDATE/DELETE unless REPLICA IDENTITY FULL is set.
                    </p>
                    {riIssues.some(r => r.replica_identity !== 'full') && (
                      <button
                        onClick={applyReplicaIdentityFull}
                        disabled={riApplying}
                        className="flex items-center gap-1.5 text-xs bg-blue-900/40 hover:bg-blue-800/60 border border-blue-700/60 text-blue-300 px-3 py-1 rounded disabled:opacity-50 transition-colors shrink-0 ml-4"
                        title="ALTER TABLE ... REPLICA IDENTITY FULL on all problematic tables on source"
                      >
                        {riApplying ? <Spinner size={2} /> : <ShieldCheck size={11} />}
                        Set REPLICA IDENTITY FULL ({riIssues.filter(r => r.replica_identity !== 'full').length} tables)
                      </button>
                    )}
                  </div>

                  {/* Apply results */}
                  {riResults && (
                    <div className="mb-2 space-y-0.5">
                      {riResults.map((r, i) => (
                        <div key={i} className={clsx('text-xs flex items-center gap-1.5',
                          r.ok ? 'text-green-400' : 'text-red-400'
                        )}>
                          {r.ok ? <CheckCircle size={10} /> : <AlertTriangle size={10} />}
                          <span className="font-mono">{r.table}</span>
                          {r.error && <span className="text-gray-500">— {r.error}</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  <table className="w-full text-xs">
                    <thead><tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-1 pr-4">Table</th>
                      <th className="text-left py-1 pr-4">Has PK</th>
                      <th className="text-left py-1">Replica identity</th>
                    </tr></thead>
                    <tbody>
                      {riIssues.map((r, i) => {
                        const noPk = !r.has_pk
                        const riNothing = r.replica_identity === 'nothing'
                        const riFull = r.replica_identity === 'full'
                        return (
                          <tr key={i} className={clsx('border-b border-gray-800',
                            riNothing ? 'bg-red-950/20' : noPk ? 'bg-yellow-950/20' : riFull ? 'bg-blue-950/10' : ''
                          )}>
                            <td className="py-1 pr-4 font-mono">{String(r.qualified)}</td>
                            <td className="py-1 pr-4">
                              {r.has_pk
                                ? <span className="text-green-400">✓ yes</span>
                                : <span className="text-red-400">✗ no</span>}
                            </td>
                            <td className="py-1 font-mono">
                              {riNothing
                                ? <span className="text-red-400">nothing ⚠ UPDATE/DELETE won't replicate</span>
                                : riFull
                                  ? <span className="text-blue-300">full ✓ set</span>
                                  : <span className="text-yellow-300">{String(r.replica_identity)} — no PK, needs FULL</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Errors */}
              {(['dest_error','source_error','stat_subscription_error','subscription_error',
                 'replication_origin_error','replication_slot_error','stat_replication_error',
                 'apply_worker_locks_error','walsender_blockers_error'] as const).some(k => data[k]) && (
                <div className="mt-2 space-y-0.5 text-xs text-red-400">
                  {(['dest_error','source_error','stat_subscription_error','subscription_error',
                     'replication_origin_error','replication_slot_error','stat_replication_error',
                     'apply_worker_locks_error','walsender_blockers_error'] as const).map(k =>
                    data[k] != null ? <div key={k}>{k.replace(/_/g,' ')}: {String(data[k])}</div> : null
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Skip LSN confirm modal */}
      {skipLsnModal && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/80" onClick={() => setSkipLsnModal(false)}>
          <div className="bg-gray-900 border border-orange-700 rounded-lg shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={20} className="text-orange-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-white mb-1">Skip transaction at LSN</h3>
                <p className="text-xs text-gray-400">
                  <code className="text-orange-300">ALTER SUBSCRIPTION "{subName}" SKIP (LSN '...')</code>
                </p>
              </div>
            </div>

            <div className="bg-gray-800 rounded p-3 mb-4 text-xs text-gray-300 space-y-1.5">
              <p>This will <strong className="text-white">skip one transaction</strong> at the specified LSN. The apply worker will resume from the next transaction.</p>
              <p className="text-yellow-300">⚠ Data in the skipped transaction will <strong>not</strong> be applied on destination. Use only when the transaction is known to be irrelevant (e.g. changes to a dropped table, test data) or when you accept the data divergence.</p>
              <p>Common cause: <code className="text-gray-200">could not map filenode to relation OID</code> — the table was dropped on source after the WAL was written.</p>
            </div>

            <div className="mb-4">
              <label className="block text-xs text-gray-400 mb-1">LSN to skip <span className="text-gray-600">(format: X/XXXXXXXX)</span></label>
              <input
                type="text"
                value={skipLsnValue}
                onChange={e => setSkipLsnValue(e.target.value)}
                placeholder="e.g. 168BE/62D787D0"
                className="w-full bg-gray-800 border border-gray-600 focus:border-orange-500 rounded px-3 py-2 text-sm font-mono text-white outline-none"
                autoFocus
              />
              {statRepl?.sent_lsn != null && (
                <p className="text-xs text-gray-500 mt-1">
                  Suggested: <button className="text-orange-400 hover:text-orange-300 underline font-mono" onClick={() => setSkipLsnValue(String(statRepl!.sent_lsn))}>{String(statRepl.sent_lsn)}</button> (Sent LSN — transaction currently failing)
                </p>
              )}
            </div>

            {skipLsnResult && !skipLsnResult.ok && (
              <div className="mb-3 flex items-center gap-1.5 text-xs text-red-300 bg-red-950/40 border border-red-800 rounded p-2">
                <AlertTriangle size={11} /> {skipLsnResult.msg}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSkipLsnModal(false)}
                className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 px-4 py-2 rounded"
              >Cancel</button>
              <button
                onClick={doSkipLsn}
                disabled={skipLsnApplying || !skipLsnValue.trim()}
                className="flex items-center gap-1.5 text-xs bg-orange-700 hover:bg-orange-600 text-white px-4 py-2 rounded disabled:opacity-40 transition-colors"
              >
                {skipLsnApplying ? <Spinner size={2} /> : <SkipForward size={11} />}
                Confirm Skip LSN
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
