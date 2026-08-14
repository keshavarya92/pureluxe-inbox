import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { deleteLineItem } from '@/lib/trip-builder/queries'

// DELETE — permanently removes a confirmed line item (duplicate from a
// re-paste, a rate that turned out wrong after approval). There's no
// "undo" for this beyond re-pasting/re-approving the rate again.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id, itemId } = await params

  try {
    await deleteLineItem(id, itemId)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
