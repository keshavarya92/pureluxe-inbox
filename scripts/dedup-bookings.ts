/**
 * scripts/dedup-bookings.ts
 *
 * One-time booking deduplication script.
 * Dry-run mode by default — set DRY_RUN=false to commit writes.
 *
 * Usage:
 *   npm run dedup:bookings                       # dry-run (safe, no writes)
 *   DRY_RUN=false npm run dedup:bookings         # live run
 *
 * Pass 1 — Safe delete
 *   Remove enquiry-status, no-ref, no-cost rows that have at least one
 *   other row in the same (client_id, property_id, check_in, check_out) group.
 *   If all rows in a group qualify, keep the oldest and delete the rest.
 *
 * Pass 2 — Auto-merge
 *   For groups with consistent total_cost and status: pick a canonical row,
 *   fill its null fields from duplicates (same fill-null logic as
 *   buildBookingPatch in lib/resolvers.ts), append notes, delete duplicates.
 *
 * Pass 3 — Manual review (report only, no writes)
 *   Groups with conflicting cost or status are logged to console with all
 *   row ids and conflicting values. Nothing is written.
 *
 * Transaction semantics (supabase-js does not support native transactions):
 *   All UPDATEs (Pass 2 merges) execute before any DELETE runs.
 *   If an UPDATE fails, execution stops before deletions — no rows are lost.
 *   If a DELETE fails after updates have succeeded, the remaining delete IDs
 *   are emitted as SQL for manual execution.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------

const DRY_RUN = process.env.DRY_RUN !== 'false'
const LOG     = DRY_RUN ? '[DRY-RUN]' : '[DEDUP]  '

if (!process.env.SUPABASE_URL)         throw new Error('Missing SUPABASE_URL')
if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_SERVICE_KEY')

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
)

// ----------------------------------------------------------------
// buildBookingPatch — mirrors the private function in lib/resolvers.ts.
// Cannot import because it is not exported; logic is kept identical.
// Fill null fields on canonical from source; append notes without duplication.
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
  canonical: Record<string, any>,
  source:    Record<string, any>,
): Record<string, any> {
  const patch: Record<string, any> = {}
  for (const f of BOOKING_FILLABLE) {
    if ((canonical[f] === null || canonical[f] === undefined) && source[f] != null) {
      patch[f] = source[f]
    }
  }
  if (source.notes) {
    const existing = (canonical.notes as string | null) ?? ''
    if (!existing.includes(source.notes)) {
      patch.notes = existing ? `${existing}\n${source.notes}` : source.notes
    }
  }
  return patch
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const REF_FIELDS = ['hotel_ref', 'amadeus_ref', 'lhw_ref', 'ottila_ref', 'onyx_ref'] as const

function hasNoRefs(b: Record<string, any>): boolean {
  return REF_FIELDS.every(f => b[f] == null)
}

function isSafeDelete(b: Record<string, any>): boolean {
  return b.status === 'enquiry' && b.total_cost == null && hasNoRefs(b)
}

// ----------------------------------------------------------------
// Fetch all bookings (handles pagination)
// ----------------------------------------------------------------

async function fetchAllBookings(): Promise<Record<string, any>[]> {
  const all: Record<string, any>[] = []
  let from = 0
  const PAGE = 1000

  while (true) {
    const { data, error } = await db
      .from('bookings')
      .select('*')
      .range(from, from + PAGE - 1)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`fetch bookings (offset ${from}): ${error.message}`)
    if (!data?.length) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  return all
}

// ----------------------------------------------------------------
// Group by (client_id, property_id, check_in, check_out)
// Only groups with 2+ rows and both client_id + property_id non-null.
// ----------------------------------------------------------------

interface BookingGroup {
  groupKey: string
  rows:     Record<string, any>[]  // sorted ascending by created_at
}

function groupBookings(bookings: Record<string, any>[]): BookingGroup[] {
  const map = new Map<string, Record<string, any>[]>()

  for (const b of bookings) {
    if (!b.client_id || !b.property_id) continue
    const key = `${b.client_id}|${b.property_id}|${b.check_in}|${b.check_out}`
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(b)
  }

  const groups: BookingGroup[] = []
  for (const [groupKey, rows] of map) {
    if (rows.length > 1) groups.push({ groupKey, rows })
  }
  return groups
}

// ----------------------------------------------------------------
// Pass 1 — identify safe-delete candidates
// ----------------------------------------------------------------

function pass1SafeDeletes(groups: BookingGroup[]): string[] {
  const toDelete: string[] = []

  for (const { rows } of groups) {
    const safeRows    = rows.filter(isSafeDelete)
    const nonSafeRows = rows.filter(r => !isSafeDelete(r))

    if (safeRows.length === 0) continue

    if (nonSafeRows.length > 0) {
      // Non-safe rows survive — delete all safe rows
      for (const r of safeRows) toDelete.push(r.id)
    } else {
      // Every row in the group is a safe-delete candidate.
      // Keep the oldest (rows are sorted asc by created_at); delete the rest.
      for (const r of safeRows.slice(1)) toDelete.push(r.id)
    }
  }

  return [...new Set(toDelete)]
}

// ----------------------------------------------------------------
// Pass 2 — identify auto-merge candidates
// ----------------------------------------------------------------

interface MergeCandidate {
  canonical:  Record<string, any>
  duplicates: Record<string, any>[]
  patch:      Record<string, any>
}

function pass2AutoMerge(
  groups:         BookingGroup[],
  pass1Deletions: Set<string>,
): { merges: MergeCandidate[]; skipped: Record<string, any>[][] } {
  const merges:  MergeCandidate[]        = []
  const skipped: Record<string, any>[][] = []

  for (const { rows } of groups) {
    const remaining = rows.filter(r => !pass1Deletions.has(r.id))
    if (remaining.length <= 1) continue

    const nonNullCosts    = remaining.filter(r => r.total_cost != null)
    const nonNullStatuses = remaining.filter(r => r.status != null)
    const distinctCosts   = [...new Set(nonNullCosts.map(r => String(r.total_cost)))]
    const distinctStatuses = [...new Set(nonNullStatuses.map(r => r.status as string))]

    if (distinctCosts.length > 1 || distinctStatuses.length > 1) {
      skipped.push(remaining)
      continue
    }

    // Canonical: prefer row with at least one ref, otherwise oldest (index 0, asc sort)
    const withRef  = remaining.find(r => !hasNoRefs(r))
    const canonical = withRef ?? remaining[0]
    const duplicates = remaining.filter(r => r.id !== canonical.id)

    // Build merged patch: iterate duplicates, accumulating fills into canonical
    let accumulator = { ...canonical }
    const patch: Record<string, any> = {}
    for (const dup of duplicates) {
      const p = buildBookingPatch(accumulator, dup)
      Object.assign(patch, p)
      Object.assign(accumulator, p)  // let next iteration see already-filled fields
    }

    merges.push({ canonical, duplicates, patch })
  }

  return { merges, skipped }
}

// ----------------------------------------------------------------
// Pass 3 — report conflicting groups (no writes)
// ----------------------------------------------------------------

function pass3Report(skipped: Record<string, any>[][]): number {
  if (skipped.length === 0) return 0

  console.log('\n' + '─'.repeat(62))
  console.log(`PASS 3 — ${skipped.length} group(s) flagged for manual review (read-only)`)
  console.log('─'.repeat(62))

  for (const rows of skipped) {
    const r0 = rows[0]
    console.log(`\n  client_id:   ${r0.client_id}`)
    console.log(`  property_id: ${r0.property_id}`)
    console.log(`  check_in:    ${r0.check_in}   check_out: ${r0.check_out}`)
    console.log(`  rows (${rows.length}):`)
    for (const r of rows) {
      const refs = REF_FIELDS
        .filter(f => r[f] != null)
        .map(f => `${f}=${r[f]}`)
        .join(' ') || '(no refs)'
      const cost   = r.total_cost != null ? String(r.total_cost) : 'null'
      const status = r.status     != null ? r.status as string   : 'null'
      console.log(`    id=${r.id}  status=${status}  total_cost=${cost}  ${refs}`)
    }
  }
  console.log()
  return skipped.length
}

// ----------------------------------------------------------------
// Execute writes (Phase A: all UPDATEs → Phase B: all DELETEs)
// ----------------------------------------------------------------

async function executeWrites(
  pass1Ids: string[],
  merges:   MergeCandidate[],
): Promise<{ deleted: number; merged: number }> {
  let deleted = 0
  let merged  = 0

  // ── Phase A: all UPDATEs before any DELETE ───────────────────
  // If any update fails we stop here — no rows have been removed yet.

  for (const { canonical, patch } of merges) {
    if (!Object.keys(patch).length) {
      console.log(`${LOG} canonical=${canonical.id} no new fields to merge, skip update`)
      continue
    }
    const fields = Object.keys(patch).join(',')
    console.log(`${LOG} merge id=${canonical.id}  fields=${fields}`)
    if (!DRY_RUN) {
      const { error } = await db
        .from('bookings')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', canonical.id)
      if (error) throw new Error(`merge update id=${canonical.id}: ${error.message}`)
    }
    merged++
  }

  // ── Phase B: all DELETEs (Pass 1 + Pass 2 duplicates) ────────
  const pass2DupIds   = merges.flatMap(m => m.duplicates.map(d => d.id))
  const allDeleteIds  = [...new Set([...pass1Ids, ...pass2DupIds])]
  const failedDeletes: string[] = []

  for (const id of allDeleteIds) {
    console.log(`${LOG} delete id=${id}`)
    if (!DRY_RUN) {
      const { error } = await db.from('bookings').delete().eq('id', id)
      if (error) {
        console.error(`  ✗ delete failed id=${id}: ${error.message}`)
        failedDeletes.push(id)
        continue
      }
    }
    deleted++
  }

  if (failedDeletes.length > 0) {
    console.error(`\n${failedDeletes.length} delete(s) failed. Run this SQL manually:`)
    console.error(`DELETE FROM bookings WHERE id IN (${failedDeletes.map(id => `'${id}'`).join(', ')});`)
  }

  return { deleted, merged }
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(62))
  console.log(`  Booking deduplication — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}`)
  console.log('═'.repeat(62) + '\n')

  // ── Fetch and group ───────────────────────────────────────────
  const allBookings = await fetchAllBookings()
  console.log(`Fetched ${allBookings.length} booking(s)`)

  const groups = groupBookings(allBookings)
  console.log(`Found ${groups.length} duplicate group(s)`)

  if (groups.length === 0) {
    console.log('\nNothing to do.\n')
    return
  }

  // ── Pass 1 ───────────────────────────────────────────────────
  const pass1Ids = pass1SafeDeletes(groups)
  console.log(`\nPASS 1 — ${pass1Ids.length} safe-delete candidate(s):`)
  if (pass1Ids.length === 0) {
    console.log('  (none)')
  } else {
    for (const id of pass1Ids) {
      console.log(`  ${LOG} safe-delete id=${id}`)
    }
  }

  // ── Pass 2 ───────────────────────────────────────────────────
  const { merges, skipped } = pass2AutoMerge(groups, new Set(pass1Ids))
  const pass2DupCount = merges.reduce((n, m) => n + m.duplicates.length, 0)
  console.log(`\nPASS 2 — ${merges.length} auto-merge group(s) (${pass2DupCount} duplicate(s) to remove):`)
  if (merges.length === 0) {
    console.log('  (none)')
  } else {
    for (const { canonical, duplicates, patch } of merges) {
      const dupIds   = duplicates.map(d => d.id).join(', ')
      const newFields = Object.keys(patch).join(',') || '(no new fields)'
      console.log(`  ${LOG} canonical=${canonical.id}`)
      console.log(`         merge_fields=${newFields}`)
      console.log(`         delete=[${dupIds}]`)
    }
  }

  // ── Pass 3 (report only) ──────────────────────────────────────
  const flaggedCount = pass3Report(skipped)

  // ── Execute ───────────────────────────────────────────────────
  const { deleted, merged } = await executeWrites(pass1Ids, merges)

  // ── Summary ───────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(62))
  console.log('SUMMARY')
  console.log('─'.repeat(62))
  console.log(`  Rows deleted:              ${deleted}`)
  console.log(`  Canonical rows updated:    ${merged}`)
  console.log(`  Groups flagged for review: ${flaggedCount}`)
  if (DRY_RUN) {
    console.log('\n  ⚠  DRY RUN — no changes were written.')
    console.log('     Re-run with DRY_RUN=false to apply.\n')
  } else {
    console.log('\n  ✓  Live run complete.\n')
  }
}

main().catch(err => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
