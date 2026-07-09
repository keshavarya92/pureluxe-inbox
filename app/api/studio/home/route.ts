import { NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import {
  getTodayCheckins,
  getTodayCheckouts,
  getCancellationDeadlines,
  getPaymentsDue,
  getUpcomingCheckins,
  getPendingBookingCount,
  getPendingClientCount,
} from '@/lib/studio/queries'

export async function GET() {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const [
      checkins,
      checkouts,
      deadlines,
      payments,
      upcoming,
      pendingBookings,
      pendingClients,
    ] = await Promise.all([
      getTodayCheckins(),
      getTodayCheckouts(),
      getCancellationDeadlines(7),
      getPaymentsDue(),
      getUpcomingCheckins(7),
      getPendingBookingCount(),
      getPendingClientCount(),
    ])

    return NextResponse.json({
      checkins,
      checkouts,
      deadlines,
      payments,
      upcoming,
      pendingBookings,
      pendingClients,
    })
  } catch (err: any) {
    console.error('[studio/home] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
