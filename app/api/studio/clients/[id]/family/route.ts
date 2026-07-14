import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import {
  addFamilyMember,
  removeFamilyMember,
  createFamily,
} from '@/lib/studio/queries'
import type { FamilyMemberRole } from '@/lib/studio/types'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: clientId } = await params
  const { action, familyId, familyName, role, isPrimary } = await req.json()

  try {
    if (action === 'create_and_add') {
      // Create new family then add this client as primary
      const family = await createFamily(familyName, user.email)
      await addFamilyMember(family.id, clientId, role ?? 'primary', true)
      return NextResponse.json({ ok: true, familyId: family.id })
    }

    if (action === 'add_to_existing') {
      await addFamilyMember(familyId, clientId, role as FamilyMemberRole, isPrimary ?? false)
      return NextResponse.json({ ok: true })
    }

    if (action === 'remove') {
      await removeFamilyMember(familyId, clientId)
      return NextResponse.json({ ok: true })
    }

    if (action === 'update_role') {
      await addFamilyMember(familyId, clientId, role as FamilyMemberRole, isPrimary ?? false)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
