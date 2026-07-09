import { NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { getPendingBookings } from '@/lib/studio/queries'

export async function GET() {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const bookings = await getPendingBookings()
    return NextResponse.json({ bookings, userEmail: user.email })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
