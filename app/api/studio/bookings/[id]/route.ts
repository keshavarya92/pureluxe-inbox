import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import {
  getBookingWithClient,
  updateBookingFull,
  markBookingSuperseded,
  mergeBookings,
} from '@/lib/studio/queries'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const booking = await getBookingWithClient(id)
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ booking, userEmail: user.email })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const fields = await req.json()

  try {
    await updateBookingFull(id, fields)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { action, newBookingId, loserId } = await req.json()

  try {
    if (action === 'supersede') {
      if (!newBookingId) return NextResponse.json({ error: 'newBookingId required' }, { status: 400 })
      await markBookingSuperseded(id, newBookingId, user.email)
      return NextResponse.json({ ok: true })
    }

    if (action === 'merge') {
      if (!loserId) return NextResponse.json({ error: 'loserId required' }, { status: 400 })
      await mergeBookings(id, loserId, user.email)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
