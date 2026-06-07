import { NextRequest, NextResponse } from 'next/server'
import { deepExtractBooking } from '@/lib/classifier'
import { store } from '@/lib/store'
import { requireAuth } from '@/lib/session'
import { getGmailClient, fetchEmailById } from '@/lib/gmail'

// Fix 4+5: classify endpoint now exists and wires up deepExtractBooking
// Called after initial classification to run Sonnet deep extraction
// on booking emails that Haiku flagged

export async function POST(req: NextRequest) {
  let session
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { emailId } = await req.json()

    // Get booking emails from store that haven't had deep extraction yet
    const bookingEmails = emailId
      ? [store.get(emailId)].filter(Boolean)
      : store.getByCategory('booking').filter(e => !e.booking?.confirmationNumber && !e.booking?.totalAmount)

    if (bookingEmails.length === 0) {
      return NextResponse.json({ extracted: 0, message: 'No emails need deep extraction' })
    }

    // Fetch full bodies from Gmail for deep extraction
    const gmail = getGmailClient(session.accessToken!, session.refreshToken)
    let extracted = 0

    for (const email of bookingEmails.slice(0, 10)) { // cap at 10 per call
      try {
        const raw = await fetchEmailById(gmail, email!.id)

        if (raw) {
          const deepData = await deepExtractBooking(raw)
          const updated = { ...email!, ...deepData }
          store.set(updated as any)
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
