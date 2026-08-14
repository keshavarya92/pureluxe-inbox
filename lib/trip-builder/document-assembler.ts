// Builds the docx-builder's input shape from the database — trip_legs,
// trip_itinerary_days, trip_line_items — instead of the hand-written JSON
// the prototype (generate-v2.js) was designed against. This is the part
// the build brief calls out as needing to become "a real service", while
// docx-builder.ts (the document format itself) stays a straight port.

import { supabase } from '../supabase'
import { getTripState, type TripLineItem, type TripLeg, type TripItineraryDay } from './queries'
import type { TripDocumentData, LegRateOptions, LineItemSpec, DayEntry, LegDiningBlock } from './docx-builder'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

function formatShortDate(iso: string | null): string {
  if (!iso) return '?'
  const d = utcDate(iso)
  return `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]}`
}

// "9–13 Apr" (same month) or "30 Mar – 2 Apr" (spanning months).
function formatCompactRange(startISO: string | null, endISO: string | null): string {
  if (!startISO || !endISO) return 'TBD'
  const start = utcDate(startISO)
  const end = utcDate(endISO)
  const sMon = MONTH_ABBR[start.getUTCMonth()]
  const eMon = MONTH_ABBR[end.getUTCMonth()]
  return sMon === eMon
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${eMon}`
    : `${start.getUTCDate()} ${sMon} – ${end.getUTCDate()} ${eMon}`
}

// "9 – 21 April 2026" (same month) or "30 March – 2 April 2026".
function formatDateRange(startISO: string | null, endISO: string | null): string {
  if (!startISO && !endISO) return 'Dates TBD'
  const start = utcDate(startISO ?? endISO!)
  const end = utcDate(endISO ?? startISO!)
  const sMon = MONTH_FULL[start.getUTCMonth()]
  const eMon = MONTH_FULL[end.getUTCMonth()]
  const eYear = end.getUTCFullYear()
  return sMon === eMon && start.getUTCFullYear() === eYear
    ? `${start.getUTCDate()} – ${end.getUTCDate()} ${eMon} ${eYear}`
    : `${start.getUTCDate()} ${sMon} – ${end.getUTCDate()} ${eMon} ${eYear}`
}

function toLineItemSpec(item: TripLineItem, typeTagOverride?: string): LineItemSpec {
  return {
    title:            item.title,
    subtitle:         item.subtitle,
    unit:             (item.unit as LineItemSpec['unit']) ?? 'flat',
    quantity:         item.quantity ?? 1,
    ratePerUnit:      item.rate_per_unit ?? 0,
    currency:         item.currency ?? 'USD',
    details:          item.details,
    inclusions:       item.inclusions,
    cancellation:     item.cancellation_policy,
    pending:          item.status !== 'confirmed',
    selected:         item.selected,
    taxPercentage:    item.tax_percentage,
    unitCount:        item.unit_count,
    typeTagOverride,
    segments: item.segments?.map(s => ({
      flightNumber: s.flight_number,
      route:        s.route,
      date:         s.date,
      departure:    s.departure,
      arrival:      s.arrival,
      duration:     s.duration,
      stops:        s.stops,
      aircraft:     s.aircraft,
      notes:        s.notes,
    })) ?? null,
  }
}

// Display-only pick of "the" accommodation for a leg (glance table / day
// header) — prefers a confirmed item, and the selected one if there's more
// than one confirmed. This is informational, not a financial calculation;
// the investment summary's confirmed+selected gate is enforced separately
// and independently in docx-builder's investmentTable().
//
// Returns null — deliberately, not an arbitrary pick — when there are
// several confirmed options and none is selected. A real trip once showed
// "Capella Kyoto" in every header/glance-table cell (silently the first
// option by insertion order) while the actual written hotel-highlight
// content assumed "The Ritz-Carlton Kyoto" — two different unselected
// guesses, each displayed with full confidence. Nothing has actually been
// decided in that state, and showing one option as if it were is worse
// than showing neither; callers fall back to an honest "TBD" instead.
function chooseAccommodationTitle(items: TripLineItem[]): string | null {
  const acc = items.filter(i => i.category === 'accommodation')
  if (!acc.length) return null
  const confirmed = acc.filter(i => i.status === 'confirmed')
  const pool = confirmed.length ? confirmed : acc
  if (pool.length === 1) return pool[0].title
  return pool.find(i => i.selected)?.title ?? null
}

// "TBC" plus one line per candidate property for the undecided-among-several
// case above, vs. just '' when there's genuinely no accommodation item at
// all yet — the former is an active state worth surfacing in full (which
// hotels are actually in play), the latter isn't. Lines are "\n"-joined;
// callers split on that to render each as its own paragraph/row rather than
// one run-on string, since a plain single-line "Hotel TBD (5 options)" told
// the advisor nothing about which five.
function accommodationDisplay(items: TripLineItem[]): string {
  const chosen = chooseAccommodationTitle(items)
  if (chosen) return chosen
  const options = items.filter(i => i.category === 'accommodation' && i.status === 'confirmed')
  return options.length > 1 ? ['TBC', ...options.map(o => o.title)].join('\n') : ''
}

// Strips a line item title down to just the property name — "Capella
// Kyoto – Junior Suite City View (Offer 1)" -> "Capella Kyoto" — so the
// hotel-highlight sanity check compares against the name a client would
// recognize, not room-type/offer noise that would never appear verbatim
// in prose describing the property.
function corePropertyName(title: string): string {
  return title.split(/\s+[–-]\s+|\s+\(/)[0].trim()
}

export async function assembleDocumentData(
  tripId: string,
  type:   'itinerary' | 'rate_sheet',
): Promise<{ data: TripDocumentData; warnings: string[] }> {
  const state = await getTripState(tripId)
  const { trip, legs, itinerary_days: itineraryDays, line_items: lineItems } = state

  if (type === 'itinerary' && itineraryDays.length === 0) {
    throw new Error('No itinerary content yet — add at least one day before generating the itinerary document.')
  }
  if (type === 'rate_sheet' && lineItems.length === 0) {
    throw new Error('No rate line items yet — add at least one before generating the rate sheet.')
  }

  const [{ data: client }, { count: guestCount }] = await Promise.all([
    trip.primary_client_id
      ? supabase.from('clients').select('full_name').eq('id', trip.primary_client_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('trip_clients').select('*', { count: 'exact', head: true }).eq('trip_id', tripId),
  ])

  const destinations = legs.map((l: TripLeg) => l.destination)
  const title    = trip.title?.trim() || destinations.join(' & ').toUpperCase() || 'PURELUXE TRIP'
  const subtitle = destinations.join(' · ') || client?.full_name || ''

  const checkIns  = legs.map(l => l.check_in).filter((d): d is string => !!d).sort()
  const checkOuts = legs.map(l => l.check_out).filter((d): d is string => !!d).sort()
  const dates = formatDateRange(checkIns[0] ?? null, checkOuts[checkOuts.length - 1] ?? null)
  const guests = guestCount ? `${guestCount} Guest${guestCount === 1 ? '' : 's'}` : 'Guests TBD'

  const itemsByLeg = new Map<string, TripLineItem[]>()
  for (const item of lineItems) {
    if (!item.leg_id) continue
    if (!itemsByLeg.has(item.leg_id)) itemsByLeg.set(item.leg_id, [])
    itemsByLeg.get(item.leg_id)!.push(item)
  }
  const daysByLeg = new Map<string, TripItineraryDay[]>()
  for (const day of itineraryDays) {
    if (!daysByLeg.has(day.leg_id)) daysByLeg.set(day.leg_id, [])
    daysByLeg.get(day.leg_id)!.push(day)
  }
  const legById = new Map(legs.map(l => [l.id, l]))

  const glance: [string, string, string, string][] = type === 'itinerary'
    ? legs.map(leg => [
        formatCompactRange(leg.check_in, leg.check_out),
        leg.destination,
        accommodationDisplay(itemsByLeg.get(leg.id) ?? []),
        (daysByLeg.get(leg.id) ?? []).map(d => d.title).filter(Boolean).join(' · '),
      ] as [string, string, string, string])
    : []

  // Only the property highlight, the day's one anchor dining pick, a
  // confirmed logistics line, or an important note render inline on the
  // day card. Secondary ("alt") and casual/backup dining mentions are
  // deliberately excluded here — they're collected into
  // diningRecommendations below instead, grouped per leg, so a light day
  // with several dining mentions doesn't bury the one thing worth booking
  // under a wall of bullets.
  const days: DayEntry[] = type === 'itinerary'
    ? itineraryDays.map(day => ({
        dayNum:   day.day_num,
        date:     formatShortDate(day.date),
        location: legById.get(day.leg_id)?.destination ?? '',
        hotel:    accommodationDisplay(itemsByLeg.get(day.leg_id) ?? []) || null,
        title:    day.title ?? '',
        items:    day.items
          .filter(it => it.type !== 'alt' && it.type !== 'casual')
          .map(it =>
            it.type === 'confirmed' ? `› ${it.text}` :
            it.type === 'hotel'     ? `HOTEL: ${it.text}` :
            it.type === 'dining'    ? `DINING: ${it.text}` :
            `NOTE: ${it.text}`,
          ),
      }))
    : []

  const diningRecommendations: LegDiningBlock[] = type === 'itinerary'
    ? legs
        .map(leg => {
          const legDays = daysByLeg.get(leg.id) ?? []
          const items = legDays.flatMap(day =>
            day.items
              .filter((it): it is { type: 'alt' | 'casual'; text: string } => it.type === 'alt' || it.type === 'casual')
              .map(it => ({ tier: it.type, text: it.text })),
          )
          return { legName: leg.destination, items }
        })
        .filter(block => block.items.length > 0)
    : []

  // A hotel highlight on some legs but not others reads as an oversight,
  // not a deliberate choice — flag it back to the advisor/model rather
  // than silently shipping an inconsistent document. Only legs with actual
  // itinerary content are compared; a leg nobody has started yet isn't a
  // meaningful data point either way.
  const warnings: string[] = []
  if (type === 'itinerary') {
    const startedLegs = legs.filter(l => (daysByLeg.get(l.id) ?? []).length > 0)
    const legsWithHotelHighlight = startedLegs.filter(l =>
      (daysByLeg.get(l.id) ?? []).some(day => day.items.some(it => it.type === 'hotel')),
    )
    if (legsWithHotelHighlight.length > 0 && legsWithHotelHighlight.length < startedLegs.length) {
      const missing = startedLegs.filter(l => !legsWithHotelHighlight.includes(l)).map(l => l.destination)
      warnings.push(`Hotel highlight is missing for ${missing.join(', ')} — present for other leg(s) but not these. Add one, or remove it from the rest for consistency.`)
    }

    // A "hotel" item that never mentions the actual booked property's name
    // is very likely describing the wrong hotel (a same-city namesake or a
    // hallucinated substitute) rather than a stylistic choice — worth a
    // hard flag, not a silent ship. chooseAccommodationTitle() picks the
    // confirmed/selected line item the rest of the document treats as "the"
    // hotel for that leg, so this checks against the same source of truth.
    for (const leg of startedLegs) {
      const legItems = itemsByLeg.get(leg.id) ?? []
      const accommodationTitle = chooseAccommodationTitle(legItems)
      const hotelTexts = (daysByLeg.get(leg.id) ?? [])
        .flatMap(day => day.items.filter(it => it.type === 'hotel').map(it => it.text))
      if (hotelTexts.length === 0) continue

      if (!accommodationTitle) {
        // Several confirmed options, none selected — chooseAccommodationTitle
        // already refuses to guess (see its comment), but a hotel highlight
        // already committing to a specific property in prose while nothing
        // is actually decided is exactly the state that produced two
        // different unselected guesses shown as fact in one real document —
        // still worth surfacing even though there's no "the booked property"
        // to compare the text against yet.
        const optionCount = legItems.filter(i => i.category === 'accommodation' && i.status === 'confirmed').length
        if (optionCount > 1) {
          warnings.push(`${leg.destination} has a hotel highlight written but ${optionCount} accommodation options are still unselected — confirm which one is actually booked (select_line_item) so the highlight can be checked against it.`)
        }
        continue
      }

      const core = corePropertyName(accommodationTitle).toLowerCase()
      if (!core) continue
      const mentionsBookedProperty = hotelTexts.some(t => t.toLowerCase().includes(core))
      if (!mentionsBookedProperty) {
        warnings.push(`The hotel highlight for ${leg.destination} doesn't appear to mention "${accommodationTitle}" (the actual booked property) — check it isn't describing a different hotel.`)
      }
    }
  }

  // Tag for a category label a supplier text might use when it names a
  // destination outright (accommodation/activity/transfer) — used only for
  // the leg-less bucket below, since a leg's own accommodation/activities/
  // transfers sections already carry their own explicit label.
  const CATEGORY_TAG: Record<string, string> = { accommodation: 'STAY', activity: 'ACTIVITY', transfer: 'TRANSFER', flight: 'FLIGHT' }

  let legsOut: LegRateOptions[] = []
  let flights: LineItemSpec[] = []
  if (type === 'rate_sheet') {
    legsOut = legs
      .map(leg => {
        const items = itemsByLeg.get(leg.id) ?? []
        const categories: LegRateOptions['categories'] = {}
        const accommodation = items.filter(i => i.category === 'accommodation').map(i => toLineItemSpec(i))
        const activities    = items.filter(i => i.category === 'activity').map(i => toLineItemSpec(i))
        const transfers     = items.filter(i => i.category === 'transfer').map(i => toLineItemSpec(i))
        if (accommodation.length) categories.accommodation = accommodation
        if (activities.length)    categories.activities = activities
        if (transfers.length)     categories.transfers = transfers
        return { name: leg.destination, dateRange: formatCompactRange(leg.check_in, leg.check_out), categories }
      })
      .filter(leg => Object.keys(leg.categories).length > 0)

    // Trip-level (leg_id null) items — normally real flights, but extraction
    // can also leave a genuinely leg-spanning transfer here, or (if a match
    // failed) an accommodation/activity item that should have landed under
    // a leg but didn't; tag each by its own category rather than blindly
    // labeling everything FLIGHT, which silently misrepresented non-flight
    // items in the document before per-item leg assignment existed.
    flights = lineItems
      .filter(i => !i.leg_id)
      .map(i => toLineItemSpec(i, i.category !== 'flight' ? CATEGORY_TAG[i.category] : undefined))
  }

  return {
    data: { title, subtitle, dates, guests, glance, days, diningRecommendations, notes: [], legs: legsOut, flights },
    warnings,
  }
}
