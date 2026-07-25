import { NextRequest, NextResponse } from 'next/server'
import { transitionExpiredBookings } from '@/lib/studio/queries'

// Called by Vercel Cron daily — flips confirmed bookings to checked_out
// once their check-out date has passed.
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const transitioned = await transitionExpiredBookings()
    return NextResponse.json({ transitioned, timestamp: new Date().toISOString() })
  } catch (err: any) {
    console.error('[cron/checkout-transition] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
