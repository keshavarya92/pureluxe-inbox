import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { editRateDraft, approveRateDraft, rejectRateDraft } from '@/lib/trip-builder/queries'

// POST — { action: 'edit' | 'approve' | 'reject', ... }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json()
  const { action } = body

  try {
    if (action === 'edit') {
      if (!Array.isArray(body.extracted_json)) {
        return NextResponse.json({ error: 'extracted_json array required' }, { status: 400 })
      }
      const draft = await editRateDraft(id, body.extracted_json)
      return NextResponse.json({ draft })
    }

    if (action === 'approve') {
      const items = await approveRateDraft(id, body.items)
      return NextResponse.json({ items })
    }

    if (action === 'reject') {
      await rejectRateDraft(id)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
