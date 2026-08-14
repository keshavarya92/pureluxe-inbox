/**
 * rate-routing.ts — resolveRateRouting(), the single entry point for the
 * 5-path rate routing config lookup. Callers never touch offline_trip_types,
 * high_value_routing, or wholesaler_destinations directly — same pattern as
 * resolveTrip()/resolveBooking() in lib/resolvers.ts.
 *
 * Pure, fast, synchronous-in-spirit config lookup only: no GDS, bedbank, or
 * wholesaler API calls happen here. A separate resolveRateSelection() (not
 * implemented yet) takes this routing decision and actually fetches/compares
 * rates.
 *
 * Requires the migration in supabase/migrations/016_rate_routing.sql to be
 * applied first.
 */

import { supabase } from '../supabase'

export interface RateRoutingInput {
  tripType?:     string | null
  destinations?: Array<string | null | undefined> | null
  propertyIds?:  Array<string | null | undefined> | null
}

export type RateRoutingResult =
  | { path: 1 }
  | { path: 5; wholesale_source: string }
  | { path: '2-4'; wholesaler?: string; wholesale_source?: string }

export async function resolveRateRouting(trip: RateRoutingInput): Promise<RateRoutingResult> {
  const destinations = (trip.destinations ?? []).filter((d): d is string => !!d?.trim())
  const propertyIds  = (trip.propertyIds  ?? []).filter((p): p is string => !!p)

  // 1. Fully offline trip type (safaris, yachts, ...) — full consultant
  //    handoff, no rate search at all.
  if (trip.tripType) {
    const { data: offlineMatch } = await supabase
      .from('offline_trip_types')
      .select('id')
      .ilike('trip_type', trip.tripType)
      .limit(1)
    if (offlineMatch?.length) return { path: 1 }
  }

  // 2. High-value destination or property — check wholesale/offline first,
  //    skip GDS/OTA, fall back to GDS/OTA only if wholesale has no availability.
  const highValueOr: string[] = destinations.map(term => `destination.ilike.%${term}%`)
  if (propertyIds.length) highValueOr.push(`property_id.in.(${propertyIds.join(',')})`)
  if (highValueOr.length) {
    const { data: highValueMatch } = await supabase
      .from('high_value_routing')
      .select('wholesale_source')
      .or(highValueOr.join(','))
      .limit(1)
    if (highValueMatch?.length) {
      return { path: 5, wholesale_source: highValueMatch[0].wholesale_source }
    }
  }

  // 3. Active wholesaler for this destination — ADDITIVE: queried alongside
  //    GDS/bedbank, not instead of them.
  if (destinations.length) {
    const wholesalerOr = destinations.map(term => `destination.ilike.%${term}%`).join(',')
    const { data: wholesalerMatch } = await supabase
      .from('wholesaler_destinations')
      .select('wholesaler_name, api_source')
      .eq('active', true)
      .or(wholesalerOr)
      .limit(1)
    if (wholesalerMatch?.length) {
      return {
        path:             '2-4',
        wholesaler:       wholesalerMatch[0].wholesaler_name,
        wholesale_source: wholesalerMatch[0].api_source,
      }
    }
  }

  // 4. Default — GDS + bedbank/OTA only, no wholesaler.
  return { path: '2-4' }
}
