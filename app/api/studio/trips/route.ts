import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { getActiveTrips, getUpcomingTrips, getPastTrips } from '@/lib/studio/queries'

export async function GET(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tab = req.nextUrl.searchParams.get('tab') ?? 'active'

  try {
    const bookings =
      tab === 'active'   ? await getActiveTrips() :
      tab === 'upcoming' ? await getUpcomingTrips() :
      tab === 'past'     ? await getPastTrips() :
      await getActiveTrips()

    return NextResponse.json({ bookings, userEmail: user.email })
  } catch (err: any) {
    console.error('[studio/trips] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
