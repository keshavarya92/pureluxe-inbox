/**
 * scripts/migrate-refless-bookings.ts
 *
 * One-time cleanup: converts ref-less booking rows to enquiries and deletes them.
 * Dry-run mode by default — set DRY_RUN=false to commit writes.
 *
 * Usage:
 *   npm run migrate:refless-bookings            # dry-run (safe, no writes)
 *   DRY_RUN=false npm run migrate:refless-bookings  # live run
 *
 * Business rule:
 *   Every genuinely confirmed booking has at least one ref column set
 *   (hotel_ref / amadeus_ref / lhw_ref / ottila_ref / onyx_ref).
 *   Rows with all five null are holds / enquiries that were mis-routed
 *   into the bookings table before Fix 2 was applied.
 *
 * Decision logic per ref-less booking:
 *   FLAG     — same (client_id, property_id, check_in, check_out) as a sibling
 *              that DOES have a ref; likely a legitimate multi-room group booking
 *              extra room where the hotel hasn't issued a separate ref yet.
 *              Left alone; printed for manual review.
 *   CONVERT  — no ref-bearing sibling found. Convert to an enquiries row
 *              (field mapping: hotel_name→property_name, total_cost→quoted_rate,
 *              currency→quoted_currency, city+country→destination) and delete
 *              from bookings.
 */

import { createClient } from '@supabase/supabase-js'
import { config }       from 'dotenv'

config({ path: '.env.local' })

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------

const DRY_RUN = process.env.DRY_RUN !== 'false'
const LOG     = DRY_RUN ? '[DRY-RUN]        ' : '[MIGRATE]        '

if (!process.env.SUPABASE_URL)         throw new Error('Missing SUPABASE_URL')
if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_SERVICE_KEY')

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
)

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(62))
  console.log(`  Migrate ref-less bookings — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}`)
  console.log('═'.repeat(62) + '\n')

  // Fetch all bookings
  let allBookings: Record<string, any>[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await db
      .from('bookings')
      .select('*')
      .range(from, from + PAGE - 1)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`fetch bookings: ${error.message}`)
    if (!data?.length) break
    allBookings.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  console.log(`Fetched ${allBookings.length} total bookings`)

  // Partition into ref-bearing and active-ref-less.
  // Exclude checked_out and cancelled — those are completed/closed records, refs or not.
  // They are typically legacy imports (no email_id, no hotel_name, placeholder dates)
  // and must not be converted to enquiries.
  const CLOSED_STATUSES = new Set(['checked_out', 'cancelled'])

  const refBearing = allBookings.filter(b =>
    b.hotel_ref || b.amadeus_ref || b.lhw_ref || b.ottila_ref || b.onyx_ref,
  )
  const refless = allBookings.filter(b =>
    !b.hotel_ref && !b.amadeus_ref && !b.lhw_ref && !b.ottila_ref && !b.onyx_ref
    && !CLOSED_STATUSES.has(b.status ?? ''),
  )
  const skippedClosed = allBookings.filter(b =>
    !b.hotel_ref && !b.amadeus_ref && !b.lhw_ref && !b.ottila_ref && !b.onyx_ref
    && CLOSED_STATUSES.has(b.status ?? ''),
  )

  console.log(`  Ref-bearing:                       ${refBearing.length}`)
  console.log(`  Ref-less (active statuses):        ${refless.length}`)
  console.log(`  Ref-less (checked_out/cancelled):  ${skippedClosed.length}  ← legacy imports, skipped\n`)

  if (refless.length === 0) {
    console.log('Nothing to do.\n')
    return
  }

  // Build index: (client_id|property_id|check_in|check_out) → ref-bearing siblings
  const siblingIndex = new Map<string, Record<string, any>[]>()
  for (const b of refBearing) {
    if (!b.client_id || !b.property_id || !b.check_in || !b.check_out) continue
    const key = `${b.client_id}|${b.property_id}|${b.check_in}|${b.check_out}`
    if (!siblingIndex.has(key)) siblingIndex.set(key, [])
    siblingIndex.get(key)!.push(b)
  }

  console.log('─'.repeat(62))
  console.log('ANALYSIS')
  console.log('─'.repeat(62))

  let converted          = 0
  let flaggedGroup       = 0
  let flaggedCommission  = 0
  let errored            = 0

  for (const b of refless) {
    console.log(`\n  booking ${b.id}`)
    console.log(`    hotel:       ${b.hotel_name ?? '(null)'}`)
    console.log(`    client_name: ${b.client_name ?? '(null)'}  client_id: ${b.client_id ?? 'null'}`)
    console.log(`    check_in:    ${b.check_in}  →  check_out: ${b.check_out}`)
    console.log(`    status:      ${b.status ?? 'null'}  num_rooms: ${b.num_rooms ?? 'null'}`)
    console.log(`    total_cost:  ${b.total_cost ?? 'null'} ${b.currency ?? ''}`)

    // Guard: skip if a received commission exists — real reconciled revenue, do not touch
    const { data: receivedComms, error: commFetchErr } = await db
      .from('commissions')
      .select('id, status, amount_expected')
      .eq('booking_id', b.id)
      .eq('status', 'received')
      .limit(1)
    if (commFetchErr) {
      console.error(`    ERROR fetching commissions: ${commFetchErr.message}`)
      errored++
      continue
    }
    if (receivedComms?.length) {
      const c = receivedComms[0]
      console.log(`    DECISION: FLAG — received commission exists (commission_id=${c.id} amount=${c.amount_expected ?? '?'}) — do not convert`)
      flaggedCommission++
      continue
    }

    // Fetch any pending/null commissions that will need to be deleted first
    const { data: pendingComms, error: pendingFetchErr } = await db
      .from('commissions')
      .select('id, status')
      .eq('booking_id', b.id)
    if (pendingFetchErr) {
      console.error(`    ERROR fetching pending commissions: ${pendingFetchErr.message}`)
      errored++
      continue
    }
    if (pendingComms?.length) {
      console.log(`    pending commission(s): ${pendingComms.map(c => `${c.id}(${c.status ?? 'null'})`).join(', ')} — will delete before booking`)
    }

    // Look for ref-bearing siblings
    const key = b.client_id && b.property_id && b.check_in && b.check_out
      ? `${b.client_id}|${b.property_id}|${b.check_in}|${b.check_out}`
      : null
    const siblings = key ? (siblingIndex.get(key) ?? []) : []

    if (siblings.length > 0) {
      console.log(`    DECISION: FLAG — ${siblings.length} ref-bearing sibling(s) found (possible group booking)`)
      for (const s of siblings) {
        const ref = s.hotel_ref ?? s.amadeus_ref ?? s.lhw_ref ?? s.ottila_ref ?? s.onyx_ref
        console.log(`      sibling ${s.id}  ref=${ref}  rooms=${s.num_rooms ?? '?'}  cost=${s.total_cost ?? '?'}`)
      }
      flaggedGroup++
      continue
    }

    // No ref-bearing sibling — convert to enquiry
    const destination = [b.city, b.country].filter(Boolean).join(', ') || null
    const enqPayload: Record<string, any> = {
      client_id:       b.client_id   ?? null,
      client_name:     b.client_name ?? null,
      property_name:   b.hotel_name  ?? null,
      destination,
      check_in:        b.check_in    ?? null,
      check_out:       b.check_out   ?? null,
      num_rooms:       b.num_rooms   ?? null,
      num_adults:      b.num_adults  ?? null,
      quoted_rate:     b.total_cost  ?? null,
      quoted_currency: b.currency    ?? null,
      notes:           b.notes       ?? null,
      misc:            b.misc        ?? null,
    }

    console.log(`    DECISION: CONVERT to enquiry + delete from bookings`)
    console.log(`    ${LOG} enquiries insert: property="${enqPayload.property_name}" check_in=${enqPayload.check_in}`)

    if (!DRY_RUN) {
      const { error: enqErr } = await db.from('enquiries').insert(enqPayload)
      if (enqErr) {
        console.error(`    ERROR enquiries insert: ${enqErr.message}`)
        errored++
        continue
      }

      // Delete any pending commissions before the booking (FK constraint)
      for (const c of pendingComms ?? []) {
        if (c.status === 'received') {
          // Should never reach here due to the guard above, but log defensively
          console.error(`    ASSERT FAILED: commission ${c.id} has status=received — skipping delete, aborting booking delete`)
          errored++
          continue
        }
        const { error: commDelErr } = await db.from('commissions').delete().eq('id', c.id)
        if (commDelErr) {
          console.error(`    ERROR commissions delete ${c.id}: ${commDelErr.message}`)
          errored++
          continue
        }
        console.log(`    ${LOG} deleted commission ${c.id} (status=${c.status ?? 'null'})`)
      }

      const { error: delErr } = await db.from('bookings').delete().eq('id', b.id)
      if (delErr) {
        console.error(`    ERROR bookings delete: ${delErr.message}`)
        errored++
        continue
      }
      console.log(`    ${LOG} deleted booking ${b.id}`)
    }

    converted++
  }

  // ── Summary ───────────────────────────────────────────────────
  const flaggedTotal = flaggedGroup + flaggedCommission
  console.log('\n' + '─'.repeat(62))
  console.log('SUMMARY')
  console.log('─'.repeat(62))
  console.log(`  Total ref-less (active):           ${refless.length}`)
  console.log(`  Skipped (closed status):           ${skippedClosed.length}  (checked_out/cancelled — legacy imports)`)
  console.log(`  ${DRY_RUN ? 'Would convert' : 'Converted'} to enquiries:    ${converted}`)
  console.log(`  ${DRY_RUN ? 'Would delete ' : 'Deleted      '} from bookings: ${converted}`)
  console.log(`  Flagged — group booking siblings:  ${flaggedGroup}`)
  console.log(`  Flagged — received commission:     ${flaggedCommission}`)
  console.log(`  Flagged total:                     ${flaggedTotal}`)
  if (errored) console.log(`  Errors (skipped):                  ${errored}`)

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
