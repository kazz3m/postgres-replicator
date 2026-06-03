import { api } from '../api/client'

export interface ConnectionProfile {
  id: string
  name: string
  source_dsn: string
  source_repl_dsn: string
  dest_dsn: string
  created_at: string
  last_used?: string
  selected_tables?: string[]
  selected_schemas?: string[]
}

export async function loadProfiles(): Promise<ConnectionProfile[]> {
  const res = await api.get<ConnectionProfile[]>('/profiles')
  return res.data
}

export async function saveProfile(
  p: Omit<ConnectionProfile, 'id' | 'created_at'>
): Promise<ConnectionProfile> {
  const res = await api.post<ConnectionProfile>('/profiles', p)
  return res.data
}

export async function updateProfile(
  id: string,
  patch: Partial<Omit<ConnectionProfile, 'id' | 'created_at'>>
): Promise<void> {
  await api.patch(`/profiles/${id}`, patch)
}

export async function touchProfile(id: string): Promise<void> {
  await api.patch(`/profiles/${id}`, { last_used: new Date().toISOString() })
}

export async function deleteProfile(id: string): Promise<void> {
  await api.delete(`/profiles/${id}`)
}
