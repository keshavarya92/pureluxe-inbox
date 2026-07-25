import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { supabase } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { winnerId, loserId } = await req.json()

  if (!winnerId || !loserId) {
    return NextResponse.json({ error: 'winnerId and loserId required' }, { status: 400 })
  }

  try {
    // 1. Re-link everything that points at the loser. The loser row itself is
    //    deactivated below rather than deleted (schema.sql is a stale, partial
    //    snapshot — enquiries, air_bookings, client_documents and others also
    //    carry client_id FKs not listed here), but keeping every other table's
    //    references pointed at the winner still matters for correctness.
    const { error: bookingErr } = await supabase
      .from('bookings')
      .update({ client_id: winnerId })
      .eq('client_id', loserId)
    if (bookingErr) throw new Error(`booking re-link: ${bookingErr.message}`)

    // family_members has a unique (family_id, client_id) constraint — if winner
    // and loser are already in the same family, drop the loser's row for that
    // family before re-linking the rest, or the update below hits a conflict.
    const { data: winnerFamilies } = await supabase
      .from('family_members')
      .select('family_id')
      .eq('client_id', winnerId)
    const winnerFamilyIds = (winnerFamilies ?? []).map(f => f.family_id)
    if (winnerFamilyIds.length) {
      const { error: dupErr } = await supabase
        .from('family_members')
        .delete()
        .eq('client_id', loserId)
        .in('family_id', winnerFamilyIds)
      if (dupErr) throw new Error(`family_members dedupe: ${dupErr.message}`)
    }

    const { error: familyMemberErr } = await supabase
      .from('family_members')
      .update({ client_id: winnerId })
      .eq('client_id', loserId)
    if (familyMemberErr) throw new Error(`family_members re-link: ${familyMemberErr.message}`)

    const { error: familyBookingMemberErr } = await supabase
      .from('family_booking_members')
      .update({ client_id: winnerId })
      .eq('client_id', loserId)
    if (familyBookingMemberErr) throw new Error(`family_booking_members re-link: ${familyBookingMemberErr.message}`)

    const { error: relPrimaryErr } = await supabase
      .from('client_relationships')
      .update({ primary_client_id: winnerId })
      .eq('primary_client_id', loserId)
    if (relPrimaryErr) throw new Error(`client_relationships re-link: ${relPrimaryErr.message}`)

    const { error: relRelatedErr } = await supabase
      .from('client_relationships')
      .update({ related_client_id: winnerId })
      .eq('related_client_id', loserId)
    if (relRelatedErr) throw new Error(`client_relationships re-link: ${relRelatedErr.message}`)

    const { error: enquiryErr } = await supabase
      .from('enquiries')
      .update({ client_id: winnerId })
      .eq('client_id', loserId)
    if (enquiryErr) throw new Error(`enquiries re-link: ${enquiryErr.message}`)

    // 2. Fetch both records to build merge patch
    const [{ data: winner }, { data: loser }] = await Promise.all([
      supabase.from('clients').select('*').eq('id', winnerId).single(),
      supabase.from('clients').select('*').eq('id', loserId).single(),
    ])
    if (!winner || !loser) throw new Error('Could not fetch client records')

    // 3. Fill null fields on winner from loser
    const fillable = [
      'email', 'phone', 'whatsapp', 'title', 'first_name', 'last_name',
      'nationality', 'city_of_residence', 'company', 'birthday',
      'anniversary', 'general_notes', 'internal_notes', 'misc',
    ]
    const patch: Record<string, any> = {}
    for (const field of fillable) {
      if (!winner[field] && loser[field]) patch[field] = loser[field]
    }

    // 4. Take higher VIP level
    const vipRank: Record<string, number> = { standard: 0, vip: 1, vvip: 2 }
    const winnerRank = vipRank[winner.vip_level ?? 'standard'] ?? 0
    const loserRank  = vipRank[loser.vip_level ?? 'standard'] ?? 0
    if (loserRank > winnerRank) patch.vip_level = loser.vip_level

    // 5. Apply patch + mark reviewed
    patch.reviewed_by = user.email
    patch.reviewed_at = new Date().toISOString()
    patch.active      = true
    patch.updated_at  = new Date().toISOString()

    if (Object.keys(patch).length > 0) {
      const { error: patchErr } = await supabase
        .from('clients')
        .update(patch)
        .eq('id', winnerId)
      if (patchErr) throw new Error(`winner patch: ${patchErr.message}`)
    }

    // 6. Deactivate the loser record (not a hard delete — avoids foreign-key
    //    violations from any client_id-referencing table not re-linked above,
    //    and matches the merge pattern used elsewhere in lib/studio/queries.ts).
    //    Inactive clients are already excluded from directory/queue listings.
    const { error: deactivateErr } = await supabase
      .from('clients')
      .update({
        active:      false,
        reviewed_by: user.email,
        reviewed_at: new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq('id', loserId)
    if (deactivateErr) throw new Error(`loser deactivate: ${deactivateErr.message}`)

    console.log(`[merge] winner=${winnerId} loser=${loserId} by=${user.email}`)
    return NextResponse.json({ ok: true, winnerId })
  } catch (err: any) {
    console.error('[merge] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
