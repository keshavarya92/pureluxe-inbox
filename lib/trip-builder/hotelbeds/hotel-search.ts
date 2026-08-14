// Hotelbeds Availability + CheckRate. Availability is a single-phase call
// (unlike Sabre's avail -> rates split): one POST returns both the hotel
// and its bookable room rates together, since we're always searching one
// already-known hotel code (hotelbedsAdapter resolves that from
// properties.hotelbeds_hotel_code before calling this). CheckRate is a
// second, dependent call — same multi-call-flow-in-one-file precedent as
// ../sabre/hotel-search.ts (searchHotels + getHotelRates).
//
// Endpoint + request/response shapes confirmed against
// developer.hotelbeds.com/documentation/hotels/booking-api/ (2026-08-11)
// AND against live sandbox probes (2026-08-12, hotel 3424):
//   Availability: POST {HOTELBEDS_BASE_URL}/hotel-api/1.0/hotels
//     body: { stay: {checkIn, checkOut}, occupancies: [{rooms, adults, children, paxes?}], hotels: {hotel: [code]} }
//     response envelope: { hotels: { hotels: [{ code, name, categoryCode, categoryName, currency, rooms: [{ code, name, rates: [...] }] }] } }
//   CheckRate: POST {HOTELBEDS_BASE_URL}/hotel-api/1.0/checkrates
//     body: { rooms: [{ rateKey }] }
//     response envelope: { hotel: { code, name, categoryCode, categoryName, currency, rooms: [{ code, name, rates: [...] }] } }
//     — SINGULAR "hotel", not the plural "hotels.hotels[]" Availability uses.
//     Confirmed live rather than assumed after the Sabre precedent turned
//     out not to predict this correctly.
//
// Children's ages: confirmed live (2026-08-12) that Hotelbeds requires one
// paxes entry per child once occupancies[].children >= 1 (error otherwise:
// "If children >= 1 it is mandatory that you specify a paxes element per
// child"). Shape: occupancies[].paxes: [{roomId, type: 'CH', age}], one per
// child — roomId accepted (matches the Booking API's own paxes shape) even
// for a single-room search.

import { signedRequest } from './auth'
import { withRetry } from './retry'

export interface HotelbedsSearchParams {
  hotelCode:  string
  checkIn:    string // 'YYYY-MM-DD'
  checkOut:   string
  adults?:    number
  children?:  number
  childAges?: number[] // required (one entry per child) once children > 0
  rooms?:     number
}

export interface HotelbedsCancellationPolicy {
  amount: string
  from:   string
}

export interface HotelbedsPromotion {
  code:   string | undefined
  name:   string | undefined
  remark: string | undefined
}

export interface HotelbedsRate {
  rateKey:              string
  roomCode:             string | undefined
  roomName:             string | undefined
  boardCode:            string | undefined
  boardName:            string | undefined
  net:                  number
  currency:             string | undefined
  rateClass:            string | undefined
  // 'BOOKABLE' | 'RECHECK' — certification workflow rule 2.5: only call
  // checkRate() when this is 'RECHECK'; calling it on an already-BOOKABLE
  // rate is itself a certification finding, not just wasted work.
  rateType:             string | undefined
  packaging:            boolean
  cancellationPolicies: HotelbedsCancellationPolicy[]
  taxesAllIncluded:     boolean | null
  // Availability only gives a reference ID; CheckRate gives the full text
  // directly (confirmed live) — both captured since callers may see either
  // depending on which call produced this HotelbedsRate.
  rateCommentsId:       string | undefined
  rateComments:         string | undefined
  promotions:           HotelbedsPromotion[]
}

export interface HotelbedsAvailResult {
  found:        boolean
  hotelName:    string | null
  currency:     string | null
  categoryCode: string | null
  categoryName: string | null
  rates:        HotelbedsRate[]
}

function buildPaxes(childAges: number[] | undefined, children: number): unknown[] | undefined {
  if (!children) return undefined
  if (!childAges || childAges.length !== children) {
    throw new Error(`hotelbeds hotel-search: children=${children} but childAges has ${childAges?.length ?? 0} entries — Hotelbeds requires exactly one age per child`)
  }
  return childAges.map(age => ({ roomId: 1, type: 'CH', age }))
}

export async function searchAvailability({
  hotelCode, checkIn, checkOut, adults = 1, children = 0, childAges, rooms = 1,
}: HotelbedsSearchParams): Promise<HotelbedsAvailResult> {
  // Built outside withRetry's closure deliberately — a childAges mismatch
  // is a client-side validation error, not a transient failure, so it must
  // fail fast rather than get retried 3 times pointlessly.
  const paxes = buildPaxes(childAges, children)

  const res = await withRetry(
    () => signedRequest<any>('/hotel-api/1.0/hotels', {
      method: 'POST',
      body: JSON.stringify({
        stay:        { checkIn, checkOut },
        occupancies: [{ rooms, adults, children, paxes }],
        hotels:      { hotel: [Number(hotelCode)] },
      }),
    }),
    'availability',
  )

  const hotel = res?.hotels?.hotels?.[0]
  if (!hotel) return { found: false, hotelName: null, currency: null, categoryCode: null, categoryName: null, rates: [] }

  const parsed = parseHotelBlock(hotel)
  return { found: parsed.rates.length > 0, ...parsed }
}

// Re-verifies a single rate ahead of booking, required whenever Availability
// returned rateType 'RECHECK' for it. Returns null if Hotelbeds no longer
// considers it bookable (genuine "recheck failed", same "no availability"
// contract as the rest of this adapter — not an error).
export async function checkRate(rateKey: string): Promise<HotelbedsRate | null> {
  const res = await withRetry(
    () => signedRequest<any>('/hotel-api/1.0/checkrates', {
      method: 'POST',
      body: JSON.stringify({ rooms: [{ rateKey }] }),
    }),
    'checkrate',
  )

  const hotel = res?.hotel // singular envelope — see file header note
  const room  = hotel?.rooms?.[0]
  const rate  = room?.rates?.[0]
  if (!hotel || !room || !rate) return null

  return parseRate(rate, room, hotel)
}

// Exported for scripts/test-hotelbeds-parse.ts — pure fixture parsing test,
// no network involved.
export function parseHotelBlock(hotel: any): Omit<HotelbedsAvailResult, 'found'> {
  const rates: HotelbedsRate[] = []
  for (const room of hotel.rooms ?? []) {
    for (const rate of room.rates ?? []) {
      rates.push(parseRate(rate, room, hotel))
    }
  }

  return {
    hotelName:    hotel.name ?? null,
    currency:     hotel.currency ?? null,
    categoryCode: hotel.categoryCode ?? null,
    categoryName: hotel.categoryName ?? null,
    rates,
  }
}

function parseRate(rate: any, room: any, hotel: any): HotelbedsRate {
  return {
    rateKey:              rate.rateKey,
    roomCode:             room.code,
    roomName:             room.name,
    boardCode:            rate.boardCode,
    boardName:            rate.boardName,
    net:                  Number(rate.net),
    currency:             hotel.currency,
    rateClass:            rate.rateClass,
    rateType:             rate.rateType,
    packaging:            !!rate.packaging,
    cancellationPolicies: rate.cancellationPolicies ?? [],
    taxesAllIncluded:     rate.taxes?.allIncluded ?? null,
    rateCommentsId:       rate.rateCommentsId,
    rateComments:         rate.rateComments,
    promotions:           (rate.promotions ?? []).map((p: any) => ({ code: p.code, name: p.name, remark: p.remark })),
  }
}
