import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { generateDocument } from '@/lib/trip-builder/document-generator'

// POST — { type: 'itinerary' | 'rate_sheet' } → generates the document,
// stores it, and records a trip_documents row.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { type } = await req.json()
  if (type !== 'itinerary' && type !== 'rate_sheet') {
    return NextResponse.json({ error: 'type must be "itinerary" or "rate_sheet"' }, { status: 400 })
  }

  try {
    const { document, warnings } = await generateDocument(id, type)
    return NextResponse.json({ document, warnings })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
