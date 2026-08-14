import { supabase } from '../supabase'
import { normalizeUnit, type ExtractedLineItem, type FlightSegment } from './rate-extraction'

export interface Trip {
  id:                string
  primary_client_id: string | null
  status:            'building' | 'quoted' | 'confirmed' | 'itinerary_sent'
  title:             string | null
  created_by:        string
  created_at:        string
  updated_at:        string
}

export interface TripLeg {
  id:               string
  trip_id:          string
  sequence_order:   number
  destination:      string
  check_in:         string | null
  check_out:        string | null
  itinerary_status: 'not_started' | 'drafted' | 'confirmed'
  created_at:       string
}

export interface TripItineraryDay {
  id:         string
  trip_id:    string
  leg_id:     string
  day_num:    number
  date:       string | null
  title:      string | null
  items:      Array<{ type: 'confirmed' | 'hotel' | 'dining' | 'alt' | 'casual' | 'note'; text: string }>
  source:     'kb' | 'llm_general' | 'advisor_manual'
  verified:   boolean
  updated_at: string
}

export interface TripLineItemDraft {
  id:             string
  trip_id:        string
  leg_id:         string | null
  raw_input:      string
  extracted_json: ExtractedLineItem[] | null
  status:         'pending_review' | 'approved' | 'rejected'
  created_at:     string
}

export interface TripLineItem {
  id:                  string
  trip_id:             string
  leg_id:              string | null
  category:            string
  title:               string
  subtitle:            string | null
  details:             string | null
  unit:                string | null
  quantity:            number | null
  rate_per_unit:       number | null
  tax_percentage:      number | null
  unit_count:          number
  currency:            string | null
  inclusions:          string[]
  cancellation_policy: string | null
  segments:            FlightSegment[] | null
  status:              'pending' | 'confirmed'
  selected:            boolean
  source:              'manual' | 'offline_kb' | 'api'
  // Generic additions (migration 019) — a structured per-stay fee
  // breakdown and the property this item belongs to, for grouping several
  // bookable options under one property. Populated by the client demo's
  // mock rate generation (lib/client/tools.ts); nullable and unused by
  // the existing paste-extraction/approval path.
  breakdown:           Array<{ label: string; amount: number }> | null
  property_name:       string | null
  // Generic additions (migration 020) — same nullable/demo-populated
  // convention as breakdown/property_name above.
  room_size:                string | null
  room_features:            string[] | null
  payment_policy:           string | null
  loyalty_hotel_eligible:   boolean | null
  loyalty_pureluxe_eligible: boolean | null
  created_at:          string
  updated_at:          string
}

export async function createRateDraft(
  tripId:        string,
  legId:         string | null,
  rawInput:      string,
  extractedJson: ExtractedLineItem[],
): Promise<TripLineItemDraft> {
  const { data, error } = await supabase
    .from('trip_line_item_drafts')
    .insert({
      trip_id:        tripId,
      leg_id:         legId,
      raw_input:      rawInput,
      extracted_json: extractedJson,
      status:         'pending_review',
    })
    .select()
    .single()
  if (error) throw new Error(`createRateDraft: ${error.message}`)
  return data
}

export async function listRateDrafts(tripId: string): Promise<TripLineItemDraft[]> {
  const { data, error } = await supabase
    .from('trip_line_item_drafts')
    .select('*')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`listRateDrafts: ${error.message}`)
  return data ?? []
}

// Mirrors the trip_line_items CHECK constraints (category/unit enums).
// trip_line_item_drafts.extracted_json is unstructured jsonb, so nothing
// stops a bad value from reaching here — either from a chat-driven edit,
// or from an older draft extracted before rate-extraction.ts started
// normalizing units itself. Without this, a bad value only surfaces at
// approval time as a raw Postgres constraint-violation message shown
// straight to the advisor in chat ("...violates check constraint
// trip_line_items_unit_check").
//
// unit is self-healed via the same synonym map extraction uses — a
// pre-existing draft with unit "stay" approves cleanly as "night" rather
// than permanently blocking the advisor from ever approving it. category
// has no safe universal fallback (guessing wrong misfiles the item under
// the wrong document section), so it stays a hard, actionable error.
const VALID_CATEGORIES = ['accommodation', 'activity', 'transfer', 'flight']

function normalizeLineItems(items: ExtractedLineItem[]): ExtractedLineItem[] {
  return items.map(item => {
    if (!VALID_CATEGORIES.includes(item.category)) {
      throw new Error(`"${item.title}" has an invalid category "${item.category}" — must be one of ${VALID_CATEGORIES.join(', ')}.`)
    }
    return { ...item, unit: normalizeUnit(item.unit) }
  })
}

async function getPendingDraft(id: string): Promise<TripLineItemDraft> {
  const { data, error } = await supabase.from('trip_line_item_drafts').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`getPendingDraft: ${error.message}`)
  if (!data) throw new Error(`draft not found: ${id}`)
  if (data.status !== 'pending_review') throw new Error(`draft ${id} is already ${data.status}`)
  return data
}

// Edit — advisor corrects the extracted fields before approving. Draft stays
// pending_review; nothing is written to trip_line_items until approval.
export async function editRateDraft(id: string, extractedJson: ExtractedLineItem[]): Promise<TripLineItemDraft> {
  await getPendingDraft(id)
  const normalized = normalizeLineItems(extractedJson)
  const { data, error } = await supabase
    .from('trip_line_item_drafts')
    .update({ extracted_json: normalized })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(`editRateDraft: ${error.message}`)
  return data
}

export async function rejectRateDraft(id: string): Promise<void> {
  await getPendingDraft(id)
  const { error } = await supabase.from('trip_line_item_drafts').update({ status: 'rejected' }).eq('id', id)
  if (error) throw new Error(`rejectRateDraft: ${error.message}`)
}

// Approve — promotes the (optionally advisor-edited) extracted items into
// real trip_line_items rows. Approving a draft is the advisor vouching for
// the rate, so the promoted row lands as status 'confirmed' — 'pending'
// describes only the draft's own pending_review state, never a line item
// that's already been through approval.
// source is 'manual' because the rate content itself came from the advisor's
// paste/upload, not from the offline rate KB or a live rate API.
export async function approveRateDraft(id: string, items?: ExtractedLineItem[]): Promise<TripLineItem[]> {
  const draft = await getPendingDraft(id)
  const finalItems = items ?? draft.extracted_json ?? []
  if (!finalItems.length) throw new Error(`approveRateDraft: no line items to approve for draft ${id}`)
  const normalizedItems = normalizeLineItems(finalItems)

  const rows = normalizedItems.map(item => ({
    trip_id:             draft.trip_id,
    // Each item carries its own leg assignment from extraction (or a chat
    // edit) — draft.leg_id is only a fallback for older drafts / a
    // single-leg paste where the whole draft was scoped to one leg upfront.
    leg_id:              item.leg_id ?? draft.leg_id,
    category:            item.category,
    title:               item.title,
    subtitle:            item.subtitle            ?? null,
    details:             item.details             ?? null,
    unit:                item.unit                ?? null,
    quantity:            item.quantity            ?? null,
    rate_per_unit:       item.rate_per_unit       ?? null,
    tax_percentage:      item.tax_percentage      ?? null,
    unit_count:          item.unit_count          ?? 1,
    currency:            item.currency            ?? null,
    inclusions:          item.inclusions          ?? [],
    cancellation_policy: item.cancellation_policy ?? null,
    segments:            item.segments            ?? null,
    status:              'confirmed',
    source:              'manual',
  }))

  const { data: inserted, error: insertErr } = await supabase.from('trip_line_items').insert(rows).select()
  if (insertErr) throw new Error(`approveRateDraft insert: ${insertErr.message}`)

  const { error: updateErr } = await supabase
    .from('trip_line_item_drafts')
    .update({ status: 'approved' })
    .eq('id', id)
  if (updateErr) throw new Error(`approveRateDraft draft status update: ${updateErr.message}`)

  return inserted ?? []
}

// ----------------------------------------------------------------
// Trip lifecycle — client lookup, trip/leg creation, live state for
// the chat backend (build brief step 5).
// ----------------------------------------------------------------

export interface ClientMatch {
  id:        string
  full_name: string
  email:     string | null
}

// Chat only ever links a trip to an EXISTING client record — it never
// creates one. Ambiguous/no-match results are returned for the agent to
// relay back to the advisor rather than guessed at.
export async function findClientByName(name: string): Promise<ClientMatch[]> {
  const { data, error } = await supabase
    .from('clients')
    .select('id, full_name, email')
    .ilike('full_name', `%${name}%`)
    .eq('active', true)
    .limit(5)
  if (error) throw new Error(`findClientByName: ${error.message}`)
  return data ?? []
}

export async function createTrip(
  clientId:  string,
  title:     string | null,
  createdBy: string,
  isDemo:    boolean = false,
): Promise<Trip> {
  const { data, error } = await supabase
    .from('trip_builder_trips')
    .insert({ primary_client_id: clientId, title, created_by: createdBy, status: 'building', is_demo: isDemo })
    .select()
    .single()
  if (error) throw new Error(`createTrip: ${error.message}`)

  const { error: tcErr } = await supabase
    .from('trip_clients')
    .insert({ trip_id: data.id, client_id: clientId, role: 'primary' })
  if (tcErr) throw new Error(`createTrip trip_clients: ${tcErr.message}`)

  return data
}

// Links an additional traveler (family member/companion) to an EXISTING
// trip — the multi-pax counterpart to createTrip's primary-client link.
// Without this, the only tool that could link a client to a trip was
// start_trip, which always creates a brand-new trip — asking for several
// travelers up front had no way to land them on one trip, only one trip
// per name. Re-adding the same client is a harmless no-op (trip_clients'
// own UNIQUE(trip_id, client_id) constraint catches it) rather than an error.
export async function addTraveler(
  tripId:   string,
  clientId: string,
  role:     'primary' | 'companion' = 'companion',
): Promise<void> {
  const { error } = await supabase.from('trip_clients').insert({ trip_id: tripId, client_id: clientId, role })
  if (error && error.code !== '23505') throw new Error(`addTraveler: ${error.message}`)
}

export async function addLeg(
  tripId:      string,
  destination: string,
  checkIn:     string | null,
  checkOut:    string | null,
): Promise<TripLeg> {
  const { data: existing, error: countErr } = await supabase
    .from('trip_legs')
    .select('sequence_order')
    .eq('trip_id', tripId)
    .order('sequence_order', { ascending: false })
    .limit(1)
  if (countErr) throw new Error(`addLeg sequence lookup: ${countErr.message}`)
  const nextSequence = (existing?.[0]?.sequence_order ?? 0) + 1

  const { data, error } = await supabase
    .from('trip_legs')
    .insert({ trip_id: tripId, destination, check_in: checkIn, check_out: checkOut, sequence_order: nextSequence })
    .select()
    .single()
  if (error) throw new Error(`addLeg: ${error.message}`)
  return data
}

// Corrects an existing leg's dates/destination — e.g. the client moved
// their trip. Without this, there was no way to fix a leg once created:
// add_leg only inserts new rows, and saveItineraryDay's date derivation
// (see below) always re-anchors to the leg's check_in, so a stale leg date
// silently overrides any date the advisor tries to save on top of it — a
// real "no leg-edit tool available" dead end hit on a live trip whose
// dates shifted after the itinerary/rates were already built.
export async function updateLeg(
  tripId: string,
  legId:  string,
  updates: { destination?: string; check_in?: string | null; check_out?: string | null },
): Promise<TripLeg> {
  const patch: Record<string, unknown> = {}
  if (updates.destination !== undefined) patch.destination = updates.destination
  if (updates.check_in    !== undefined) patch.check_in    = updates.check_in
  if (updates.check_out   !== undefined) patch.check_out   = updates.check_out
  if (Object.keys(patch).length === 0) throw new Error('updateLeg: no fields to update')

  const { data, error } = await supabase
    .from('trip_legs')
    .update(patch)
    .eq('id', legId)
    .eq('trip_id', tripId)
    .select()
    .single()
  if (error) throw new Error(`updateLeg: ${error.message}`)
  if (!data) throw new Error(`leg ${legId} not found on this trip`)
  return data
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Upsert on (trip_id, leg_id, day_num) — re-saving a day the advisor already
// has (e.g. after editing) updates it in place rather than duplicating it.
//
// The `date` argument is only ever a fallback. A real trip on the "Japan"
// itinerary had every day off by exactly 3 days (Day 1 stored as 12 Oct
// instead of 9 Oct) because the model free-hands this field with nothing
// anchoring it to a real date — an arithmetic mistake with no way to catch
// itself. Whenever the trip has at least one leg with a check_in, the
// canonical date is derived instead: the trip's earliest check_in date plus
// this day_num's 0-based position among every day_num saved anywhere on the
// trip (including this call) — so day_num is treated as one continuous
// sequence of calendar days from the trip's start, never restarting at a
// leg boundary. (An earlier version anchored to each leg's OWN check_in
// instead, which double-counted the transition day: day_num 4 — Kyoto→Tokyo,
// stored under the Kyoto leg — already covers Tokyo's check-in date, so
// restarting Tokyo's count at its own check_in put every Tokyo day back by
// one.) The passed-in `date` only survives when no leg has a check_in yet —
// there's nothing to derive from in that case.
export async function saveItineraryDay(
  tripId: string,
  legId:  string,
  dayNum: number,
  date:   string | null,
  title:  string | null,
  items:  TripItineraryDay['items'],
  source: 'kb' | 'llm_general' | 'advisor_manual',
): Promise<TripItineraryDay> {
  const { data: existing, error: findErr } = await supabase
    .from('trip_itinerary_days')
    .select('id')
    .eq('trip_id', tripId)
    .eq('leg_id', legId)
    .eq('day_num', dayNum)
    .maybeSingle()
  if (findErr) throw new Error(`saveItineraryDay lookup: ${findErr.message}`)

  const [{ data: legs, error: legsErr }, { data: tripDays, error: daysErr }] = await Promise.all([
    supabase.from('trip_legs').select('check_in').eq('trip_id', tripId),
    supabase.from('trip_itinerary_days').select('day_num').eq('trip_id', tripId),
  ])
  if (legsErr) throw new Error(`saveItineraryDay legs lookup: ${legsErr.message}`)
  if (daysErr) throw new Error(`saveItineraryDay trip days lookup: ${daysErr.message}`)

  const checkIns = (legs ?? []).map(l => l.check_in).filter((d): d is string => !!d).sort()
  let canonicalDate = date
  if (checkIns.length) {
    const minDayNum = Math.min(dayNum, ...(tripDays ?? []).map(d => d.day_num))
    canonicalDate = addDaysISO(checkIns[0], dayNum - minDayNum)
  }

  const payload = { date: canonicalDate, title, items, source, updated_at: new Date().toISOString() }

  if (existing) {
    const { data, error } = await supabase
      .from('trip_itinerary_days')
      .update(payload)
      .eq('id', existing.id)
      .select()
      .single()
    if (error) throw new Error(`saveItineraryDay update: ${error.message}`)
    return data
  }

  const { data, error } = await supabase
    .from('trip_itinerary_days')
    .insert({ trip_id: tripId, leg_id: legId, day_num: dayNum, ...payload })
    .select()
    .single()
  if (error) throw new Error(`saveItineraryDay insert: ${error.message}`)
  return data
}

// Marks one line item as the chosen option among its (leg_id, category)
// siblings on this trip, clearing `selected` on the rest. Scoped to tripId
// so a hallucinated cross-trip line_item_id can't mutate another trip.
export async function selectLineItem(tripId: string, lineItemId: string): Promise<TripLineItem> {
  const { data: item, error: findErr } = await supabase
    .from('trip_line_items')
    .select('*')
    .eq('id', lineItemId)
    .eq('trip_id', tripId)
    .maybeSingle()
  if (findErr) throw new Error(`selectLineItem lookup: ${findErr.message}`)
  if (!item) throw new Error(`line item not found on this trip: ${lineItemId}`)

  let siblings = supabase
    .from('trip_line_items')
    .update({ selected: false, updated_at: new Date().toISOString() })
    .eq('trip_id', tripId)
    .eq('category', item.category)
    .neq('id', lineItemId)
  siblings = item.leg_id ? siblings.eq('leg_id', item.leg_id) : siblings.is('leg_id', null)
  const { error: clearErr } = await siblings
  if (clearErr) throw new Error(`selectLineItem clear siblings: ${clearErr.message}`)

  const { data: updated, error: updateErr } = await supabase
    .from('trip_line_items')
    .update({ selected: true, updated_at: new Date().toISOString() })
    .eq('id', lineItemId)
    .select()
    .single()
  if (updateErr) throw new Error(`selectLineItem: ${updateErr.message}`)
  return updated
}

// Removes a confirmed line item outright — for duplicates from a re-paste,
// or a rate that turned out wrong after approval. Distinct from
// rejectRateDraft, which only ever discards a draft before it's promoted;
// once a rate is confirmed there was previously no way to undo it at all.
export async function deleteLineItem(tripId: string, lineItemId: string): Promise<void> {
  const { data, error: findErr } = await supabase
    .from('trip_line_items')
    .select('id')
    .eq('id', lineItemId)
    .eq('trip_id', tripId)
    .maybeSingle()
  if (findErr) throw new Error(`deleteLineItem lookup: ${findErr.message}`)
  if (!data) throw new Error(`line item not found on this trip: ${lineItemId}`)

  const { error } = await supabase.from('trip_line_items').delete().eq('id', lineItemId)
  if (error) throw new Error(`deleteLineItem: ${error.message}`)
}

export interface TripTraveler {
  client_id: string
  full_name: string
  role:      'primary' | 'companion'
}

export interface TripState {
  trip:            Trip
  travelers:       TripTraveler[]
  legs:            TripLeg[]
  itinerary_days:  TripItineraryDay[]
  line_items:      TripLineItem[]
  pending_drafts:  TripLineItemDraft[]
}

// Single read for the chat agent to orient itself each turn — legs,
// itinerary content, rate line items, and anything still awaiting
// approval. The future sidebar (build brief step 7) will likely read the
// same shape.
export async function getTripState(tripId: string): Promise<TripState> {
  const [{ data: trip, error: tripErr }, { data: travelers, error: travelerErr },
         { data: legs, error: legErr },
         { data: days, error: dayErr }, { data: items, error: itemErr },
         { data: drafts, error: draftErr }] = await Promise.all([
    supabase.from('trip_builder_trips').select('*').eq('id', tripId).single(),
    supabase.from('trip_clients').select('client_id, role, client:clients(full_name)').eq('trip_id', tripId),
    supabase.from('trip_legs').select('*').eq('trip_id', tripId).order('sequence_order'),
    supabase.from('trip_itinerary_days').select('*').eq('trip_id', tripId).order('day_num'),
    supabase.from('trip_line_items').select('*').eq('trip_id', tripId),
    supabase.from('trip_line_item_drafts').select('*').eq('trip_id', tripId).eq('status', 'pending_review'),
  ])
  if (tripErr) throw new Error(`getTripState trip: ${tripErr.message}`)
  if (travelerErr) throw new Error(`getTripState travelers: ${travelerErr.message}`)
  if (legErr) throw new Error(`getTripState legs: ${legErr.message}`)
  if (dayErr) throw new Error(`getTripState days: ${dayErr.message}`)
  if (itemErr) throw new Error(`getTripState line items: ${itemErr.message}`)
  if (draftErr) throw new Error(`getTripState drafts: ${draftErr.message}`)

  return {
    trip,
    travelers: (travelers ?? []).map((t: any) => ({
      client_id: t.client_id,
      full_name: t.client?.full_name ?? 'Unknown',
      role: t.role,
    })),
    legs: legs ?? [],
    itinerary_days: days ?? [],
    line_items: items ?? [],
    pending_drafts: drafts ?? [],
  }
}

// ----------------------------------------------------------------
// Sidebar (build brief step 7) — everything above, plus documents,
// the client's display name, and two values computed on read rather
// than stored: the running total and each document's staleness.
// ----------------------------------------------------------------

export interface TripDocument {
  id:                string
  trip_id:           string
  type:              'itinerary' | 'rate_sheet'
  file_path:         string
  generated_at:      string
  source_updated_at: string
}

export interface TripDocumentWithStaleness extends TripDocument {
  stale: boolean
}

export interface TripSidebarData extends TripState {
  client_name:             string | null
  documents:               TripDocumentWithStaleness[]
  // Per-currency totals — line items span currencies with no FX
  // conversion in scope, so this is a breakdown, not a single number.
  running_total_by_currency: Record<string, number>
}

// A document is stale if it was generated before the last time any
// itinerary day or line item on the trip changed. Computed here, on
// read, per the build brief — never stored as a flag that needs
// triggers to stay correct.
export function computeContentLastUpdatedAt(days: TripItineraryDay[], items: TripLineItem[]): string | null {
  const timestamps = [...days.map(d => d.updated_at), ...items.map(i => i.updated_at)]
  if (!timestamps.length) return null
  return timestamps.reduce((max, t) => (t > max ? t : max))
}

// Sums confirmed line items into a per-currency total. Within a group
// of line items sharing (leg_id, category) — e.g. three room-type
// options for the same leg — only the one marked `selected` counts
// once there's more than one option; a lone confirmed item in a group
// counts on its own, since there was never a choice to make. Matches
// the "only totals confirmed/selected items" rule from the document
// generation section of the build brief.
function computeRunningTotals(lineItems: TripLineItem[]): Record<string, number> {
  const groups = new Map<string, TripLineItem[]>()
  for (const item of lineItems) {
    const key = `${item.leg_id ?? 'trip'}::${item.category}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  const totals: Record<string, number> = {}
  for (const group of groups.values()) {
    const confirmed = group.filter(i => i.status === 'confirmed')
    if (!confirmed.length) continue
    const counted = confirmed.length === 1 ? confirmed : confirmed.filter(i => i.selected)
    for (const item of counted) {
      if (item.rate_per_unit == null || !item.currency) continue
      const qty = item.quantity ?? 1
      const base = item.rate_per_unit * qty * (item.unit_count || 1)
      const withTax = item.tax_percentage ? base * (1 + item.tax_percentage / 100) : base
      totals[item.currency] = (totals[item.currency] ?? 0) + withTax
    }
  }
  return totals
}

export async function getTripSidebarData(tripId: string): Promise<TripSidebarData> {
  const state = await getTripState(tripId)

  const [{ data: client }, { data: documents, error: docErr }] = await Promise.all([
    state.trip.primary_client_id
      ? supabase.from('clients').select('full_name').eq('id', state.trip.primary_client_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('trip_documents').select('*').eq('trip_id', tripId).order('generated_at', { ascending: false }),
  ])
  if (docErr) throw new Error(`getTripSidebarData documents: ${docErr.message}`)

  const contentLastUpdatedAt = computeContentLastUpdatedAt(state.itinerary_days, state.line_items)

  return {
    ...state,
    client_name: client?.full_name ?? null,
    documents: (documents ?? []).map(doc => ({
      ...doc,
      stale: contentLastUpdatedAt != null && doc.source_updated_at < contentLastUpdatedAt,
    })),
    running_total_by_currency: computeRunningTotals(state.line_items),
  }
}

// ----------------------------------------------------------------
// Trip lookup — lets the UI browse/reopen existing trips instead of
// losing track of which one you were on (e.g. after navigating away
// and back, which doesn't carry the ?trip= URL param with it).
// ----------------------------------------------------------------

export interface TripSummary {
  id:           string
  title:        string | null
  status:       Trip['status']
  client_name:  string | null
  destinations: string[]
  updated_at:   string
}

export async function listTrips(): Promise<TripSummary[]> {
  const { data: trips, error } = await supabase
    .from('trip_builder_trips')
    .select('id, title, status, primary_client_id, updated_at')
    .order('updated_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`listTrips: ${error.message}`)
  if (!trips?.length) return []

  const clientIds = [...new Set(trips.map(t => t.primary_client_id).filter((id): id is string => !!id))]
  const tripIds = trips.map(t => t.id)

  const [{ data: clients, error: clientErr }, { data: legs, error: legErr }] = await Promise.all([
    clientIds.length
      ? supabase.from('clients').select('id, full_name').in('id', clientIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('trip_legs').select('trip_id, destination').in('trip_id', tripIds).order('sequence_order'),
  ])
  if (clientErr) throw new Error(`listTrips clients: ${clientErr.message}`)
  if (legErr) throw new Error(`listTrips legs: ${legErr.message}`)

  const clientNameById = new Map((clients ?? []).map(c => [c.id, c.full_name]))
  const destinationsByTrip = new Map<string, string[]>()
  for (const leg of legs ?? []) {
    if (!destinationsByTrip.has(leg.trip_id)) destinationsByTrip.set(leg.trip_id, [])
    destinationsByTrip.get(leg.trip_id)!.push(leg.destination)
  }

  return trips.map(t => ({
    id:           t.id,
    title:        t.title,
    status:       t.status,
    client_name:  t.primary_client_id ? clientNameById.get(t.primary_client_id) ?? null : null,
    destinations: destinationsByTrip.get(t.id) ?? [],
    updated_at:   t.updated_at,
  }))
}
