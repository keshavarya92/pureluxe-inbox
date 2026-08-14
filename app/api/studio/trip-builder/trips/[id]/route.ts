import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { getTripSidebarData } from '@/lib/trip-builder/queries'

// GET — everything the sidebar needs for one trip: legs, itinerary days,
// line items, pending drafts, documents (with staleness), running total.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  try {
    const data = await getTripSidebarData(id)
    return NextResponse.json(data)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
