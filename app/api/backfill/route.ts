import { NextRequest, NextResponse } from 'next/server'
import { getGmailClient, fetchEmails } from '@/lib/gmail'
import { store } from '@/lib/store'
import { requireAuth } from '@/lib/session'
import { getUserByEmail } from '@/lib/users'

const BATCH_SIZE = 20

export async function POST(req: NextRequest) {
  let session
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const user = await getUserByEmail(session.email!)
    if (!user?.access_token) {
      return NextResponse.json({ error: 'No stored credentials — please reconnect' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const maxTotal: number = body.maxTotal || 200

    const gmail = getGmailClient(user.access_token, user.refresh_token)

    let processed = 0
    let stored    = 0
    let skipped   = 0
    let errors    = 0
    let pageToken: string | undefined = undefined

    while (processed < maxTotal) {
      const batchMax = Math.min(BATCH_SIZE, maxTotal - processed)
      const { emails: rawEmails, nextPageToken } = await fetchEmails(gmail, {
        maxResults: batchMax,
        query: 'in:inbox',
        pageToken,
      })

      if (rawEmails.length === 0) break
      processed += rawEmails.length

      const existingIds = await store.getExistingIds(rawEmails.map(e => e.id))
      const newEmails = rawEmails.filter(e => !existingIds.has(e.id))
      skipped += rawEmails.length - newEmails.length

      if (newEmails.length > 0) {
        try {
          await store.setMany(newEmails, user.email)
          stored += newEmails.length
        } catch (err) {
          console.error('Backfill store error:', err)
          errors++
        }
      }

      if (!nextPageToken) break
      pageToken = nextPageToken
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    return NextResponse.json({ processed, stored, skipped, errors, timestamp: new Date().toISOString() })
  } catch (err: any) {
    console.error('Backfill error:', err)
    return NextResponse.json({ error: err.message || 'Backfill failed' }, { status: 500 })
  }
}
