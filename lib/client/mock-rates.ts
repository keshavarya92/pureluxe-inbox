// Generated (not live) rate source for the client-facing demo — the
// mockAdapter from build brief §3. Conforms to the same RateSource contract
// every real adapter does (lib/trip-builder/rate-sources.ts), so
// resolveRateRouting()/resolveRateSelection() (lib/trip-builder/rate-routing.ts,
// rate-selection.ts) run against it completely unmodified — Path 5
// (wholesale-first) genuinely exercises this adapter's wholesaler variant
// for Maldives properties (see migration 019's high_value_routing seed),
// it isn't faked at the routing/selection layer.

import type { RateSource, TripContext, NormalizedRate } from '../trip-builder/rate-sources'
import { supabase } from '../supabase'
import { hashSeed, mulberry32, randInt, pick, pickMany } from './seed'

// Room type catalog — size band + a features pool to sample from. Real
// GDS/OTA rate responses carry this kind of structured room detail
// (usually as free-text room descriptions); the mock generates a plausible
// equivalent since there's no live supplier here.
const ROOM_CATALOG: Array<{ name: string; sizeSqmRange: [number, number]; features: string[] }> = [
  { name: 'Garden view room', sizeSqmRange: [38, 48], features: ['Garden view', 'Walk-in rain shower', 'Air conditioning', 'Minibar', 'Daybed'] },
  { name: 'Pool villa', sizeSqmRange: [90, 125], features: ['Private plunge pool', 'Outdoor rain shower', 'Sun deck', 'Minibar', 'Air conditioning', 'Indoor/outdoor bathroom'] },
  { name: 'Beach villa', sizeSqmRange: [100, 140], features: ['Direct beach access', 'Private pool', 'Outdoor bathtub', 'Sun deck', 'Air conditioning', 'Beachfront terrace'] },
  { name: 'Overwater villa', sizeSqmRange: [95, 130], features: ['Direct lagoon access', 'Glass floor panel', 'Private sun deck', 'Outdoor shower', 'Air conditioning', 'Steps to the water'] },
  { name: 'Junior suite', sizeSqmRange: [55, 72], features: ['Separate living area', 'Ocean view', 'Walk-in closet', 'Air conditioning', 'Deep-soak tub'] },
  { name: 'One-bedroom suite', sizeSqmRange: [110, 150], features: ['Separate living/dining area', 'Private terrace', 'Dual vanity bathroom', 'Air conditioning', 'Dressing room'] },
  { name: 'Two-bedroom residence', sizeSqmRange: [200, 280], features: ['Two ensuite bedrooms', 'Full kitchen', 'Private pool', 'Dedicated butler service', 'Private dining pavilion'] },
]
const BOARD_BASES = ['Room only', 'Breakfast included', 'Half board', 'Full board']
const CANCELLATION_POLICIES = [
  'Free cancellation up to 14 days before arrival',
  'Free cancellation up to 30 days before arrival',
  'Non-refundable',
]
const PAYMENT_POLICIES = [
  'Full payment due at time of booking',
  'Deposit of 25% due at booking, balance due 30 days before arrival',
  'Pay at property — no advance payment required',
]

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(`${checkIn}T00:00:00Z`).getTime()
  const b = new Date(`${checkOut}T00:00:00Z`).getTime()
  return Math.max(1, Math.round((b - a) / 86400000))
}

async function lookupProperty(propertyId: string): Promise<{ name: string } | null> {
  const { data, error } = await supabase.from('properties').select('name').eq('id', propertyId).maybeSingle()
  if (error) throw new Error(`mockAdapter: property lookup failed: ${error.message}`)
  return data
}

// Extra fields beyond the shared NormalizedRate contract (which real
// adapters also implement and shouldn't need to grow mock-only fields) —
// carried in NormalizedRate.raw, a free-form field meant for exactly this.
// lib/client/tools.ts reads this back out when persisting a trip_line_item.
export interface MockRateRaw {
  nights:                   number
  roomSize:                 string
  roomFeatures:             string[]
  paymentPolicy:            string
  // Typically GDS rates are loyalty-eligible; wholesale/OTA rates aren't —
  // derived from which mock source produced this rate (id), not randomized.
  loyaltyHotelEligible:     boolean
  loyaltyPureluxeEligible:  boolean
}

// variantIndex selects which of a property's several room categories this
// call generates — lookup_property_rates (lib/client/tools.ts) calls
// fetchRate once per variant it wants, each a genuinely different room
// type/price at a consistent relative position (variant 0 is always the
// cheapest band), rather than one random rate per property.
export function makeMockRateSource(id: string, variantIndex: number = 0): RateSource {
  return {
    id,
    async fetchRate(ctx: TripContext): Promise<NormalizedRate | null> {
      const propertyId = (ctx.propertyIds ?? []).find((p): p is string => !!p) ?? null
      if (!propertyId) throw new Error(`${id}: TripContext has no propertyIds — mock generation requires a property row`)
      if (!ctx.checkIn || !ctx.checkOut) throw new Error(`${id}: TripContext.checkIn/checkOut are required`)

      const property = await lookupProperty(propertyId)
      if (!property) return null

      const nights = nightsBetween(ctx.checkIn, ctx.checkOut)
      const adults = ctx.numAdults ?? 2
      const seedKey = `${property.name}|${ctx.checkIn}|${ctx.checkOut}|${adults}`
      const baseSeed = hashSeed(seedKey)
      // Distinct RNG stream per variant so variant 1/2 aren't just the base
      // rate re-rolled — still fully deterministic given the same
      // (property, dates, guests, variantIndex).
      const rng = mulberry32((baseSeed + variantIndex * 7919) >>> 0)

      const bandFloor = 220 + variantIndex * 260
      const nightlyRate = randInt(rng, bandFloor, bandFloor + 220)
      const room = ROOM_CATALOG[Math.min(variantIndex, ROOM_CATALOG.length - 1)]
      const sizeSqm = randInt(rng, room.sizeSqmRange[0], room.sizeSqmRange[1])
      const featureCount = randInt(rng, 3, Math.min(4, room.features.length))

      // GDS is the only mock source id ('mock_gds') eligible for loyalty
      // points, matching real-world GDS vs. wholesale/OTA behavior — not a
      // random roll.
      const loyaltyEligible = id === 'mock_gds'

      const raw: MockRateRaw = {
        nights,
        roomSize: `${sizeSqm} m²`,
        roomFeatures: pickMany(rng, room.features, featureCount),
        paymentPolicy: pick(rng, PAYMENT_POLICIES),
        loyaltyHotelEligible: loyaltyEligible,
        loyaltyPureluxeEligible: loyaltyEligible,
      }

      return {
        source:              id,
        base_rate:           nightlyRate,
        currency:            'USD',
        property_name:       property.name,
        room_type:           room.name,
        board_basis:         pick(rng, BOARD_BASES),
        cancellation_policy: pick(rng, CANCELLATION_POLICIES),
        raw,
      }
    },
  }
}

// All three RateSourceRegistry slots pointed at the mock — wholesaler is
// keyed by sourceId so Path 5's wholesale-then-fallback flow
// (rate-selection.ts) is still meaningfully exercised: the wholesale
// variant and the gds/bedbank fallback variants are distinct RateSource
// instances (different `id`), so which one "won" stays visible in the
// result even though both are mock-generated.
export function mockRegistry(variantIndex: number = 0) {
  return {
    gds:        makeMockRateSource('mock_gds', variantIndex),
    bedbank:    makeMockRateSource('mock_bedbank', variantIndex),
    wholesaler: (sourceId: string) => makeMockRateSource(sourceId, variantIndex),
  }
}
