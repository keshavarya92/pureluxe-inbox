import { NextRequest, NextResponse } from 'next/server'
import { getGmailClient, fetchEmails } from '@/lib/gmail'
import { classifyBatch } from '@/lib/classifier'
import { store } from '@/lib/store'
import { requireAuth } from '@/lib/session'

export async function POST(req: NextRequest) {
  let session
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    if (store.isSyncing()) {
      return NextResponse.json({ error: 'Sync already in progress' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const maxResults = body.maxResults || 20

    store.setSyncInProgress(true)

    const gmail = getGmailClient(session.accessToken!, session.refreshToken)

    const { emails: rawEmails } = await fetchEmails(gmail, {
      maxResults,
      query: 'in:inbox',
    })

    if (rawEmails.length === 0) {
      store.setSyncInProgress(false)
      return NextResponse.json({
        total: 0, classified: 0, bookings: 0,
        actionRequired: 0, errors: 0,
        timestamp: new Date().toISOString(),
      })
    }

    const existingIds = await store.getExistingIds(rawEmails.map(e => e.id))
    const newEmails = rawEmails.filter(e => !existingIds.has(e.id))
    let classified = 0
    let errors = 0

    if (newEmails.length > 0) {
      try {
        const classifiedEmails = await classifyBatch(newEmails)
        await store.setMany(classifiedEmails)
        classified = classifiedEmails.length
      } catch (err) {
        console.error('Batch classification error:', err)
        errors++
      }
    }

    store.setSyncInProgress(false)
    const stats = await store.getStats()

    return NextResponse.json({
      total: rawEmails.length,
      classified,
      bookings: stats.bookings,
      actionRequired: stats.actionRequired,
      errors,
      timestamp: new Date().toISOString(),
    })
  } catch (err: any) {
    store.setSyncInProgress(false)
    console.error('Sync error:', err)
    return NextResponse.json({ error: err.message || 'Sync failed' }, { status: 500 })
  }
}

export async function GET() {
  try {
    await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [total, stats] = await Promise.all([store.size(), store.getStats()])

  return NextResponse.json({
    lastSync: store.getLastSync(),
    total,
    syncing: store.isSyncing(),
    stats,
  })
}
