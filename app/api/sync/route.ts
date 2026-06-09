import { NextRequest, NextResponse } from 'next/server'
import { getGmailClient, fetchEmails } from '@/lib/gmail'
import { store } from '@/lib/store'
import { requireAuth } from '@/lib/session'
import { getUserByEmail, updateLastSync } from '@/lib/users'

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

    const user = await getUserByEmail(session.email!)
    if (!user?.access_token) {
      return NextResponse.json({ error: 'No stored credentials — please reconnect' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const maxResults = body.maxResults || 20

    store.setSyncInProgress(true)

    const gmail = getGmailClient(user.access_token, user.refresh_token)
    const { emails: rawEmails } = await fetchEmails(gmail, { maxResults, query: 'in:inbox' })

    let stored = 0
    let errors = 0

    if (rawEmails.length > 0) {
      const existingIds = await store.getExistingIds(rawEmails.map(e => e.id))
      const newEmails = rawEmails.filter(e => !existingIds.has(e.id))

      if (newEmails.length > 0) {
        try {
          await store.setMany(newEmails, user.email)
          stored = newEmails.length
        } catch (err) {
          console.error('Store error during sync:', err)
          errors++
        }
      }
    }

    store.setSyncInProgress(false)
    await updateLastSync(user.email)

    return NextResponse.json({
      total: rawEmails.length,
      stored,
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
  return NextResponse.json({ lastSync: store.getLastSync(), total, syncing: store.isSyncing(), stats })
}
