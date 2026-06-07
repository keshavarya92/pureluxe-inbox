import { NextRequest, NextResponse } from 'next/server'
import { store } from '@/lib/store'
import { requireAuth } from '@/lib/session'

export async function GET(req: NextRequest) {
  // Fix 3: require auth
  try {
    await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category') || 'all'
  const limit = parseInt(searchParams.get('limit') || '100')

  const emails = store.getByCategory(category).slice(0, limit)
  const stats = store.getStats()

  return NextResponse.json({ emails, stats })
}
