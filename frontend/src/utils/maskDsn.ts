/**
 * Masks the password in a postgresql:// URI.
 * "postgresql://user:secret@host:5432/db" → "postgresql://user:***@host:5432/db"
 * Returns the original string unchanged if it cannot be parsed as a URL.
 */
export function maskDsn(dsn: string): string {
  if (!dsn) return dsn
  try {
    const url = new URL(dsn)
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return dsn
  }
}

/**
 * Returns a short display label showing only host:port/dbname, no credentials.
 * "postgresql://user:secret@prod-host:5432/mydb" → "prod-host:5432/mydb"
 */
export function shortDsn(dsn: string): string {
  if (!dsn) return ''
  try {
    const url = new URL(dsn)
    const port = url.port ? `:${url.port}` : ''
    const db = url.pathname.replace(/^\//, '')
    return `${url.hostname}${port}/${db}`
  } catch {
    return dsn
  }
}
