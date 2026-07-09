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
    // 1. Re-link all bookings from loser to winner
    const { error: bookingErr } = await supabase
      .from('bookings')
      .update({ client_id: winnerId })
      .eq('client_id', loserId)
    if (bookingErr) throw new Error(`booking re-link: ${bookingErr.message}`)

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

    // 6. Delete the loser record
    const { error: deleteErr } = await supabase
      .from('clients')
      .delete()
      .eq('id', loserId)
    if (deleteErr) throw new Error(`loser delete: ${deleteErr.message}`)

    console.log(`[merge] winner=${winnerId} loser=${loserId} by=${user.email}`)
    return NextResponse.json({ ok: true, winnerId })
  } catch (err: any) {
    console.error('[merge] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
