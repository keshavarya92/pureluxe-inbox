// Rate draft extraction — turns an advisor's pasted text or uploaded
// image/PDF rate document into structured trip_line_item candidates.
// Plain text uses Haiku (cheap, no vision needed); images/PDFs need
// Sonnet's vision/document support, mirroring lib/attachments.ts.

import Anthropic from '@anthropic-ai/sdk'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type RateCategory = 'accommodation' | 'activity' | 'transfer' | 'flight'
export type RateUnit = 'night' | 'person' | 'flat'

// One flight number's worth of a fare — a multi-segment itinerary (e.g.
// BLR→NRT→ITM→BLR on three different flight numbers) is one line item
// overall (one price), but each flight number gets its own row here so the
// document can render a proper table instead of a squashed sentence in
// `details`. Only meaningful for category 'flight'; null/omitted for every
// other category and for a flight quoted as one undifferentiated fare with
// nothing to break out.
export interface FlightSegment {
  flight_number: string | null
  route:         string // e.g. "BLR → NRT"
  date:          string | null
  departure:     string | null
  arrival:       string | null
  duration:      string | null
  stops:         string | null
  aircraft:      string | null
  // Per-segment extras that don't fit the columns — a layover note
  // ("Layover 03:50 hrs at NRT"), a same-flight-number note, etc.
  notes:         string | null
}

export interface ExtractedLineItem {
  category:            RateCategory
  title:               string
  subtitle:            string | null
  details:             string | null
  unit:                RateUnit | null
  quantity:            number | null
  rate_per_unit:       number | null
  currency:            string | null
  inclusions:          string[]
  cancellation_policy: string | null
  // A stated exclusive tax/service % — never folded into rate_per_unit,
  // which always stays exactly as quoted. Null when the source's rate is
  // already tax-inclusive/net (nothing to add).
  tax_percentage:      number | null
  // Multiplier independent of quantity (nights/persons) — e.g. 4 rooms x 3
  // nights each is quantity 3, unit_count 4, not "12 nights". Defaults to 1.
  unit_count:          number
  // Which of the trip's existing legs this item belongs to, matched by
  // destination name against the `legs` list passed to extractRateLineItems
  // — null for a genuinely trip-spanning item (a real flight, or a transfer
  // that isn't tied to one stop). A paste can legitimately mix items across
  // several legs (a flight plus hotels in two different cities); this is
  // what lets each item land under its own leg's section instead of every
  // item in a mixed paste being dumped into one leg-less bucket together.
  leg_id:              string | null
  segments:            FlightSegment[] | null
  // The literal full-stay/full-fare total figure printed in the source for
  // THIS item, if any (a "Total Price" header, a "Total stay price" line,
  // a cancellation-charge amount described as the full stay) — transcribed
  // exactly as printed, never computed or reasoned about. When present,
  // this deterministically overrides rate_per_unit in code (see
  // extractRateLineItems below) rather than leaving the reconciliation to
  // the model's own judgment call, which has been unreliable: on a real
  // rate sheet the model correctly transcribed a nightly-rate breakdown
  // AND a document-stated inclusive total that were ~30% apart, explicitly
  // noted the discrepancy in its own output, and then still used the
  // lower, wrong number anyway. Transcription is a low-risk task the model
  // is good at; reconciling two conflicting totals under its own judgment
  // is not — so code does that part instead, every time, the same way.
  stated_total_price: number | null
}

export type RateInput =
  | { kind: 'text';  text: string }
  | { kind: 'image'; base64: string; mimeType: 'image/jpeg' | 'image/png' }
  | { kind: 'pdf';   base64: string }

// Extraction is a free-text prompt, not a schema-enforced tool call — Claude
// can and does emit a synonym ("stay", "per night", "pp") instead of the
// exact enum value the JSON_SCHEMA text asks for. Rather than let that reach
// a draft unnormalized (where it either silently breaks the rate math or,
// worse, only fails later at approval with a raw DB constraint error), map
// known synonyms here and fall back to null — which trip_line_items and the
// document generator both already treat as "no explicit per-unit rate",
// same as if the field had never been extracted at all.
const UNIT_SYNONYMS: Record<string, RateUnit> = {
  night: 'night', nights: 'night', nightly: 'night', 'per night': 'night', 'a night': 'night',
  person: 'person', persons: 'person', people: 'person', pax: 'person', pp: 'person',
  'per person': 'person', traveler: 'person', travelers: 'person', guest: 'person', guests: 'person',
  // "stay" specifically means "one lump sum covering the whole stay" — the
  // OPPOSITE of a per-night rate, not a synonym for it. A prior version of
  // this map treated it as "night" while leaving the total-for-N-nights
  // number untouched, which silently understated the true per-night cost by
  // a factor of N (2340 total for 2 nights displayed as "2340 / night").
  // "flat" is the correct fit: a single rate not divided by any quantity.
  flat: 'flat', total: 'flat', 'flat rate': 'flat', fixed: 'flat', package: 'flat', stay: 'flat', 'total for stay': 'flat',
}

export function normalizeUnit(raw: unknown): RateUnit | null {
  if (typeof raw !== 'string') return null
  return UNIT_SYNONYMS[raw.trim().toLowerCase()] ?? null
}

// An explicit advisor-given leg_id backfills any item extraction couldn't
// tie to a destination itself — a fallback for those, not an override for
// items extraction already matched to a different leg on its own.
export function applyLegFallback(items: ExtractedLineItem[], legId: string | null): ExtractedLineItem[] {
  if (!legId) return items
  return items.map(item => ({ ...item, leg_id: item.leg_id ?? legId }))
}

const SYSTEM = `You are a rate-sheet extraction system for PureLuxe, a luxury travel agency based in Mumbai (KFT Corporation).
Extract every distinct rate line item — accommodation room type, activity, transfer, or flight fare — from supplier-provided rate information (rate sheets, quotes, fare confirmations). A single document often lists multiple room categories or fare options; extract each as a separate item.

A single room/offer often shows a DIFFERENT rate for each night of a multi-night stay (e.g. "1,330.00 CHF per night starting 22 August for 1 night(s)" followed by a different rate for the next night) — this is still ONE line item, not one per night. Set quantity to the total number of nights. Never emit two line items with the same title/room for two nights of the same stay — average them into one.

Separately from the per-night rate breakdown, many documents ALSO print a distinct total figure for that same item — a "Total Price" header, a "Total stay price" line, or an amount named inside a cancellation/guarantee-charge sentence ("to avoid a charge of X," "penalty: X (forfeit entire stay)"). Whenever the source gives one, transcribe it exactly as printed into "stated_total_price" — do NOT try to decide yourself whether it's the "right" number, whether it agrees with the nightly-rate breakdown, or whether a nearby "Taxes: Included/Not Included" label makes it redundant. That label is not reliable — the same document format has shown it both correctly and incorrectly stated relative to what the total actually contains. Reconciling stated_total_price against the nightly-rate breakdown is handled deterministically outside this extraction step; your only job is faithful transcription of both numbers. Leave stated_total_price null only when the source truly gives no such total anywhere for that item — in that case, and only then, set rate_per_unit to the blended average yourself (sum the nightly rates ÷ nights).

A mandatory per-stay fee tied to a specific room (resort fee, conservation fee, service charge quoted separately from the room rate, etc.) is NOT its own line item — fold its per-night amount into that room's rate_per_unit (add it to the base nightly rate) and mention the fee by name in details, e.g. "Includes THB 100/night mandatory coral reef conservation fee." Extracting it separately makes it look like an alternative to the room itself rather than a cost that applies on top of it — whichever room is chosen, the mandatory fee is not optional, so it must never compete as a second "option" in the same category.

rate_per_unit is always the per-unit rate exactly as quoted — never adjust it for tax, and never adjust it for room count (when stated_total_price is populated for this item, rate_per_unit gets superseded by total ÷ quantity automatically afterward — just record the nightly rate here as usual, there's nothing to reconcile on your end). Those are captured separately:
- tax_percentage: if the rate excludes a stated tax/service percentage ("plus 17.7% tax", "excl. taxes and fees"), put that number here (17.7). Leave it null if the source says the rate is already inclusive/net of tax — there is nothing left to add.
- unit_count: if the rate is per room (or per car, per unit) and the document states how many are needed or requested ("4 rooms requested", "4 rooms"), put that count here. Defaults to 1. This must never be folded into quantity — quantity is always the actual stay length (nights) or headcount (persons), regardless of how many rooms/units are needed.

A single paste often mixes items for different stops on the trip (e.g. a flight plus hotel options in two different cities) — when a list of the trip's legs is given below, tag each item with the "leg_id" of whichever leg its content is actually for (match by destination name against the hotel/activity/transfer location), not the leg the paste happened to start with. Leave leg_id null only for an item that isn't tied to one specific stop — a genuine flight, or a transfer spanning legs. Never guess a leg_id when nothing in the item's text names or clearly implies a destination.

For a category "flight" item that names more than one flight number for the same fare (a connection, a multi-city routing, an outbound+return pair quoted as one price), break each flight number out as its own entry in "segments", in the order flown — route as "ORIGIN → DESTINATION" using the airport codes/names given, plus whatever of date/departure/arrival/duration/stops/aircraft the source states (null for anything it doesn't). Put a layover ("Layover 03:50 hrs at NRT") in that segment's own "notes", not as a separate line. Leave "segments" null (not an empty array) for a single undifferentiated fare with no flight numbers to break out — don't invent segments that aren't in the source. Anything left over that isn't per-segment (baggage allowance, date-change fee) stays in "details" as before.

Respond ONLY with valid JSON. No markdown, no explanation, no backticks.`

const JSON_SCHEMA = `[{
  "category": "accommodation | activity | transfer | flight",
  "title": "Short name — room type, activity name, transfer route, or flight route",
  "subtitle": "Secondary detail (room view, vehicle type, cabin class) or null",
  "details": "Any other descriptive detail or null",
  "unit": "night | person | flat or null",
  "quantity": number or null,
  "rate_per_unit": number or null,
  "stated_total_price": "number or null — the literal full-stay/full-fare total printed for this item (a 'Total Price' header, 'Total stay price' line, or full-stay cancellation-charge amount), as a plain number with no currency code/symbol and no thousands separators, or null if the source states no such total for this item (see rules above)",
  "tax_percentage": number or null,
  "unit_count": number (defaults to 1 if not stated),
  "currency": "3-letter currency code or null",
  "inclusions": ["array of strings — meal plan, transfers included, etc"],
  "cancellation_policy": "text or null",
  "leg_id": "one of the given leg ids, or null if this item isn't tied to a single stop",
  "segments": "null, or an array of {flight_number, route, date, departure, arrival, duration, stops, aircraft, notes} objects — one per flight number, only for category flight with multiple flight numbers (see rules above); e.g. [{\"flight_number\": \"JL754\", \"route\": \"BLR → NRT\", \"date\": \"Fri 09 Oct\", \"departure\": \"02:55\", \"arrival\": \"14:35\", \"duration\": \"08:10 hrs\", \"stops\": \"No Stop\", \"aircraft\": \"Boeing 787-9\", \"notes\": null}]"
}]`

export interface RateExtractionLeg {
  id:          string
  destination: string
}

// The schema asks for a plain number, but a model that's just spent the
// whole document reading currency-prefixed amounts ("JPY 1,274,400") can
// still echo that formatting back despite the instruction — strip anything
// that isn't a digit, minus sign, or decimal point rather than trust the
// declared type. Returns null for anything that doesn't parse to a real
// number, so a garbled value falls back to "no total given" instead of
// silently producing NaN math.
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[^0-9.-]/g, '')
  const parsed = parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

// Deterministic reconciliation, run in code rather than left to the model's
// judgment — see stated_total_price's doc comment for why. Whenever the
// source gave an explicit full-stay/full-fare total for an item, that total
// ÷ quantity always wins as rate_per_unit, unconditionally, regardless of
// what the nightly-rate breakdown implied or what any "Taxes: Included/Not
// Included" label nearby claimed (that label has been observed both
// correct and backwards on the same real document format). tax_percentage
// is cleared because the reconciled rate is by definition already the
// final all-in per-unit cost — there is nothing left to add on top of it.
function reconcileStatedTotal(item: ExtractedLineItem): ExtractedLineItem {
  const statedTotal = coerceNumber(item.stated_total_price)
  if (statedTotal == null || item.quantity == null || item.quantity <= 0) {
    return { ...item, stated_total_price: statedTotal }
  }

  const reconciledRate = Math.round((statedTotal / item.quantity) * 100) / 100
  const original = item.rate_per_unit
  // Only note the override in details when it actually changed something —
  // a document whose nightly rates already summed to the stated total (no
  // hidden tax gap) shouldn't get a spurious "reconciled" note.
  const materiallyDifferent = original == null || Math.abs(reconciledRate - original) > Math.max(1, original * 0.005)

  return {
    ...item,
    stated_total_price: statedTotal,
    rate_per_unit:  reconciledRate,
    tax_percentage: null,
    details: materiallyDifferent
      ? [item.details, `Reconciled: rate_per_unit set to the stated total (${item.currency ?? ''} ${statedTotal}) ÷ ${item.quantity}, overriding the nightly-rate-derived figure.`.trim()]
          .filter(Boolean).join(' ')
      : item.details,
  }
}

export async function extractRateLineItems(input: RateInput, legs: RateExtractionLeg[] = []): Promise<ExtractedLineItem[]> {
  const legsBlock = legs.length
    ? `\n\nThis trip's legs (match each item to one of these by destination, or use null):\n${legs.map(l => `- id "${l.id}": ${l.destination}`).join('\n')}`
    : ''
  const instruction = `Extract every rate line item from the following. Return ONLY this exact JSON shape (a JSON array; use null for any field you cannot find):\n${JSON_SCHEMA}${legsBlock}`

  let model: string
  let messages: Anthropic.MessageParam[]

  if (input.kind === 'pdf') {
    model = 'claude-sonnet-4-6'
    messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.base64 } } as any,
        { type: 'text', text: instruction },
      ],
    }]
  } else if (input.kind === 'image') {
    model = 'claude-sonnet-4-6'
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.base64 } },
        { type: 'text', text: instruction },
      ],
    }]
  } else {
    model = 'claude-haiku-4-5-20251001'
    messages = [{ role: 'user', content: `${instruction}\n\nRate information:\n${input.text}` }]
  }

  const response = await anthropic.messages.create({ model, max_tokens: 8192, system: SYSTEM, messages })

  const raw = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())
  if (!Array.isArray(parsed)) throw new Error('extractRateLineItems: model did not return a JSON array')
  const knownLegIds = new Set(legs.map(l => l.id))
  return parsed.map((item: ExtractedLineItem) => reconcileStatedTotal({
    ...item,
    unit: normalizeUnit(item.unit),
    tax_percentage: item.tax_percentage ?? null,
    unit_count: item.unit_count ?? 1,
    // A leg_id that doesn't match anything we actually gave the model is a
    // hallucination, not a real assignment — null (trip-level/unassigned)
    // is the safe default, same reasoning as unit/category elsewhere in
    // this file: an honestly-unassigned item is easier to fix later than
    // one confidently misfiled under the wrong leg.
    leg_id: item.leg_id && knownLegIds.has(item.leg_id) ? item.leg_id : null,
    segments: Array.isArray(item.segments) && item.segments.length ? item.segments : null,
    stated_total_price: item.stated_total_price ?? null,
  }))
}
