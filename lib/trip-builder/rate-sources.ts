/**
 * rate-sources.ts — the RateSource adapter contract plus every adapter
 * implementation. resolveRateSelection() (rate-selection.ts) is the only
 * caller; nothing else should import individual adapters directly.
 *
 * gdsAdapter is real — ported from the standalone pureluxe-rates prototype
 * (see lib/trip-builder/sabre/*). hotelbedsAdapter is also now real (see
 * lib/trip-builder/hotelbeds/*) — HOTELBEDS_API_KEY/HOTELBEDS_SECRET were
 * previously missing from this repo entirely despite BUILD_TRACKER.md's
 * tracker sheet claiming a Hotelbeds sandbox adapter was "In Use"; both are
 * now set in .env.local. The wholesaler adapters remain stubs returning
 * null (genuine "no availability") — no wholesaler integration exists yet.
 * Each stub matches the real fetchRate(tripContext) → NormalizedRate | null
 * signature exactly, so wiring a real call later is a body swap, not an
 * interface change.
 */

import { supabase } from '../supabase'
import { geoLookup } from './sabre/geo-lookup'
import { searchHotels, getHotelRates, type SabreAvailProperty, type SabreRate } from './sabre/hotel-search'
import { mapBoardBasis, formatCancellation, calcNights } from './sabre/format'
import { searchAvailability, checkRate, type HotelbedsRate } from './hotelbeds/hotel-search'
import { mapBoardBasis as mapHotelbedsBoardBasis, formatCancellation as formatHotelbedsCancellation } from './hotelbeds/format'

// ----------------------------------------------------------------
// TripContext — the subset of trip/leg data a rate lookup needs.
// Deliberately a superset of RateRoutingInput (rate-routing.ts): routing
// only needs trip type/destination/property to pick a path, but an actual
// rate fetch also needs stay dates and occupancy.
// ----------------------------------------------------------------

export interface TripContext {
  destinations?: Array<string | null | undefined> | null
  propertyIds?:  Array<string | null | undefined> | null
  checkIn?:      string | null
  checkOut?:     string | null
  numAdults?:    number | null
  numChildren?:  number | null
  // One age per child, required by Hotelbeds once numChildren > 0 (see
  // hotelbeds/hotel-search.ts). Modeled on the shared TripContext rather
  // than as a Hotelbeds-only param since occupancy composition is already
  // trip-level here, not supplier-specific — ages are just the missing
  // piece of the same fact.
  childAges?:    Array<number | null> | null
  numRooms?:     number | null
}

// ----------------------------------------------------------------
// NormalizedRate — the common shape every adapter converts its own
// response into, so resolveRateSelection can compare across sources
// without knowing which one produced a given rate.
// ----------------------------------------------------------------

export interface NormalizedRate {
  source:              string
  base_rate:           number
  currency:            string
  property_name?:      string | null
  room_type?:          string | null
  board_basis?:        string | null
  cancellation_policy?: string | null
  // Adapter's original response, kept for debugging — never read by
  // resolveRateSelection's own logic.
  raw?:                unknown
}

// ----------------------------------------------------------------
// RateSourceError — thrown by an adapter for a genuine failure (network,
// auth, malformed response). A source returning null instead means "asked
// successfully, nothing available" — resolveRateSelection treats the two
// very differently: null is a normal outcome to compare against other
// sources, an error is caught, logged, and counted separately so a down
// supplier doesn't silently look identical to "sold out."
// ----------------------------------------------------------------

export class RateSourceError extends Error {
  readonly sourceId: string

  constructor(sourceId: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RateSourceError'
    this.sourceId = sourceId
  }
}

// ----------------------------------------------------------------
// RateSource — the adapter contract. fetchRate resolves to a NormalizedRate
// on availability, null on genuine zero-availability, or throws
// RateSourceError (or lets a lower-level error propagate) on failure.
// ----------------------------------------------------------------

export interface RateSource {
  id: string
  fetchRate(ctx: TripContext): Promise<NormalizedRate | null>
}

// ----------------------------------------------------------------
// GDS adapter — Sabre. A fetchRate() call is for one specific line item,
// so only the first propertyId/destination in TripContext is used, same
// assumption resolveRateSelection already makes elsewhere (one adapter
// call -> one NormalizedRate, not a list). No currency field exists on
// TripContext yet, so this defaults to USD, matching the Sabre calls'
// own default when nothing else is specified.
//
// A missing/unresolvable destination or property, missing Sabre config,
// or a Sabre API/network failure all propagate as a thrown error — the
// RateSource contract above allows that, and resolveRateSelection already
// catches, logs, and records it per-source rather than crashing. Only a
// successful Sabre call that genuinely found nothing bookable returns
// null.
// ----------------------------------------------------------------

async function resolveHotelCode(ctx: TripContext): Promise<{ hotelCode: string } | { destination: string; propertyName: string | null } > {
  const propertyId  = (ctx.propertyIds  ?? []).find((p): p is string => !!p) ?? null
  const destination = (ctx.destinations ?? []).find((d): d is string => !!d?.trim()) ?? null

  if (propertyId) {
    const { data, error } = await supabase
      .from('properties')
      .select('name, sabre_hotel_code')
      .eq('id', propertyId)
      .maybeSingle()
    if (error) throw new Error(`gdsAdapter: failed to look up property ${propertyId}: ${error.message}`)

    if (data?.sabre_hotel_code) return { hotelCode: data.sabre_hotel_code }
    if (destination) return { destination, propertyName: data?.name ?? null }
    throw new Error(`gdsAdapter: property ${propertyId} has no sabre_hotel_code and TripContext has no destination to search by name`)
  }

  if (destination) return { destination, propertyName: null }

  throw new Error('gdsAdapter: TripContext has no propertyIds or destinations to search')
}

function pickTarget(properties: SabreAvailProperty[], propertyName: string | null): SabreAvailProperty | null {
  if (propertyName) {
    const lower = propertyName.toLowerCase()
    return properties.find(p => p.hotelName?.toLowerCase().includes(lower)) ?? null
  }
  // No specific property requested — cheapest lead rate wins, falling
  // back to the first result when lead rates are missing.
  const withLeadRate = properties.filter(p => p.leadRate != null)
  if (withLeadRate.length === 0) return properties[0] ?? null
  return withLeadRate.reduce((best, p) => (p.leadRate! < best.leadRate! ? p : best))
}

function pickCheapestRate(rates: SabreRate[]): SabreRate | null {
  if (rates.length === 0) return null
  return rates.reduce((best, r) => (r.amountBeforeTax < best.amountBeforeTax ? r : best))
}

export const gdsAdapter: RateSource = {
  id: 'gds',
  async fetchRate(ctx: TripContext): Promise<NormalizedRate | null> {
    const checkIn  = ctx.checkIn
    const checkOut = ctx.checkOut
    if (!checkIn || !checkOut) throw new Error('gdsAdapter: TripContext.checkIn/checkOut are required to search Sabre')

    const adults   = ctx.numAdults   ?? 1
    const children = ctx.numChildren ?? 0
    const rooms    = ctx.numRooms    ?? 1
    const currency = 'USD' // TripContext has no currency field yet

    const resolved = await resolveHotelCode(ctx)

    let hotelCode: string
    if ('hotelCode' in resolved) {
      hotelCode = resolved.hotelCode
    } else {
      const geo = await geoLookup(resolved.destination)
      if (!geo.code) throw new Error(`gdsAdapter: could not resolve "${resolved.destination}" to an IATA city code`)

      const avail = await searchHotels({ destination: geo.code, checkIn, checkOut, adults, children, rooms, currency })
      if (avail.notInSabre || avail.properties.length === 0) return null

      const target = pickTarget(avail.properties, resolved.propertyName)
      if (!target?.hotelCode) return null
      hotelCode = target.hotelCode
    }

    const ratesResult = await getHotelRates({ hotelCode, checkIn, checkOut, adults, children, rooms, currency })
    const best = pickCheapestRate(ratesResult.rates)
    if (!best) return null

    const nights = calcNights(checkIn, checkOut)
    const baseRate = best.averageNightlyRate > 0
      ? best.averageNightlyRate
      : +(best.amountBeforeTax / nights).toFixed(2)

    return {
      source:              'gds',
      base_rate:           baseRate,
      currency:            best.currency ?? currency,
      property_name:       ratesResult.propertyInfo?.HotelName ?? null,
      room_type:           best.roomDescription ?? null,
      board_basis:         mapBoardBasis(best.boardBasis),
      cancellation_policy: formatCancellation(best.cancellation, best.isRefundable),
      raw:                 { rate: best, hotelCode, partial: ratesResult.partial },
    }
  },
}

// ----------------------------------------------------------------
// Hotelbeds adapter (bedbank). A fetchRate() call is for one specific line
// item, so — same assumption gdsAdapter makes above — only the first
// propertyId in TripContext is used. Unlike Sabre, Hotelbeds has no
// destination-level search wired here: it only searches a hotel code
// already mapped in properties.hotelbeds_hotel_code (migration 018).
// Destinations alone (no mapped property) aren't enough to call this
// adapter — that would need a separate Hotelbeds destination-code lookup,
// out of scope for this session.
//
// A missing/unmapped property, missing Hotelbeds config, or a Hotelbeds
// API/network failure all propagate as a thrown error — the RateSource
// contract allows that, and resolveRateSelection already catches, logs,
// and records it per-source rather than crashing. Only a successful
// Hotelbeds call that genuinely found nothing bookable returns null.
// ----------------------------------------------------------------

async function resolveHotelbedsHotelCode(ctx: TripContext): Promise<{ hotelCode: string; propertyName: string | null }> {
  const propertyId = (ctx.propertyIds ?? []).find((p): p is string => !!p) ?? null
  if (!propertyId) throw new Error('hotelbedsAdapter: TripContext has no propertyIds — Hotelbeds search requires a mapped property')

  const { data, error } = await supabase
    .from('properties')
    .select('name, hotelbeds_hotel_code')
    .eq('id', propertyId)
    .maybeSingle()
  if (error) throw new Error(`hotelbedsAdapter: failed to look up property ${propertyId}: ${error.message}`)
  if (!data?.hotelbeds_hotel_code) {
    throw new Error(`hotelbedsAdapter: property ${propertyId} has no hotelbeds_hotel_code mapped — set properties.hotelbeds_hotel_code before this adapter can search it`)
  }

  return { hotelCode: data.hotelbeds_hotel_code, propertyName: data.name ?? null }
}

function pickCheapestHotelbedsRate(rates: HotelbedsRate[]): HotelbedsRate | null {
  if (rates.length === 0) return null
  return rates.reduce((best, r) => (r.net < best.net ? r : best))
}

// Certification workflow rule 2.5: a rate returned as rateType 'RECHECK'
// must be re-verified via CheckRate before it's treated as bookable; a
// 'BOOKABLE' rate must NOT be re-checked (unnecessary calls are their own
// certification finding). checkRateFn is injectable so tests can exercise
// all three branches without live credentials — neither of the two known
// sandbox test hotels (3424, 1070) has ever produced a RECHECK rate, so
// this can't be covered by a live smoke test alone.
//
// Returns null if the recheck says the rate is no longer available —
// same "genuine no availability" contract as the rest of this adapter.
export async function resolveBookableHotelbedsRate(
  best: HotelbedsRate,
  checkRateFn: (rateKey: string) => Promise<HotelbedsRate | null> = checkRate,
): Promise<HotelbedsRate | null> {
  if (best.rateType !== 'RECHECK') return best

  const rechecked = await checkRateFn(best.rateKey)
  if (!rechecked) console.log(`[hotelbeds] rateKey=${best.rateKey} failed CheckRate — treating as unavailable`)
  return rechecked
}

export const hotelbedsAdapter: RateSource = {
  id: 'hotelbeds',
  async fetchRate(ctx: TripContext): Promise<NormalizedRate | null> {
    const checkIn  = ctx.checkIn
    const checkOut = ctx.checkOut
    if (!checkIn || !checkOut) throw new Error('hotelbedsAdapter: TripContext.checkIn/checkOut are required to search Hotelbeds')

    const adults    = ctx.numAdults   ?? 1
    const children  = ctx.numChildren ?? 0
    const rooms     = ctx.numRooms    ?? 1
    const childAges = ctx.childAges?.filter((a): a is number => a != null)

    const { hotelCode, propertyName } = await resolveHotelbedsHotelCode(ctx)

    const avail = await searchAvailability({ hotelCode, checkIn, checkOut, adults, children, childAges, rooms })
    if (!avail.found) return null

    const cheapest = pickCheapestHotelbedsRate(avail.rates)
    if (!cheapest) return null

    // The rateKey/price below is only valid for a short Hotelbeds session
    // TTL — a future booking flow must always re-run Availability then
    // CheckRate immediately before POST /bookings, never trust a rateKey
    // carried over from an earlier rate-shopping call like this one.
    const best = await resolveBookableHotelbedsRate(cheapest)
    if (!best) return null

    return {
      source:              'hotelbeds',
      base_rate:           best.net,
      currency:            best.currency ?? avail.currency ?? 'EUR',
      property_name:       avail.hotelName ?? propertyName,
      room_type:           best.roomName ?? null,
      board_basis:         mapHotelbedsBoardBasis(best.boardCode),
      cancellation_policy: formatHotelbedsCancellation(best.cancellationPolicies, best.currency ?? avail.currency),
      raw:                 { rate: best, hotelCode, categoryCode: avail.categoryCode, categoryName: avail.categoryName },
    }
  },
}

// ----------------------------------------------------------------
// Wholesaler adapter — one stub factory covers every wholesale_source
// value from wholesaler_destinations/high_value_routing (migration 016),
// since no wholesaler has a real integration yet. sourceId is the
// api_source column value, e.g. 'pure_escapes_api'.
// ----------------------------------------------------------------

export function createWholesalerAdapter(sourceId: string): RateSource {
  return {
    id: sourceId,
    async fetchRate(_ctx: TripContext): Promise<NormalizedRate | null> {
      return null
    },
  }
}
