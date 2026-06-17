/**
 * resolvers.ts — Client and booking dedup/merge resolvers.
 *
 * NOT yet wired into writeExtracted. Review the merge logic, then call:
 *   resolveClient(incoming)  →  returns client_id (existing or new)
 *   resolveBooking(incoming) →  returns { bookingId, action }
 *
 * Requires the migration in supabase/migrations/001_resolvers.sql to be
 * applied first (adds normalized_name generated column + pg_trgm index +
 * client_dedup_flags table + find_similar_clients RPC).
 */

import { supabase } from './supabase'

// ----------------------------------------------------------------
// Name normalization — must produce identical output to the
// PostgreSQL generated column expression in 001_resolvers.sql.
// ----------------------------------------------------------------

const TITLE_PREFIX_RE  = /^(mr\.?|mrs\.?|ms\.?|dr\.?|mstr\.?|miss|prof\.?)\s+/
const FAMILY_SUFFIX_RE = /\s+(&|and)?\s*(family|\(party\)|group)\s*$/

export function normalizeName(fullName: string): string {
  const result = fullName
    .toLowerCase()
    .replace(TITLE_PREFIX_RE,  '')
    .replace(FAMILY_SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  // If stripping consumed the entire string (e.g. input was just "Mr." with
  // no surname), fall back to the lowercased original rather than returning
  // '' — an empty normalized_name would match every client with a null name
  // and produce false dedup hits.
  return result || fullName.toLowerCase().trim()
}

// ----------------------------------------------------------------
// VIP level ordering
// ----------------------------------------------------------------

const VIP_RANK: Record<string, number> = { standard: 0, vip: 1, vvip: 2 }

function higherVip(a: string | null | undefined, b: string | null | undefined): string {
  return (VIP_RANK[a ?? 'standard'] ?? 0) >= (VIP_RANK[b ?? 'standard'] ?? 0)
    ? (a ?? 'standard')
    : (b ?? 'standard')
}

// ----------------------------------------------------------------
// Loyalty program union (dedup by program+number pair)
// ----------------------------------------------------------------

function mergeLoyaltyPrograms(existing: any[], incoming: any[]): any[] {
  const seen = new Map<string, any>()
  for (const p of [...existing, ...incoming]) {
    const key = `${String(p?.program ?? '')}|${String(p?.number ?? '')}`
    if (!seen.has(key)) seen.set(key, p)
  }
  return [...seen.values()]
}

// ----------------------------------------------------------------
// ClientInput
// ----------------------------------------------------------------

export interface ClientInput {
  full_name:          string
  email?:             string | null
  phone?:             string | null
  whatsapp?:          string | null
  title?:             string | null
  first_name?:        string | null
  last_name?:         string | null
  nationality?:       string | null
  city_of_residence?: string | null
  vip_level?:         string | null
  company?:           string | null
  loyalty_programs?:  any[] | null
  birthday?:          string | null
  anniversary?:       string | null
  general_notes?:     string | null
  internal_notes?:    string | null
  misc?:              string | null
}

// ----------------------------------------------------------------
// Merge non-null incoming fields into an existing client row.
// Only patches if something actually changed.
// ----------------------------------------------------------------

async function mergeClientFields(
  existingId: string,
  existing:   Record<string, any>,
  incoming:   ClientInput,
): Promise<void> {
  const patch: Record<string, any> = {}

  // Scalar nullable fields: fill if existing row has null
  const fillableScalar = [
    'email', 'phone', 'whatsapp', 'title', 'first_name', 'last_name',
    'nationality', 'city_of_residence', 'company', 'birthday', 'anniversary', 'misc',
  ] as const
  for (const f of fillableScalar) {
    if ((existing[f] === null || existing[f] === undefined) && incoming[f] != null) {
      patch[f] = incoming[f]
    }
  }

  // VIP level — keep the higher
  if (incoming.vip_level) {
    const merged = higherVip(existing.vip_level, incoming.vip_level)
    if (merged !== (existing.vip_level ?? 'standard')) patch.vip_level = merged
  }

  // Loyalty programs — union by program+number
  if (incoming.loyalty_programs?.length) {
    const merged = mergeLoyaltyPrograms(existing.loyalty_programs ?? [], incoming.loyalty_programs)
    if (JSON.stringify(merged) !== JSON.stringify(existing.loyalty_programs ?? [])) {
      patch.loyalty_programs = merged
    }
  }

  // Notes — append if new content isn't already a substring of existing
  for (const noteField of ['general_notes', 'internal_notes'] as const) {
    const incomingNote = incoming[noteField]
    if (incomingNote) {
      const existingNote = (existing[noteField] as string | null) ?? ''
      if (!existingNote.includes(incomingNote)) {
        patch[noteField] = existingNote ? `${existingNote}\n${incomingNote}` : incomingNote
      }
    }
  }

  if (Object.keys(patch).length) {
    await supabase.from('clients').update(patch).eq('id', existingId)
    console.log(`[resolver] clients merge id=${existingId} fields=${Object.keys(patch).join(',')}`)
  }
}

// ----------------------------------------------------------------
// resolveClient
// Returns the client_id for the incoming record, creating one if needed.
// Merges non-null fields into existing rows. Flags duplicates for review.
// ----------------------------------------------------------------

export async function resolveClient(incoming: ClientInput): Promise<string> {
  // Step 1: exact contact match — email OR phone
  if (incoming.email || incoming.phone) {
    const orParts: string[] = []
    if (incoming.email) orParts.push(`email.eq.${incoming.email}`)
    if (incoming.phone) orParts.push(`phone.eq.${incoming.phone}`)
    const { data: contactMatches } = await supabase
      .from('clients').select('*')
      .or(orParts.join(','))
      .limit(1)
    if (contactMatches?.length) {
      const row = contactMatches[0]
      await mergeClientFields(row.id, row, incoming)
      return row.id
    }
  }

  // Step 2: normalized name exact match
  const normalized = normalizeName(incoming.full_name)
  const { data: nameMatches } = await supabase
    .from('clients').select('*')
    .eq('normalized_name', normalized)

  if (nameMatches?.length === 1) {
    await mergeClientFields(nameMatches[0].id, nameMatches[0], incoming)
    return nameMatches[0].id
  }

  if ((nameMatches?.length ?? 0) > 1) {
    // Multiple rows for same normalized name — pre-resolver duplicates.
    // Pick the row with the most non-null fields as canonical; flag the rest.
    const countNonNull = (r: Record<string, any>) =>
      Object.values(r).filter(v => v !== null && v !== '' && v !== undefined).length
    const canonical = nameMatches!.reduce((best, row) =>
      countNonNull(row) > countNonNull(best) ? row : best,
    )
    for (const dup of nameMatches!.filter(r => r.id !== canonical.id)) {
      await supabase.from('client_dedup_flags').insert({
        client_id_a: canonical.id,
        client_id_b: dup.id,
        reason:      'exact_normalized_name_duplicate',
      })
    }
    console.log(`[resolver] clients dedup — ${nameMatches!.length} rows for "${normalized}", canonical=${canonical.id}`)
    await mergeClientFields(canonical.id, canonical, incoming)
    return canonical.id
  }

  // Step 3: fuzzy trigram similarity match (requires pg_trgm + find_similar_clients RPC)
  let fuzzyMatches: Array<{ id: string }> = []
  try {
    const { data } = await supabase.rpc('find_similar_clients', {
      input_name: normalized,
      threshold:  0.65,
    })
    fuzzyMatches = data ?? []
  } catch {
    // pg_trgm RPC not yet installed — skip fuzzy check gracefully
  }

  // Insert new client
  const insertPayload: Record<string, any> = {
    full_name:         incoming.full_name,
    email:             incoming.email             ?? null,
    phone:             incoming.phone             ?? null,
    whatsapp:          incoming.whatsapp          ?? null,
    title:             incoming.title             ?? null,
    first_name:        incoming.first_name        ?? null,
    last_name:         incoming.last_name         ?? null,
    nationality:       incoming.nationality       ?? null,
    city_of_residence: incoming.city_of_residence ?? null,
    vip_level:         incoming.vip_level         ?? 'standard',
    company:           incoming.company           ?? null,
    loyalty_programs:  incoming.loyalty_programs  ?? [],
    birthday:          incoming.birthday          ?? null,
    anniversary:       incoming.anniversary       ?? null,
    general_notes:     incoming.general_notes     ?? null,
    internal_notes:    incoming.internal_notes    ?? null,
    misc:              incoming.misc              ?? null,
  }

  const { data: newClient, error } = await supabase
    .from('clients').insert(insertPayload).select('id').single()
  if (error) throw new Error(`clients insert: ${error.message}`)

  console.log(`[resolver] clients insert id=${newClient.id} name="${incoming.full_name}"`)

  // Flag fuzzy candidates for manual review — don't auto-merge, just surface
  if (fuzzyMatches.length) {
    console.log(`[resolver] clients fuzzy candidates for "${normalized}": ${fuzzyMatches.map(m => m.id).join(', ')}`)
    for (const match of fuzzyMatches) {
      await supabase.from('client_dedup_flags').insert({
        client_id_a: newClient.id,
        client_id_b: match.id,
        reason:      'fuzzy_match_candidate',
      })
    }
  }

  return newClient.id
}

// ----------------------------------------------------------------
// BookingInput
// ----------------------------------------------------------------

export interface BookingInput {
  // Required dedup keys
  client_id:    string
  check_in:     string
  check_out:    string
  // Optional dedup keys
  property_id?: string | null
  hotel_ref?:   string | null
  amadeus_ref?: string | null
  lhw_ref?:     string | null
  ottila_ref?:  string | null
  onyx_ref?:    string | null
  // All remaining fields passed through to insert/update
  [key: string]: any
}

// ----------------------------------------------------------------
// resolveBooking
// Returns { bookingId, action } — existing row merged or new row inserted.
// ----------------------------------------------------------------

export async function resolveBooking(
  incoming: BookingInput,
): Promise<{ bookingId: string; action: 'inserted' | 'updated' }> {
  const { client_id, property_id, check_in, check_out } = incoming

  // Collect non-null ref fields from incoming
  const incomingRefs: Record<string, string> = {}
  for (const ref of ['hotel_ref', 'amadeus_ref', 'lhw_ref', 'ottila_ref', 'onyx_ref'] as const) {
    if (incoming[ref]) incomingRefs[ref] = incoming[ref]
  }
  const incomingHasRefs = Object.keys(incomingRefs).length > 0

  // Step 1: query by (client_id, property_id, check_in, check_out)
  let q = supabase
    .from('bookings').select('*')
    .eq('client_id', client_id)
    .eq('check_in',  check_in)
    .eq('check_out', check_out)
  if (property_id) q = (q as any).eq('property_id', property_id)
  const { data: candidates } = await q

  if (!candidates?.length) {
    // No match — insert new booking
    const { data, error } = await supabase.from('bookings').insert(incoming).select('id').single()
    if (error) throw new Error(`bookings insert: ${error.message}`)
    console.log(`[resolver] bookings insert id=${data.id}`)
    return { bookingId: data.id, action: 'inserted' }
  }

  // Step 2: find which candidate shares at least one ref (or both sides have no refs)
  let matched: Record<string, any> | null = null

  for (const row of candidates) {
    const rowHasNoRefs = !row.hotel_ref && !row.amadeus_ref && !row.lhw_ref && !row.ottila_ref && !row.onyx_ref

    if (!incomingHasRefs && rowHasNoRefs) {
      matched = row
      break
    }
    for (const [ref, val] of Object.entries(incomingRefs)) {
      if (row[ref] === val) { matched = row; break }
    }
    if (matched) break
  }

  if (matched) {
    // Same booking re-ingested — merge non-null fields
    const patch = buildBookingPatch(matched, incoming)
    if (Object.keys(patch).length) {
      await supabase.from('bookings')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', matched.id)
      console.log(`[resolver] bookings merge id=${matched.id} fields=${Object.keys(patch).join(',')}`)
    }
    return { bookingId: matched.id, action: 'updated' }
  }

  // No ref overlap AND incoming has refs → genuinely separate booking (different room/confirmation)
  if (incomingHasRefs) {
    const { data, error } = await supabase.from('bookings').insert(incoming).select('id').single()
    if (error) throw new Error(`bookings insert (separate room): ${error.message}`)
    console.log(`[resolver] bookings insert (separate room) id=${data.id}`)
    return { bookingId: data.id, action: 'inserted' }
  }

  // No refs on either side — attempt conservative merge with first candidate,
  // but guard against merging genuinely separate bookings.
  const fallback = candidates[0]

  // Guard 1: num_rooms mismatch → clearly different rooms, insert new
  if (incoming.num_rooms != null && fallback.num_rooms != null
      && Number(incoming.num_rooms) !== Number(fallback.num_rooms)) {
    const details = `num_rooms existing=${fallback.num_rooms} incoming=${incoming.num_rooms} booking_id=${fallback.id}`
    console.log(`[resolver] booking_merge_skipped_inconsistent ${details}`)
    const { data, error } = await supabase.from('bookings').insert(incoming).select('id').single()
    if (error) throw new Error(`bookings insert (num_rooms mismatch): ${error.message}`)
    console.log(`[resolver] bookings insert (num_rooms mismatch) id=${data.id}`)
    return { bookingId: data.id, action: 'inserted' }
  }

  // Guard 2: total_cost differs by >10% → likely a different booking, insert new
  if (incoming.total_cost != null && fallback.total_cost != null) {
    const existingCost = Number(fallback.total_cost)
    if (existingCost !== 0) {
      const pctDiff = Math.abs(Number(incoming.total_cost) - existingCost) / existingCost
      if (pctDiff > 0.10) {
        const details = `total_cost existing=${fallback.total_cost} incoming=${incoming.total_cost} diff=${(pctDiff * 100).toFixed(1)}% booking_id=${fallback.id}`
        console.log(`[resolver] booking_merge_skipped_inconsistent ${details}`)
        const { data, error } = await supabase.from('bookings').insert(incoming).select('id').single()
        if (error) throw new Error(`bookings insert (cost mismatch): ${error.message}`)
        console.log(`[resolver] bookings insert (cost mismatch) id=${data.id}`)
        return { bookingId: data.id, action: 'inserted' }
      }
    }
  }

  // Guards passed — proceed with merge
  const incomingSummary = JSON.stringify({
    hotel_name: incoming.hotel_name ?? null,
    num_rooms:  incoming.num_rooms  ?? null,
    total_cost: incoming.total_cost ?? null,
    check_in:   incoming.check_in,
    check_out:  incoming.check_out,
  })
  console.log(`[resolver] booking_merge_no_ref_fallback existing_id=${fallback.id} incoming=${incomingSummary}`)

  const patch = buildBookingPatch(fallback, incoming)
  if (Object.keys(patch).length) {
    await supabase.from('bookings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', fallback.id)
    console.log(`[resolver] bookings merge (no-ref fallback) id=${fallback.id} fields=${Object.keys(patch).join(',')}`)
  }
  return { bookingId: fallback.id, action: 'updated' }
}

// ----------------------------------------------------------------
// Build a patch object: fill null fields + append notes.
// Never overwrites an existing non-null value (except notes append).
// ----------------------------------------------------------------

const BOOKING_FILLABLE = [
  'hotel_ref', 'amadeus_ref', 'lhw_ref', 'ottila_ref', 'onyx_ref',
  'total_cost', 'currency', 'total_cost_usd',
  'commission_rate', 'commission_expected', 'commission_channel', 'commissionable',
  'cancellation_deadline', 'cancellation_policy',
  'num_rooms', 'num_adults', 'num_children',
  'special_occasion', 'vip_flag', 'group_name', 'status',
  'booking_source', 'booking_channel', 'misc',
] as const

function buildBookingPatch(
  existing: Record<string, any>,
  incoming: BookingInput,
): Record<string, any> {
  const patch: Record<string, any> = {}

  for (const f of BOOKING_FILLABLE) {
    if ((existing[f] === null || existing[f] === undefined) && incoming[f] != null) {
      patch[f] = incoming[f]
    }
  }

  // Append notes if new content not already present
  if (incoming.notes) {
    const existingNotes = (existing.notes as string | null) ?? ''
    if (!existingNotes.includes(incoming.notes)) {
      patch.notes = existingNotes ? `${existingNotes}\n${incoming.notes}` : incoming.notes
    }
  }

  return patch
}
