import { supabase } from './supabase'

export interface InboxUser {
  id: string
  email: string
  access_token: string | null
  refresh_token: string | null
  token_expiry: string | null
  last_sync: string | null
  active: boolean
}

export async function upsertUser(
  email: string,
  accessToken: string,
  refreshToken: string | null,
  tokenExpiry: Date | null
): Promise<void> {
  const { error } = await supabase.from('inbox_users').upsert(
    {
      email,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expiry: tokenExpiry?.toISOString() ?? null,
      active: true,
    },
    { onConflict: 'email' }
  )
  if (error) throw new Error(error.message)
}

export async function getUserByEmail(email: string): Promise<InboxUser | null> {
  const { data, error } = await supabase
    .from('inbox_users')
    .select('*')
    .eq('email', email)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

export async function getAllActiveUsers(): Promise<InboxUser[]> {
  const { data, error } = await supabase
    .from('inbox_users')
    .select('*')
    .eq('active', true)
    .not('access_token', 'is', null)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function updateLastSync(email: string): Promise<void> {
  const { error } = await supabase
    .from('inbox_users')
    .update({ last_sync: new Date().toISOString() })
    .eq('email', email)
  if (error) throw new Error(error.message)
}
