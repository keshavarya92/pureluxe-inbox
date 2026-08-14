import { NextRequest, NextResponse } from 'next/server'
import { getClientTripView } from '@/lib/client/queries'

// GET — everything the client sidebar needs: legs, itinerary days, rate
// options grouped by property.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const data = await getClientTripView(id)
    return NextResponse.json(data)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
