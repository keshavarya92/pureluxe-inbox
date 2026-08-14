import { NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { listTrips } from '@/lib/trip-builder/queries'

// GET — list existing Trip Builder trips (client, destinations, status),
// newest-updated first. Powers the "browse/reopen a trip" picker.
export async function GET() {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const trips = await listTrips()
    return NextResponse.json({ trips })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
