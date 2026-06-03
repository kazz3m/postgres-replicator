import { useState } from 'react'
import { connectionsApi, ConnectionStatus } from '../api/client'
import { Spinner } from '../components/Spinner'
import { Badge } from '../components/Badge'

interface Props { onConnected: (srcDsn: string, dstDsn: string, major: number) => void }

function getConnectionHint(error: string): string | null {
  if (error.includes('pg_hba.conf') || error.includes('no pg_hba.conf entry')) {
    return 'Hint: Add a replication entry to pg_hba.conf on source: "host replication user dest_ip/32 md5"'
  }
  if (error.includes('password authentication failed')) {
    return 'Hint: Check username and password in the DSN.'
  }
  if (error.includes('Connection refused')) {
    return 'Hint: Verify host, port, and that PostgreSQL accepts remote connections (listen_addresses).'
  }
  return null
}

export function ConnectionPage({ onConnected }: Props) {
  const [sourceDsn, setSourceDsn] = useState('postgresql://user:pass@source-host:5432/dbname')
  const [destDsn, setDestDsn] = useState('postgresql://user:pass@dest-host:5432/dbname')
  const [loading, setLoading] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionStatus | null>(null)
  const [error, setError] = useState('')

  async function handleTest() {
    setLoading(true); setError(''); setTestResult(null)
    try {
      const { data } = await connectionsApi.test({ source_dsn: sourceDsn, dest_dsn: destDsn })
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
      const { data } = await connectionsApi.connect({ source_dsn: sourceDsn, dest_dsn: destDsn })
      const major = data.source_version?.major ?? 0
      onConnected(sourceDsn, destDsn, major)
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-bold mb-8 text-blue-400">PostgreSQL Replication Manager</h1>

        <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-4">
          <div>
            <label className="block text-gray-400 mb-1 text-xs uppercase tracking-wider">Source DSN</label>
            <input
              type="text"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              value={sourceDsn}
              onChange={e => setSourceDsn(e.target.value)}
              placeholder="postgresql://user:pass@host:5432/db"
            />
            <p className="text-xs text-gray-500 mt-1">
              DSN is stored in memory only and never logged in plaintext.
            </p>
          </div>
          <div>
            <label className="block text-gray-400 mb-1 text-xs uppercase tracking-wider">Destination DSN</label>
            <input
              type="text"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              value={destDsn}
              onChange={e => setDestDsn(e.target.value)}
              placeholder="postgresql://user:pass@host:5432/db"
            />
            <p className="text-xs text-gray-500 mt-1">
              DSN is stored in memory only and never logged in plaintext.
            </p>
          </div>

          {error && (
            <div className="text-sm bg-red-950 border border-red-800 rounded p-3 space-y-1">
              <div className="text-red-400">{error}</div>
              {getConnectionHint(error) && (
                <div className="text-yellow-400 text-xs">{getConnectionHint(error)}</div>
              )}
            </div>
          )}

          {testResult && (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="text-gray-400 w-24">Source:</span>
                <Badge label={testResult.source_ok ? 'OK' : 'FAIL'} variant={testResult.source_ok ? 'green' : 'red'} />
                {testResult.source_version && <span className="text-gray-400">PG {testResult.source_version.major}</span>}
                {testResult.source_error && <span className="text-red-400 text-xs">{testResult.source_error}</span>}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-gray-400 w-24">Destination:</span>
                <Badge label={testResult.dest_ok ? 'OK' : 'FAIL'} variant={testResult.dest_ok ? 'green' : 'red'} />
                {testResult.dest_version && <span className="text-gray-400">PG {testResult.dest_version.major}</span>}
                {testResult.dest_error && <span className="text-red-400 text-xs">{testResult.dest_error}</span>}
              </div>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleTest}
              disabled={loading}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded text-sm flex items-center gap-2"
            >
              {loading && <Spinner size={3} />} Test Connection
            </button>
            <button
              onClick={handleConnect}
              disabled={loading || !sourceDsn || !destDsn}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-sm font-semibold flex items-center gap-2"
            >
              {loading && <Spinner size={3} />} Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
