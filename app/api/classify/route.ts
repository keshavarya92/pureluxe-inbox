import { NextRequest, NextResponse } from 'next/server'
import { deepExtractBooking } from '@/lib/classifier'
import { store } from '@/lib/store'
import { requireAuth } from '@/lib/session'
import { getGmailClient, fetchEmailById } from '@/lib/gmail'
import { getUserByEmail } from '@/lib/users'

export async function POST(req: NextRequest) {
  let session
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { emailId } = await req.json()

    // Get booking emails that haven't had deep extraction yet
    const bookingEmails = emailId
      ? [await store.get(emailId)].filter(Boolean)
      : (await store.getByCategory('booking')).filter(
          e => !e.booking?.confirmationNumber && !e.booking?.totalAmount
        )

    if (bookingEmails.length === 0) {
      return NextResponse.json({ extracted: 0, message: 'No emails need deep extraction' })
    }

    const user = await getUserByEmail(session.email!)
    if (!user?.access_token) {
      return NextResponse.json({ error: 'No stored credentials — please reconnect' }, { status: 401 })
    }
    const gmail = getGmailClient(user.access_token, user.refresh_token)
    let extracted = 0

    for (const email of bookingEmails.slice(0, 10)) {
      try {
        const raw = await fetchEmailById(gmail, email!.id)

        if (raw) {
          const deepData = await deepExtractBooking(raw)
          const updated = { ...email!, ...deepData }
          await store.set(updated as any)
          extracted++
        }
      } catch (err) {
        console.error('Deep extraction error for email:', email!.id, err)
      }
    }

    return NextResponse.json({ extracted, total: bookingEmails.length })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
