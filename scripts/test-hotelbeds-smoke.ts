// Real Hotelbeds sandbox smoke test — one known hotel code + date range,
// hitting lib/trip-builder/hotelbeds/hotel-search.ts's searchAvailability()
// directly (bypassing the properties DB lookup that hotelbedsAdapter does)
// so this isolates "does auth + the Availability API call work at all"
// from "is a property mapped in our DB." Confirms signature auth succeeds
// and prints the raw parsed rate shape — the actual field-by-field answer
// to whether resort fees ride inline in `net` or show up as a separate
// taxes[] entry, which the docs alone can't settle.
//
// Test hotel code 3424 is Hotelbeds' own documentation example (see
// developer.hotelbeds.com/documentation/hotels/booking-api/workflow/) —
// not confirmed as a guaranteed-available sandbox fixture, so a clean
// zero-availability result here is inconclusive, not a failure signal.
// If it comes back empty, rerun with a hotel code from your Hotelbeds
// account manager / the Postman collection's known-good test data.
//
// Run: npx tsx scripts/test-hotelbeds-smoke.ts [hotelCode]

import { config } from 'dotenv'
config({ path: '.env.local' })

async function main() {
  if (!process.env.HOTELBEDS_API_KEY || !process.env.HOTELBEDS_SECRET) {
    console.log('SKIP — HOTELBEDS_API_KEY / HOTELBEDS_SECRET not set in .env.local. Nothing to test yet.')
    return
  }

  const { searchAvailability } = await import('../lib/trip-builder/hotelbeds/hotel-search')

  const hotelCode = process.argv[2] ?? '3424'

  // 30 days out, 1-night stay — safely inside any reasonable booking window.
  const checkIn  = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  const checkOut = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10)

  console.log(`Requesting availability: hotelCode=${hotelCode} checkIn=${checkIn} checkOut=${checkOut}`)

  try {
    const result = await searchAvailability({ hotelCode, checkIn, checkOut, adults: 2, children: 0, rooms: 1 })
    console.log(`\nAuth succeeded — Availability API responded.`)
    console.log(`found=${result.found} hotelName=${result.hotelName} currency=${result.currency} rateCount=${result.rates.length}`)

    if (result.rates.length) {
      const cheapest = result.rates.reduce((best, r) => (r.net < best.net ? r : best))
      // Called out explicitly, not just buried in the JSON dump below: this
      // is the field that decides whether resolveBookableHotelbedsRate's
      // CheckRate branch fires. Neither known-good sandbox hotel (3424,
      // 1070) has ever returned RECHECK as of 2026-08-12 — if this ever
      // prints RECHECK, it's the first real chance to validate that branch
      // against live data instead of just the fixture test.
      console.log(`\nCheapest rate rateType=${cheapest.rateType} ${cheapest.rateType === 'RECHECK' ? '<<< first live RECHECK seen, worth a closer look' : '(no CheckRate call needed)'}`)
      console.log('\nCheapest rate (full parsed shape):')
      console.log(JSON.stringify(cheapest, null, 2))
    } else {
      console.log('\nNo rates for this hotel/date range — inconclusive for auth (auth clearly worked, since we got a well-formed response), but nothing to inspect for the resort-fee/taxes question. Try a different hotel code or date range.')
    }
  } catch (err) {
    console.error('\nFAILED —', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

main()
