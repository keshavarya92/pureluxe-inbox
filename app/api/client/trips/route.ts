import { NextResponse } from 'next/server'
import { listClientTrips, createClientTrip } from '@/lib/client/queries'

// No auth guard yet — every request is scoped to the single fixed demo
// persona (lib/client/queries.ts's DEMO_CLIENT_ID) until real per-user
// session/auth (build brief §6, Session 6) lands. Not production-safe as
// written; this is the client-demo product, not Studio.

// GET — this persona's trips, most recent first (left sidebar list).
export async function GET() {
  try {
    const trips = await listClientTrips()
    return NextResponse.json({ trips })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// POST — "New trip". No agent call needed: there's exactly one demo
// persona, so unlike Studio's Trip Builder there's no client name to
// resolve/disambiguate first.
export async function POST() {
  try {
    const trip = await createClientTrip()
    return NextResponse.json(trip)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
