import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } })

async function main() {
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString()

  // Per-day creation rate
  const { data: recentB } = await db.from('bookings').select('created_at').gte('created_at', since7d).order('created_at')
  const byDay: Record<string, number> = {}
  for (const b of recentB ?? []) {
    const d = (b.created_at as string).slice(0, 10)
    byDay[d] = (byDay[d] ?? 0) + 1
  }
  console.log('--- Bookings per day (last 7d) ---')
  for (const [day, n] of Object.entries(byDay)) console.log(` ${day}: ${n}`)

  // Thread-keyed bookings
  const { data: threaded } = await db.from('bookings')
    .select('created_at, client_name, hotel_name, check_in, check_out')
    .not('source_thread_id', 'is', null)
    .order('created_at', { ascending: false })
  console.log(`\n--- Bookings with source_thread_id (${threaded?.length ?? 0}) ---`)
  for (const b of threaded ?? []) {
    console.log(` ${(b.created_at as string).slice(0,16)}  ${b.client_name ?? '(null)'}  ${b.hotel_name ?? '(null)'}  ${b.check_in}->${b.check_out}`)
  }

  // Duplicate detection: same (client_id, check_in, check_out)
  const { data: allB } = await db.from('bookings').select('id, client_id, client_name, check_in, check_out, hotel_name, created_at').gte('created_at', since7d)
  const seen = new Map<string, any[]>()
  for (const b of allB ?? []) {
    if (!b.client_id || !b.check_in || !b.check_out) continue
    const key = `${b.client_id}|${b.check_in}|${b.check_out}`
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key)!.push(b)
  }
  const dups = [...seen.entries()].filter(([, rows]) => rows.length > 1)
  console.log(`\n--- Duplicate (client+check_in+check_out) groups last 7d: ${dups.length} ---`)
  for (const [, rows] of dups.slice(0, 15)) {
    console.log(` ${rows[0].hotel_name ?? '?'}  ${rows[0].check_in}->${rows[0].check_out}  client=${rows[0].client_name ?? '?'}  (${rows.length} rows)`)
  }
  if (dups.length > 15) console.log(` ... and ${dups.length - 15} more`)
}

main().catch(err => { console.error(err); process.exit(1) })
