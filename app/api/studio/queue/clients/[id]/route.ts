import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { approveClient, rejectClient, updateClientFields, linkClientRelationship } from '@/lib/studio/queries'

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
    if (action === 'approve') {
      await approveClient(id, user.email)
    } else if (action === 'reject') {
      await rejectClient(id, user.email)
    } else if (action === 'link_relationship') {
      const { relatedClientId, relationshipType, notes } = body
      if (!relatedClientId || !relationshipType) {
        return NextResponse.json({ error: 'relatedClientId and relationshipType are required' }, { status: 400 })
      }
      await linkClientRelationship(id, relatedClientId, relationshipType, notes ?? null)
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
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
    await updateClientFields(id, fields)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
