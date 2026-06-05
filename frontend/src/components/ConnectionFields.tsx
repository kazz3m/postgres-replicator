import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export interface ConnFields {
  host: string
  port: string
  database: string
  user: string
  password: string
  flags: string   // appended as ?key=val&key=val
}

export const emptyFields = (): ConnFields => ({
  host: '', port: '5432', database: '', user: '', password: '', flags: '',
})

/** Build a postgresql:// DSN from structured fields. Returns '' if host/db/user missing. */
export function buildDsn(f: ConnFields): string {
  if (!f.host || !f.database || !f.user) return ''
  const encodedPass = f.password ? `:${encodeURIComponent(f.password)}` : ''
  const port = f.port && f.port !== '5432' ? `:${f.port}` : ':5432'
  const base = `postgresql://${encodeURIComponent(f.user)}${encodedPass}@${f.host}${port}/${encodeURIComponent(f.database)}`
  return f.flags.trim() ? `${base}?${f.flags.trim()}` : base
}

/** Parse an existing DSN back into structured fields (best-effort). */
export function parseDsn(dsn: string): ConnFields {
  try {
    const url = new URL(dsn)
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      flags: url.search.replace(/^\?/, ''),
    }
  } catch {
    return emptyFields()
  }
}

interface Props {
  label: string
  labelColor?: string   // tailwind text-* class
  hint?: string
  fields: ConnFields
  onChange: (f: ConnFields) => void
}

function Field({
  label, value, onChange, placeholder, type = 'text', mono = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-xs text-gray-500 uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm
          focus:outline-none focus:border-blue-500 ${mono ? 'font-mono' : ''}`}
      />
    </div>
  )
}

export function ConnectionFields({ label, labelColor = 'text-blue-400', hint, fields, onChange }: Props) {
  const [showPass, setShowPass] = useState(false)

  function set(patch: Partial<ConnFields>) {
    onChange({ ...fields, ...patch })
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-3">
      <div className={`text-xs font-semibold uppercase tracking-wider ${labelColor}`}>
        {label}
      </div>
      {hint && <p className="text-xs text-gray-500 -mt-1">{hint}</p>}

      {/* Row 1: host + port */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field label="Host" value={fields.host} onChange={v => set({ host: v })}
            placeholder="db.example.com" mono />
        </div>
        <Field label="Port" value={fields.port} onChange={v => set({ port: v })}
          placeholder="5432" mono />
      </div>

      {/* Row 2: database */}
      <Field label="Database" value={fields.database} onChange={v => set({ database: v })}
        placeholder="mydb" mono />

      {/* Row 3: user + password */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="User" value={fields.user} onChange={v => set({ user: v })}
          placeholder="postgres" mono />
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-gray-500 uppercase tracking-wider">Password</label>
          <div className="relative">
            <input
              type={showPass ? 'text' : 'password'}
              value={fields.password}
              onChange={e => set({ password: e.target.value })}
              placeholder="••••••••"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 pr-9
                text-sm font-mono focus:outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={() => setShowPass(s => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              tabIndex={-1}
            >
              {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Row 4: flags (optional) */}
      <div className="flex flex-col gap-0.5">
        <label className="text-xs text-gray-500 uppercase tracking-wider">
          Flags <span className="normal-case text-gray-600">(appended as ?… — optional)</span>
        </label>
        <input
          type="text"
          value={fields.flags}
          onChange={e => set({ flags: e.target.value })}
          placeholder="sslmode=require&connect_timeout=10"
          className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5
            text-sm font-mono focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Live DSN preview (password masked) */}
      {fields.host && fields.database && fields.user && (
        <div className="text-xs font-mono text-gray-600 bg-gray-800/50 rounded px-3 py-1.5 break-all">
          {buildDsn({ ...fields, password: fields.password ? '***' : '' })}
        </div>
      )}
    </div>
  )
}
