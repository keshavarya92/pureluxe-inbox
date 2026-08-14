// Resolves a free-text destination — this repo's convention throughout
// Trip Builder (trip_legs.destination, destination_facts.destination,
// property_facts.destination) — to an IATA city code via Sabre's Geo
// Autocomplete, so gdsAdapter can search hotelavail even when the
// advisor typed a city name instead of a code.
//
// Ported from pureluxe-rates's src/utils/geoLookup.js, hotel-only: the
// original kept separate hotel/flight caches because a flight search
// needs the airport-level `id`, not the city-level `iataCityCode`.
// Flights are out of scope for gdsAdapter (see rate-sources.ts), so
// there is only one cache and one code path here.
//
// Response shape (Lodging v2025.09 Postman collection):
//   grouped["category:AIR"].doclist.docs[].iataCityCode — city-level code (LON, DXB)
//   grouped["category:AIR"].doclist.docs[].ranking       — integer, higher = better
//   grouped["category:CITY"].doclist.docs[]              — OSM city records, no IATA code

import { authorizedRequest } from './auth'
import { withRetry } from './retry'
import { getPCC } from './access-codes'

const IATA_RE = /^[A-Z]{2,4}$/

export interface GeoResult {
  code:           string | null
  cityRecognised: boolean
  cityName:       string | null
}

interface GeoDoc {
  iataCityCode?: string
  name?:         string
  ranking?:      number
}

interface GeoAutocompleteResponse {
  grouped?: {
    'category:AIR'?:  { doclist?: { docs?: GeoDoc[] } }
    'category:CITY'?: { doclist?: { docs?: GeoDoc[] } }
  }
}

// Keys are lowercase destination strings.
const cache = new Map<string, GeoResult>()

// code: null when no IATA code can be resolved — caller must handle
// gracefully (ask the consultant to confirm) rather than passing a bad
// value to Sabre. cityRecognised: true when Sabre matched at least a
// CITY record, even with no IATA code, so callers can distinguish
// "city found, code unknown" from "nothing recognised at all".
export async function geoLookup(destination: string): Promise<GeoResult> {
  const q = destination.trim()
  if (!q) return { code: null, cityRecognised: false, cityName: null }
  if (IATA_RE.test(q)) return { code: q, cityRecognised: true, cityName: null }

  const cached = cache.get(q.toLowerCase())
  if (cached) return cached

  const endpoint = process.env.SABRE_ENDPOINT
  if (!endpoint) throw new Error('Sabre is not configured — set SABRE_ENDPOINT in .env.local')

  const params = new URLSearchParams({ query: q, clientId: getPCC(), limit: '5' })
  const data = await withRetry(
    () => authorizedRequest<GeoAutocompleteResponse>(`${endpoint}/v2/geo/autocomplete?${params}`),
    'geoLookup.autocomplete'
  )

  const result = extractResult(data, q)
  // Not cached when neither an IATA code nor a recognised city came
  // back — Sabre may return results on a later attempt or a different
  // query, so a dead lookup shouldn't be pinned forever.
  if (result.code || result.cityRecognised) cache.set(q.toLowerCase(), result)
  return result
}

function extractResult(data: GeoAutocompleteResponse, originalQuery: string): GeoResult {
  const airDocs = data.grouped?.['category:AIR']?.doclist?.docs ?? []
  if (airDocs.length > 0) {
    const best = topByRanking(airDocs)
    if (best.iataCityCode) return { code: best.iataCityCode, cityRecognised: true, cityName: best.name ?? null }
  }

  const cityDocs = data.grouped?.['category:CITY']?.doclist?.docs ?? []
  if (cityDocs.length > 0) {
    const best = topByRanking(cityDocs)
    return { code: null, cityRecognised: true, cityName: best.name ?? originalQuery }
  }

  return { code: null, cityRecognised: false, cityName: null }
}

function topByRanking(docs: GeoDoc[]): GeoDoc {
  return [...docs].sort((a, b) => (b.ranking ?? 0) - (a.ranking ?? 0))[0]
}
