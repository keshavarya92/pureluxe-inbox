// One-off test harness for resolveRateRouting() (lib/trip-builder/rate-routing.ts).
// Seeds one row per config table, runs the four checklist scenarios from the
// migration 016 session brief, then deletes its own seed rows so the tables
// are left empty afterward. Requires migration 016 to already be applied.
//
// Run: npx tsx scripts/test-rate-routing.ts

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } })

async function main() {
  // Imported after dotenv config() so lib/supabase.ts (which reads
  // process.env at module init) sees the loaded vars — same pattern as
  // scripts/dedup-clients.ts.
  const { resolveRateRouting } = await import('../lib/trip-builder/rate-routing')

  const seededIds: { table: string; id: string }[] = []

  const { data: offline, error: offlineErr } = await db
    .from('offline_trip_types').insert({ trip_type: 'safari' }).select('id').single()
  if (offlineErr) throw new Error(`seed offline_trip_types: ${offlineErr.message}`)
  seededIds.push({ table: 'offline_trip_types', id: offline.id })

  const { data: highValue, error: highValueErr } = await db
    .from('high_value_routing')
    .insert({ destination: 'Maldives', wholesale_source: 'Cinnamon Wholesale' })
    .select('id').single()
  if (highValueErr) throw new Error(`seed high_value_routing: ${highValueErr.message}`)
  seededIds.push({ table: 'high_value_routing', id: highValue.id })

  const { data: wholesaler, error: wholesalerErr } = await db
    .from('wholesaler_destinations')
    .insert({ destination: 'Sri Lanka', wholesaler_name: 'Pure Escapes', api_source: 'pure_escapes_api', active: true })
    .select('id').single()
  if (wholesalerErr) throw new Error(`seed wholesaler_destinations: ${wholesalerErr.message}`)
  seededIds.push({ table: 'wholesaler_destinations', id: wholesaler.id })

  let pass = 0
  let fail = 0
  function check(label: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`)
    console.log(`  expected: ${JSON.stringify(expected)}`)
    console.log(`  actual:   ${JSON.stringify(actual)}`)
    if (ok) pass++; else fail++
  }

  try {
    check(
      '1. safari trip type -> path 1',
      await resolveRateRouting({ tripType: 'safari', destinations: ['Kenya'] }),
      { path: 1 },
    )

    check(
      '2. high_value_routing destination (Maldives) -> path 5',
      await resolveRateRouting({ destinations: ['Maldives'] }),
      { path: 5, wholesale_source: 'Cinnamon Wholesale' },
    )

    check(
      "3. wholesaler_destinations destination (Sri Lanka, not in high_value_routing) -> path '2-4' with wholesaler",
      await resolveRateRouting({ destinations: ['Sri Lanka'] }),
      { path: '2-4', wholesaler: 'Pure Escapes', wholesale_source: 'pure_escapes_api' },
    )

    check(
      "4. unrelated destination (Paris) -> path '2-4' with no wholesaler",
      await resolveRateRouting({ destinations: ['Paris'] }),
      { path: '2-4' },
    )
  } finally {
    for (const { table, id } of seededIds) {
      const { error } = await db.from(table).delete().eq('id', id)
      if (error) console.error(`cleanup failed for ${table}.${id}: ${error.message}`)
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
