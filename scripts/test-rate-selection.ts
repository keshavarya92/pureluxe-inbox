// Test harness for resolveRateSelection() (lib/trip-builder/rate-selection.ts).
// Checks 1-5 use an injectable RateSourceRegistry with call-counting fake
// adapters instead of the real ones — necessary to exercise "lowest rate
// wins" or "retry fires exactly once" deterministically, since gds/
// hotelbeds are now real integrations that won't reliably return a
// specific rate on demand. Check 6 is a wiring smoke test against the real
// default adapters; check 7 exercises the real hotelbedsAdapter end-to-end
// (seeds a temporary properties row, cleans it up after) — skipped with a
// clear message if HOTELBEDS_API_KEY/HOTELBEDS_SECRET aren't set. Checks
// 8-10 cover resolveBookableHotelbedsRate's CheckRate branch via fixtures
// (no credentials needed) — see that function's doc comment for why.
//
// Run: npx tsx scripts/test-rate-selection.ts

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import type { RateSourceRegistry } from '../lib/trip-builder/rate-selection'
import type { RateSource, NormalizedRate, TripContext } from '../lib/trip-builder/rate-sources'
import type { RateRoutingResult } from '../lib/trip-builder/rate-routing'
import type { HotelbedsRate } from '../lib/trip-builder/hotelbeds/hotel-search'

function fixtureHotelbedsRate(overrides: Partial<HotelbedsRate>): HotelbedsRate {
  return {
    rateKey: 'FIXTURE-RATEKEY', roomCode: 'DBL.ST', roomName: 'Double Standard',
    boardCode: 'BB', boardName: 'BED AND BREAKFAST', net: 150, currency: 'EUR',
    rateClass: 'NOR', rateType: 'BOOKABLE', packaging: false, cancellationPolicies: [],
    taxesAllIncluded: null, rateCommentsId: undefined, rateComments: undefined, promotions: [],
    ...overrides,
  }
}

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } })

function fakeSource(id: string, behavior: (call: number) => Promise<NormalizedRate | null>): RateSource & { calls: number } {
  const source = {
    id,
    calls: 0,
    async fetchRate(_ctx: TripContext) {
      source.calls += 1
      return behavior(source.calls)
    },
  }
  return source
}

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `\n  ${detail}` : ''}`)
  if (cond) pass++; else fail++
}

const emptyCtx: TripContext = {}

async function main() {
  // Imported after dotenv config() so lib/supabase.ts (pulled in
  // transitively via rate-sources.ts's gdsAdapter/hotelbedsAdapter, which
  // read process.env at module init) sees the loaded vars — same pattern
  // as scripts/dedup-clients.ts and scripts/test-rate-routing.ts.
  const { resolveRateSelection, defaultRateSources } = await import('../lib/trip-builder/rate-selection')
  const { resolveBookableHotelbedsRate } = await import('../lib/trip-builder/rate-sources')

  // ---------------------------------------------------------------
  // 1. Path 1 -> consultant_required, zero adapter calls
  // ---------------------------------------------------------------
  {
    const gds = fakeSource('gds', async () => null)
    const bedbank = fakeSource('bedbank', async () => null)
    const wholesalerCalls: string[] = []
    const registry: RateSourceRegistry = {
      gds, bedbank,
      wholesaler: (id) => { wholesalerCalls.push(id); return fakeSource(id, async () => null) },
    }
    const routing: RateRoutingResult = { path: 1 }
    const result = await resolveRateSelection(routing, emptyCtx, registry)

    check('1. path 1 -> status consultant_required', result.status === 'consultant_required')
    check('1. path 1 -> no adapter calls made', gds.calls === 0 && bedbank.calls === 0 && wholesalerCalls.length === 0,
      `gds.calls=${gds.calls} bedbank.calls=${bedbank.calls} wholesaler_constructed=${wholesalerCalls.length}`)
    check('1. path 1 -> sources_checked empty', result.sources_checked.length === 0)
  }

  // ---------------------------------------------------------------
  // 2. Path 5, wholesale hit -> rate_found, advisory_flag true, no fallback calls
  // ---------------------------------------------------------------
  {
    const gds = fakeSource('gds', async () => { throw new Error('gds should not be called when wholesale succeeds') })
    const bedbank = fakeSource('bedbank', async () => { throw new Error('bedbank should not be called when wholesale succeeds') })
    const registry: RateSourceRegistry = {
      gds, bedbank,
      wholesaler: (id) => fakeSource(id, async () => ({ source: id, base_rate: 500, currency: 'USD' })),
    }
    const routing: RateRoutingResult = { path: 5, wholesale_source: 'cinnamon_wholesale' }
    const result = await resolveRateSelection(routing, emptyCtx, registry)

    check('2. path 5 wholesale hit -> status rate_found', result.status === 'rate_found')
    check('2. path 5 wholesale hit -> advisory_flag true',
      result.status === 'rate_found' && result.rate.advisory_flag === true)
    check('2. path 5 wholesale hit -> no fallback calls', gds.calls === 0 && bedbank.calls === 0)
  }

  // ---------------------------------------------------------------
  // 3. Path 5, wholesale null -> fallback fires, bedbank rate wins, advisory_flag false
  // ---------------------------------------------------------------
  {
    const gds = fakeSource('gds', async () => null)
    const bedbank = fakeSource('bedbank', async () => ({ source: 'bedbank', base_rate: 300, currency: 'USD' }))
    const registry: RateSourceRegistry = {
      gds, bedbank,
      wholesaler: (id) => fakeSource(id, async () => null),
    }
    const routing: RateRoutingResult = { path: 5, wholesale_source: 'cinnamon_wholesale' }
    const result = await resolveRateSelection(routing, emptyCtx, registry)

    check('3. path 5 wholesale null -> fallback fires (gds+bedbank called)', gds.calls === 1 && bedbank.calls === 1,
      `gds.calls=${gds.calls} bedbank.calls=${bedbank.calls}`)
    check('3. path 5 wholesale null -> status rate_found', result.status === 'rate_found')
    check('3. path 5 wholesale null -> advisory_flag false',
      result.status === 'rate_found' && result.rate.advisory_flag === false)
    check('3. path 5 wholesale null -> rate from bedbank',
      result.status === 'rate_found' && result.rate.base_rate === 300 && result.rate.source === 'bedbank')
  }

  // ---------------------------------------------------------------
  // 4. Path 2-4 -> lowest base_rate wins across gds/bedbank/wholesaler
  // ---------------------------------------------------------------
  {
    const gds = fakeSource('gds', async () => ({ source: 'gds', base_rate: 450, currency: 'USD' }))
    const bedbank = fakeSource('bedbank', async () => ({ source: 'bedbank', base_rate: 300, currency: 'USD' }))
    const registry: RateSourceRegistry = {
      gds, bedbank,
      wholesaler: (id) => fakeSource(id, async () => ({ source: id, base_rate: 550, currency: 'USD' })),
    }
    const routing: RateRoutingResult = { path: '2-4', wholesaler: 'Pure Escapes', wholesale_source: 'pure_escapes_api' }
    const result = await resolveRateSelection(routing, emptyCtx, registry)

    check('4. path 2-4 -> status rate_found', result.status === 'rate_found')
    check('4. path 2-4 -> lowest rate (bedbank, 300) wins',
      result.status === 'rate_found' && result.rate.base_rate === 300 && result.rate.source === 'bedbank',
      result.status === 'rate_found' ? `got source=${result.rate.source} base_rate=${result.rate.base_rate}` : undefined)
    check('4. path 2-4 -> advisory_flag false',
      result.status === 'rate_found' && result.rate.advisory_flag === false)
    check('4. path 2-4 -> wholesaler included in sources_checked', result.sources_checked.includes('pure_escapes_api'))
  }

  // ---------------------------------------------------------------
  // 5. Path 2-4, all empty -> retry fires exactly once, then consultant_required
  // ---------------------------------------------------------------
  {
    const gds = fakeSource('gds', async () => null)
    const bedbank = fakeSource('bedbank', async () => null)
    const registry: RateSourceRegistry = {
      gds, bedbank,
      wholesaler: (id) => fakeSource(id, async () => null),
    }
    const routing: RateRoutingResult = { path: '2-4' } // no wholesaler this time
    const result = await resolveRateSelection(routing, emptyCtx, registry)

    check('5. all-empty -> retry fired exactly once (2 calls per source)', gds.calls === 2 && bedbank.calls === 2,
      `gds.calls=${gds.calls} bedbank.calls=${bedbank.calls}`)
    check('5. all-empty -> status consultant_required', result.status === 'consultant_required')
  }

  // ---------------------------------------------------------------
  // 6. Smoke test against the REAL default adapters (gds/hotelbeds are
  //    real integrations now; wholesaler is still a stub). No config is
  //    given here (empty TripContext, no credentials required), so gds
  //    and hotelbeds both throw their own "missing checkIn/checkOut" /
  //    "not configured" errors immediately — resolveRateSelection catches
  //    those per-source and should still land on consultant_required after
  //    the retry, same as before real wiring. This is a wiring/error-
  //    handling smoke test, not a live-API test — see check 7 for that.
  // ---------------------------------------------------------------
  {
    const routing: RateRoutingResult = { path: '2-4' }
    const result = await resolveRateSelection(routing, emptyCtx, defaultRateSources)
    check('6. real default adapters, no config -> consultant_required (errors caught, not thrown)', result.status === 'consultant_required')
  }

  // ---------------------------------------------------------------
  // 7. Real hotelbedsAdapter end-to-end: seeds a temporary properties row
  //    mapped to a known Hotelbeds test hotel code, calls the actual
  //    adapter (via defaultRateSources.bedbank) with a matching
  //    TripContext, then deletes the seeded row. Skipped — not failed —
  //    if HOTELBEDS_API_KEY/HOTELBEDS_SECRET aren't set, since there's
  //    nothing to test against yet.
  // ---------------------------------------------------------------
  if (!process.env.HOTELBEDS_API_KEY || !process.env.HOTELBEDS_SECRET) {
    console.log('SKIP — 7. real hotelbedsAdapter end-to-end (HOTELBEDS_API_KEY/HOTELBEDS_SECRET not set)')
  } else {
    const testHotelCode = process.env.HOTELBEDS_TEST_HOTEL_CODE ?? '3424'
    const { data: seeded, error: seedErr } = await db
      .from('properties')
      .insert({ name: '[test-rate-selection] Hotelbeds smoke property', hotelbeds_hotel_code: testHotelCode })
      .select('id').single()

    if (seedErr) {
      check('7. real hotelbedsAdapter end-to-end', false, `seed failed: ${seedErr.message}`)
    } else {
      try {
        const checkIn  = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
        const checkOut = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10)
        const ctx: TripContext = { propertyIds: [seeded.id], checkIn, checkOut, numAdults: 2, numRooms: 1 }

        const rate = await defaultRateSources.bedbank.fetchRate(ctx)
        if (rate === null) {
          console.log(`NOTE — 7. real hotelbedsAdapter: auth/API call succeeded but returned no availability for hotelCode=${testHotelCode} ${checkIn}->${checkOut} (inconclusive, not a failure — try HOTELBEDS_TEST_HOTEL_CODE=<code> for a known-available hotel)`)
        } else {
          check('7. real hotelbedsAdapter end-to-end -> rate returned with base_rate/currency',
            typeof rate.base_rate === 'number' && !!rate.currency,
            `rate=${JSON.stringify(rate)}`)
        }
      } catch (err) {
        check('7. real hotelbedsAdapter end-to-end', false, `threw: ${err instanceof Error ? err.message : err}`)
      } finally {
        await db.from('properties').delete().eq('id', seeded.id)
      }
    }
  }

  // ---------------------------------------------------------------
  // 8-10. resolveBookableHotelbedsRate branch coverage, via the injectable
  // checkRateFn param. Necessary because neither known-good sandbox hotel
  // (3424, 1070) has ever produced a RECHECK rate — this is the only way
  // to cover the CheckRate branch without live credentials or waiting for
  // Hotelbeds to hand us a RECHECK rate organically.
  // ---------------------------------------------------------------
  {
    const bookable = fixtureHotelbedsRate({ rateType: 'BOOKABLE', net: 100 })
    let checkRateCalls = 0
    const result = await resolveBookableHotelbedsRate(bookable, async () => { checkRateCalls++; return null })
    check('8. BOOKABLE rate -> checkRateFn never called', checkRateCalls === 0)
    check('8. BOOKABLE rate -> returned unchanged', result === bookable)
  }
  {
    const recheck = fixtureHotelbedsRate({ rateType: 'RECHECK', rateKey: 'NEEDS-RECHECK', net: 100 })
    const rechecked = fixtureHotelbedsRate({ rateType: 'BOOKABLE', rateKey: 'NEEDS-RECHECK', net: 105 })
    const result = await resolveBookableHotelbedsRate(recheck, async (key) => (key === 'NEEDS-RECHECK' ? rechecked : null))
    check('9. RECHECK rate, checkRateFn resolves a rate -> that rate returned', result === rechecked,
      `result=${JSON.stringify(result)}`)
  }
  {
    const recheck = fixtureHotelbedsRate({ rateType: 'RECHECK', net: 100 })
    const result = await resolveBookableHotelbedsRate(recheck, async () => null)
    check('10. RECHECK rate, checkRateFn resolves null -> null (unavailable)', result === null)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
