import { NextRequest, NextResponse } from 'next/server'
import { selectLineItem } from '@/lib/trip-builder/queries'

// POST — the client tapping a rate card to explicitly set "leaning towards
// this," bypassing the Curator agent entirely (build brief §2: a client
// tap is just as valid as, and overrides, the agent's own inference —
// both go through the same selectLineItem(), there's no separate state).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await params
  try {
    const item = await selectLineItem(id, itemId)
    return NextResponse.json(item)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
