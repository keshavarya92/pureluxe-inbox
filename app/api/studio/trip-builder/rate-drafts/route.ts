import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { sniffImageMime } from '@/lib/attachments'
import { extractRateLineItems, applyLegFallback } from '@/lib/trip-builder/rate-extraction'
import { createRateDraft, listRateDrafts, getTripState } from '@/lib/trip-builder/queries'

// GET — list rate drafts for a trip (pending + already-actioned, newest first)
export async function GET(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tripId = req.nextUrl.searchParams.get('tripId')
  if (!tripId) return NextResponse.json({ error: 'tripId required' }, { status: 400 })

  try {
    const drafts = await listRateDrafts(tripId)
    return NextResponse.json({ drafts })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// POST — paste (JSON body) or upload (multipart) rate info, extract line
// items via Claude, stage as a pending_review draft.
export async function POST(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contentType = req.headers.get('content-type') ?? ''

  try {
    let tripId:   string | null
    let legId:    string | null = null
    let rawInput: string

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      tripId = formData.get('tripId') as string | null
      legId  = (formData.get('legId') as string | null) || null
      const file = formData.get('file') as File | null
      if (!tripId || !file) {
        return NextResponse.json({ error: 'tripId and file required' }, { status: 400 })
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      rawInput = `[Uploaded file: ${file.name}]`

      const state = await getTripState(tripId)
      const legs = state.legs.map(l => ({ id: l.id, destination: l.destination }))

      let extracted
      if (file.type === 'application/pdf') {
        extracted = await extractRateLineItems({ kind: 'pdf', base64: buffer.toString('base64') }, legs)
      } else if (file.type === 'image/jpeg' || file.type === 'image/png') {
        const mimeType = sniffImageMime(buffer) ?? file.type
        extracted = await extractRateLineItems({ kind: 'image', base64: buffer.toString('base64'), mimeType }, legs)
      } else {
        return NextResponse.json({ error: `Unsupported file type: ${file.type}` }, { status: 400 })
      }

      const draft = await createRateDraft(tripId, legId, rawInput, applyLegFallback(extracted, legId))
      return NextResponse.json({ draft })
    }

    const body = await req.json()
    tripId   = body.tripId ?? null
    legId    = body.legId  ?? null
    rawInput = body.rawText ?? ''
    if (!tripId || !rawInput.trim()) {
      return NextResponse.json({ error: 'tripId and rawText required' }, { status: 400 })
    }

    const state = await getTripState(tripId)
    const legs = state.legs.map(l => ({ id: l.id, destination: l.destination }))
    const extracted = await extractRateLineItems({ kind: 'text', text: rawInput }, legs)
    const draft = await createRateDraft(tripId, legId, rawInput, applyLegFallback(extracted, legId))
    return NextResponse.json({ draft })
  } catch (err: any) {
    console.error('[trip-builder/rate-drafts] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
