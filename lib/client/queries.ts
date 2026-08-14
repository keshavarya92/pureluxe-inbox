// Client-portal query helpers — trip list/creation scoped to the single
// shared demo persona (build brief §6), plus the rate-grouping shape the
// client sidebar needs (grouped by property — trip_line_items itself has
// no such grouping) that Studio's trip-builder queries don't provide.
// Trip lifecycle/state itself reuses lib/trip-builder/queries.ts directly
// rather than duplicating it — see createTrip()/getTripState() calls below.

import { supabase } from '../supabase'
import { createTrip, getTripState, type TripState } from '../trip-builder/queries'

// Fixed demo client/family seeded by migration 019. Every client-portal
// session maps to this one record until real per-user auth (Session 6)
// binds a Google login to it instead.
export const DEMO_CLIENT_ID = '00000000-0000-4000-8000-000000000001'

export interface ClientTripSummary {
  id:         string
  title:      string | null
  updated_at: string
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// A trip has no title until the Curator names it explicitly — there's no
// such tool, deliberately: auto-titling (build brief §2, "'Maldives,
// October' once destination + rough dates are known") is derived here, on
// read, from the trip's own legs, the same "computed on read rather than
// stored" convention lib/trip-builder/queries.ts already uses for document
// staleness/running totals. Returns null (frontend shows "New trip") until
// at least one leg has a destination.
function deriveTitle(legs: Array<{ destination: string; check_in: string | null }>): string | null {
  const first = legs[0]
  if (!first?.destination) return null
  if (!first.check_in) return first.destination
  const month = MONTH_NAMES[new Date(`${first.check_in}T00:00:00Z`).getUTCMonth()]
  return `${first.destination}, ${month}`
}

// Most-recent-first, matching claude.ai's chat history pattern (build
// brief §2).
export async function listClientTrips(clientId: string = DEMO_CLIENT_ID): Promise<ClientTripSummary[]> {
  const { data: trips, error } = await supabase
    .from('trip_builder_trips')
    .select('id, title, updated_at')
    .eq('primary_client_id', clientId)
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error) throw new Error(`listClientTrips: ${error.message}`)
  if (!trips?.length) return []

  const { data: legs, error: legErr } = await supabase
    .from('trip_legs')
    .select('trip_id, destination, check_in')
    .in('trip_id', trips.map(t => t.id))
    .order('sequence_order')
  if (legErr) throw new Error(`listClientTrips legs: ${legErr.message}`)

  const legsByTrip = new Map<string, Array<{ destination: string; check_in: string | null }>>()
  for (const leg of legs ?? []) {
    if (!legsByTrip.has(leg.trip_id)) legsByTrip.set(leg.trip_id, [])
    legsByTrip.get(leg.trip_id)!.push(leg)
  }

  return trips.map(t => ({ ...t, title: t.title ?? deriveTitle(legsByTrip.get(t.id) ?? []) }))
}

export async function createClientTrip(clientId: string = DEMO_CLIENT_ID): Promise<{ id: string }> {
  const trip = await createTrip(clientId, null, 'client-demo', true)
  return { id: trip.id }
}

export interface RateOptionView {
  id:                        string
  name:                      string
  subtitle:                  string | null
  currency:                  string | null
  total:                     number
  breakdown:                 Array<{ label: string; amount: number }>
  selected:                  boolean
  checkIn:                   string | null
  checkOut:                  string | null
  roomSize:                  string | null
  roomFeatures:              string[]
  inclusions:                string[]
  cancellationPolicy:        string | null
  paymentPolicy:             string | null
  loyaltyHotelEligible:      boolean | null
  loyaltyPureluxeEligible:   boolean | null
}

export interface PropertyGroupView {
  property_name: string
  leg_id:        string | null
  options:       RateOptionView[]
}

export interface ClientTripView {
  trip:           { id: string; title: string | null; status: string }
  legs:           TripState['legs']
  itinerary_days: TripState['itinerary_days']
  rate_groups:    PropertyGroupView[]
}

function groupRatesByProperty(items: TripState['line_items'], legs: TripState['legs']): PropertyGroupView[] {
  const legById = new Map(legs.map(l => [l.id, l]))
  const groups = new Map<string, PropertyGroupView>()
  for (const item of items) {
    if (item.category !== 'accommodation') continue
    const propertyName = item.property_name ?? item.title
    const key = `${item.leg_id ?? 'trip'}::${propertyName}`
    if (!groups.has(key)) groups.set(key, { property_name: propertyName, leg_id: item.leg_id, options: [] })

    const breakdown = item.breakdown ?? []
    const total = breakdown.length
      ? breakdown.reduce((sum, l) => sum + l.amount, 0)
      : (item.rate_per_unit ?? 0) * (item.quantity ?? 1)
    const leg = item.leg_id ? legById.get(item.leg_id) : undefined

    groups.get(key)!.options.push({
      id: item.id, name: item.title, subtitle: item.subtitle,
      currency: item.currency, total, breakdown, selected: item.selected,
      checkIn: leg?.check_in ?? null, checkOut: leg?.check_out ?? null,
      roomSize: item.room_size, roomFeatures: item.room_features ?? [],
      inclusions: item.inclusions ?? [], cancellationPolicy: item.cancellation_policy,
      paymentPolicy: item.payment_policy,
      loyaltyHotelEligible: item.loyalty_hotel_eligible, loyaltyPureluxeEligible: item.loyalty_pureluxe_eligible,
    })
  }
  return [...groups.values()]
}

export async function getClientTripView(tripId: string): Promise<ClientTripView> {
  const state = await getTripState(tripId)
  return {
    trip: { id: state.trip.id, title: state.trip.title, status: state.trip.status },
    legs: state.legs,
    itinerary_days: state.itinerary_days,
    rate_groups: groupRatesByProperty(state.line_items, state.legs),
  }
}

// Find-or-create a properties row by name — mirrors lib/extract.ts's
// getOrCreatePropertyId (same ilike-then-insert convention). Needed here
// because mock rate generation (lib/client/mock-rates.ts) keys off a real
// properties.id the same way every real adapter does, and the client demo
// has no fixed property list (build brief §3) — any property name the
// client mentions gets a row created on the fly.
export async function findOrCreateProperty(name: string, destination: string): Promise<string> {
  const { data: existing, error: findErr } = await supabase
    .from('properties').select('id').ilike('name', name).maybeSingle()
  if (findErr) throw new Error(`findOrCreateProperty lookup: ${findErr.message}`)
  if (existing) return existing.id

  const { data: created, error: insertErr } = await supabase
    .from('properties').insert({ name, city: destination, country: null }).select('id').single()
  if (insertErr) throw new Error(`findOrCreateProperty insert: ${insertErr.message}`)
  return created.id
}
