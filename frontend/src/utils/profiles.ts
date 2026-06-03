const STORAGE_KEY = 'pg_sync_profiles'

export interface ConnectionProfile {
  id: string
  name: string
  source_dsn: string
  source_repl_dsn: string
  dest_dsn: string
  created_at: string
  last_used?: string          // ISO — updated every time workspace is opened
  selected_tables?: string[]  // persisted table selection for this workspace
  selected_schemas?: string[] // persisted schema selection for this workspace
}

export function loadProfiles(): ConnectionProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveProfile(
  p: Omit<ConnectionProfile, 'id' | 'created_at'>
): ConnectionProfile {
  const profile: ConnectionProfile = {
    ...p,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  }
  const existing = loadProfiles()
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...existing, profile]))
  return profile
}

export function updateProfile(id: string, patch: Partial<Omit<ConnectionProfile, 'id' | 'created_at'>>): void {
  const profiles = loadProfiles().map(p => p.id === id ? { ...p, ...patch } : p)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
}

export function touchProfile(id: string): void {
  updateProfile(id, { last_used: new Date().toISOString() })
}

export function deleteProfile(id: string): void {
  const profiles = loadProfiles().filter(p => p.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
}

/** Returns profiles sorted by last_used desc, then created_at desc. */
export function sortedProfiles(): ConnectionProfile[] {
  return loadProfiles().sort((a, b) => {
    const ta = a.last_used ?? a.created_at
    const tb = b.last_used ?? b.created_at
    return tb.localeCompare(ta)
  })
}
