/**
 * scripts/backfill-checked-out.ts
 *
 * One-time backfill: flips bookings that are still marked 'confirmed' but
 * whose check_out date has already passed to 'checked_out'. Going forward
 * this transition happens automatically via the daily
 * /api/cron/checkout-transition cron job — this script only exists to fix
 * rows that predate that cron.
 *
 * Dry-run mode by default — set DRY_RUN=false to commit writes.
 *
 * Usage:
 *   npm run backfill:checked-out                # dry-run (safe, no writes)
 *   DRY_RUN=false npm run backfill:checked-out   # live run
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const DRY_RUN = process.env.DRY_RUN !== 'false'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } }
)

async function main() {
  const today = new Date().toISOString().slice(0, 10)

  const { data: expired, error: fetchError } = await supabase
    .from('bookings')
    .select('id, client_name, hotel_name, check_out')
    .eq('status', 'confirmed')
    .lt('check_out', today)
    .order('check_out', { ascending: true })

  if (fetchError) throw new Error(fetchError.message)

  if (!expired?.length) {
    console.log('No confirmed bookings with a past check_out date. Nothing to do.')
    return
  }

  console.log(`Found ${expired.length} confirmed booking(s) with check_out before ${today}:`)
  for (const b of expired.slice(0, 20)) {
    console.log(`  ${b.check_out}  ${b.client_name ?? '—'}  @ ${b.hotel_name ?? '—'}  (${b.id})`)
  }
  if (expired.length > 20) console.log(`  ...and ${expired.length - 20} more`)

  if (DRY_RUN) {
    console.log('\nDRY RUN — no writes made. Set DRY_RUN=false to commit.')
    return
  }

  const { error: updateError } = await supabase
    .from('bookings')
    .update({ status: 'checked_out', updated_at: new Date().toISOString() })
    .eq('status', 'confirmed')
    .lt('check_out', today)

  if (updateError) throw new Error(updateError.message)

  console.log(`\nUpdated ${expired.length} booking(s) to checked_out.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
