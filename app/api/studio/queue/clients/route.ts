import { NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { getPendingClients } from '@/lib/studio/queries'

export async function GET() {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const clients = await getPendingClients()
    return NextResponse.json({ clients, userEmail: user.email })
  } catch (err: any) {
    console.error('[studio/queue/clients] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
