import { NextRequest, NextResponse } from 'next/server'
import { store } from '@/lib/store'
import { requireAuth } from '@/lib/session'

export async function GET(req: NextRequest) {
  let session
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category') || 'all'
  const limit = parseInt(searchParams.get('limit') || '100')

  const [allEmails, stats] = await Promise.all([
    store.getByCategory(category, session.email),
    store.getStats(session.email),
  ])

  return NextResponse.json({ emails: allEmails.slice(0, limit), stats })
}
