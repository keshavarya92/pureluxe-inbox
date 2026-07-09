import { getSession } from '@/lib/session'

export async function getStudioUser(): Promise<{ email: string; name: string } | null> {
  const session = await getSession()
  if (!session.email?.endsWith('@kft.travel')) return null
  const raw = session.email.split('@')[0]
  const name = raw.charAt(0).toUpperCase() + raw.slice(1)
  return { email: session.email, name }
}
