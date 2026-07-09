import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { approveBooking, rejectBooking, assignTripId, dismissTripSuggestion } from '@/lib/studio/queries'

export async function POST(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { action, bookingId, tripId } = await req.json()

  try {
    if (action === 'approve') {
      await approveBooking(bookingId, user.email)
    } else if (action === 'reject') {
      await rejectBooking(bookingId)
    } else if (action === 'group') {
      await assignTripId(bookingId, tripId)
    } else if (action === 'dismiss_group') {
      await dismissTripSuggestion(bookingId)
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
