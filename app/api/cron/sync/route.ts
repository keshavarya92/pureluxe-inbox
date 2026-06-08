import { NextRequest, NextResponse } from 'next/server'
import { getGmailClient, fetchEmails } from '@/lib/gmail'
import { classifyBatch } from '@/lib/classifier'
import { store } from '@/lib/store'
import { getAllActiveUsers, updateLastSync } from '@/lib/users'

// Called by Vercel Cron every 15 minutes.
// Vercel injects Authorization: Bearer <CRON_SECRET> on scheduled invocations.
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const users = await getAllActiveUsers()
  const results: { email: string; newEmails: number; error?: string }[] = []

  for (const user of users) {
    try {
      const gmail = getGmailClient(user.access_token!, user.refresh_token)

      const { emails: rawEmails } = await fetchEmails(gmail, {
        maxResults: 20,
        query: 'in:inbox',
      })

      let newCount = 0

      if (rawEmails.length > 0) {
        const existingIds = await store.getExistingIds(rawEmails.map(e => e.id))
        const newEmails = rawEmails.filter(e => !existingIds.has(e.id))

        if (newEmails.length > 0) {
          const classified = await classifyBatch(newEmails)
          await store.setMany(classified, user.email)
          newCount = classified.length
        }
      }

      await updateLastSync(user.email)
      results.push({ email: user.email, newEmails: newCount })
    } catch (err: any) {
      console.error('Cron sync failed for user:', user.email, err)
      results.push({ email: user.email, newEmails: 0, error: err.message })
    }
  }

  return NextResponse.json({ results, timestamp: new Date().toISOString() })
}
