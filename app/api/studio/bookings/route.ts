import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { searchBookings, type BookingSort, type BookingStatusFilter } from '@/lib/studio/queries'

export async function GET(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const p = req.nextUrl.searchParams
  const params = {
    query:        p.get('q') ?? '',
    status:       (p.get('status') ?? 'all') as BookingStatusFilter,
    sort:         (p.get('sort') ?? 'check_in_desc') as BookingSort,
    check_in_from: p.get('from') ?? undefined,
    check_in_to:   p.get('to') ?? undefined,
    page:         parseInt(p.get('page') ?? '1'),
    page_size:    50,
  }

  try {
    const result = await searchBookings(params)
    return NextResponse.json({ ...result, userEmail: user.email })
  } catch (err: any) {
    console.error('[studio/bookings] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
