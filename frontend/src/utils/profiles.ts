const STORAGE_KEY = 'pg_sync_profiles'

export interface ConnectionProfile {
  id: string
  name: string
  source_dsn: string
  source_repl_dsn: string
  dest_dsn: string
  created_at: string
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

export function deleteProfile(id: string): void {
  const profiles = loadProfiles().filter(p => p.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
}
