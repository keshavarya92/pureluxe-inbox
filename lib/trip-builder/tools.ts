// Tool definitions + executors for the Trip Builder chat agent
// (lib/trip-builder/agent.ts). Every tool here is bound to a single
// tripId via buildTripBuilderTools(tripId) — the model never supplies
// trip_id itself, so it can't (accidentally or via a hallucinated ID)
// mutate a different trip. start_trip is the one exception: it runs
// before any tripId exists, see agent.ts for how that phase works.

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../supabase'
import { resolveClient, isValidClientName } from '../resolvers'
import {
  findClientByName, createTrip, addTraveler, addLeg, updateLeg, saveItineraryDay, selectLineItem, deleteLineItem, getTripState,
  createRateDraft, editRateDraft, approveRateDraft, rejectRateDraft,
  type ClientMatch, type Trip, type TripItineraryDay,
} from './queries'
import { extractRateLineItems, applyLegFallback } from './rate-extraction'
import { getKBSuggestion, type SuggestionCategory } from './kb-tool'
import { generateDocument } from './document-generator'

// ----------------------------------------------------------------
// Pre-trip tools — only available before a trip exists
// ----------------------------------------------------------------

export const START_TRIP_TOOL: Anthropic.Tool = {
  name: 'start_trip',
  description: 'Creates ONE new trip for an existing client. If the advisor names several travelers for the same trip (a family, a group), this is still ONE call — put the main/first-named client in client_name and everyone else in companion_names. Calling this more than once for what should be a single group trip creates duplicate trips, one per person, instead of one trip with multiple travelers. Search first if a name could be ambiguous. If no client matches at all, don\'t give up — tell the advisor and ask whether to create a new client record (confirming the exact name), then use create_client and call start_trip again.',
  input_schema: {
    type: 'object',
    properties: {
      client_name:     { type: 'string', description: 'Name of the primary/first-named existing client this trip is for' },
      companion_names: { type: 'array', items: { type: 'string' }, description: 'Optional — names of any other travelers on this same trip (family members, companions), so they all land on one trip rather than one trip each' },
      title:           { type: 'string', description: 'Optional short trip title/label' },
    },
    required: ['client_name'],
  },
}

export const CREATE_CLIENT_TOOL: Anthropic.Tool = {
  name: 'create_client',
  description: 'Creates a new client record. Only call this after start_trip has reported no match AND the advisor has explicitly confirmed they want a new record created for this exact name — never create one preemptively or because a search came up empty without asking first.',
  input_schema: {
    type: 'object',
    properties: {
      full_name: { type: 'string', description: 'The client\'s full name, confirmed with the advisor' },
      email:     { type: 'string' },
      phone:     { type: 'string' },
    },
    required: ['full_name'],
  },
}

export async function executeStartTrip(
  input:     { client_name: string; companion_names?: string[]; title?: string },
  createdBy: string,
): Promise<{ output: unknown; trip?: Trip }> {
  const matches = await findClientByName(input.client_name)
  if (matches.length === 0) {
    return { output: { error: `No client found matching "${input.client_name}". Ask the advisor if they'd like a new client record created for this name, then use create_client.` } }
  }
  if (matches.length > 1) {
    return { output: { disambiguation: true, matches } }
  }
  const trip = await createTrip(matches[0].id, input.title ?? null, createdBy)

  const companions: Array<{ name: string; status: 'added' | 'not_found' | 'ambiguous'; matches?: ClientMatch[] }> = []
  for (const name of input.companion_names ?? []) {
    const companionMatches = await findClientByName(name)
    if (companionMatches.length === 1) {
      await addTraveler(trip.id, companionMatches[0].id, 'companion')
      companions.push({ name, status: 'added' })
    } else if (companionMatches.length > 1) {
      companions.push({ name, status: 'ambiguous', matches: companionMatches })
    } else {
      companions.push({ name, status: 'not_found' })
    }
  }

  return { output: { trip, client: matches[0], companions }, trip }
}

export async function executeCreateClient(
  input: { full_name: string; email?: string; phone?: string },
): Promise<{ output: unknown }> {
  if (!isValidClientName(input.full_name)) {
    return { output: { error: `"${input.full_name}" doesn't look like a single valid client name — check the spelling, or that it's one person, not a family/group label.` } }
  }
  const clientId = await resolveClient({
    full_name: input.full_name,
    email:     input.email ?? null,
    phone:     input.phone ?? null,
  })
  return { output: { client_id: clientId, full_name: input.full_name } }
}

// ----------------------------------------------------------------
// Cross-trip safety guards — reject IDs that don't belong to this trip
// rather than silently trusting whatever the model passed in.
// ----------------------------------------------------------------

async function assertLegInTrip(legId: string, tripId: string): Promise<void> {
  const { data, error } = await supabase.from('trip_legs').select('id').eq('id', legId).eq('trip_id', tripId).maybeSingle()
  if (error) throw new Error(`leg lookup: ${error.message}`)
  if (!data) throw new Error(`leg ${legId} does not belong to this trip`)
}

async function assertDraftInTrip(draftId: string, tripId: string): Promise<void> {
  const { data, error } = await supabase.from('trip_line_item_drafts').select('trip_id').eq('id', draftId).maybeSingle()
  if (error) throw new Error(`draft lookup: ${error.message}`)
  if (!data || data.trip_id !== tripId) throw new Error(`draft ${draftId} does not belong to this trip`)
}

// Shared line-item shape for edit_rate_draft/approve_rate_draft — mirrors
// the trip_line_items CHECK constraints (category/unit enums) so the model
// is steered away from an invalid value up front, rather than only finding
// out when queries.ts's validateLineItems rejects it (or, before that
// existed, when the DB constraint itself rejected it with a raw SQL error
// shown straight to the advisor in chat).
const LINE_ITEM_SCHEMA = {
  type: 'object' as const,
  properties: {
    category:            { type: 'string', enum: ['accommodation', 'activity', 'transfer', 'flight'] },
    leg_id:               { type: 'string', description: 'Which leg this item is for — one of this trip\'s leg ids from get_trip_state. Omit only for a genuine trip-spanning item (an actual flight, or a transfer that isn\'t tied to one stop) — never as a default when a destination is actually named.' },
    title:                { type: 'string' },
    subtitle:             { type: 'string' },
    details:              { type: 'string' },
    unit:                 { type: 'string', enum: ['night', 'person', 'flat'], description: 'Omit entirely if there is no meaningful per-unit rate' },
    quantity:             { type: 'number' },
    rate_per_unit:        { type: 'number', description: 'Always the per-unit rate exactly as quoted by the supplier — never adjusted for tax or room count. Use tax_percentage and unit_count for those.' },
    tax_percentage:       { type: 'number', description: 'A stated exclusive tax/service % (e.g. 17.7 for "plus 17.7% tax"). Omit if the rate is already tax-inclusive/net.' },
    unit_count:           { type: 'number', description: 'How many rooms/units are needed, if the rate is per room and more than one is required (e.g. 4). Defaults to 1 — omit unless the source says more than one is needed.' },
    currency:             { type: 'string', description: '3-letter currency code' },
    inclusions:           { type: 'array', items: { type: 'string' } },
    cancellation_policy:  { type: 'string' },
    segments: {
      type: 'array',
      description: 'Category "flight" only, when the fare names more than one flight number (a connection, multi-city, outbound+return quoted as one price) — one entry per flight number, in order flown. Omit for a single-segment/undifferentiated fare or any non-flight category.',
      items: {
        type: 'object',
        properties: {
          flight_number: { type: 'string' },
          route:         { type: 'string', description: 'e.g. "BLR → NRT"' },
          date:          { type: 'string' },
          departure:     { type: 'string' },
          arrival:       { type: 'string' },
          duration:      { type: 'string' },
          stops:         { type: 'string' },
          aircraft:      { type: 'string' },
          notes:         { type: 'string', description: 'e.g. a layover note for this leg' },
        },
        required: ['route'],
      },
    },
  },
  required: ['category', 'title'],
}

// ----------------------------------------------------------------
// Per-trip tools
// ----------------------------------------------------------------

export interface TripBuilderToolSet {
  tools:   Anthropic.Tool[]
  execute: (name: string, input: any) => Promise<{ output: unknown }>
}

export function buildTripBuilderTools(tripId: string): TripBuilderToolSet {
  // Tracks the source of the most recently returned suggestion so
  // save_itinerary_day can stamp provenance from actual tool-call history
  // — never from the model's own claim about where content came from.
  // Consumed (reset to null) the moment it's used: only the save that
  // immediately follows a suggestion inherits 'kb'/'llm_general'.
  //
  // When nothing precedes the save, the default is 'advisor_manual' — no
  // grounding tool call means there's no AI-provenance evidence to stamp,
  // so it's treated as advisor-originated (typed directly, or relayed
  // verbatim) rather than dropped into either AI bucket by default.
  let lastSuggestionSource: 'kb' | 'llm_general' | null = null

  const tools: Anthropic.Tool[] = [
    {
      name: 'get_trip_state',
      description: 'Returns everything currently on this trip: travelers, legs, itinerary days, rate line items, and drafts awaiting approval. Call this to check current state before acting or answering — never guess at what\'s already on the trip, including who\'s already listed as a traveler before adding another.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'add_traveler',
      description: 'Links another traveler (family member/companion) to this trip. Use this for anyone besides the primary client named after the trip already exists — never call start_trip again just to add someone to the same trip, that creates a separate duplicate trip instead.',
      input_schema: {
        type: 'object',
        properties: { client_name: { type: 'string' } },
        required: ['client_name'],
      },
    },
    CREATE_CLIENT_TOOL,
    {
      name: 'add_leg',
      description: 'Adds a new destination stop to the trip, appended after the existing legs in sequence.',
      input_schema: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          check_in:    { type: 'string', description: 'YYYY-MM-DD, optional' },
          check_out:   { type: 'string', description: 'YYYY-MM-DD, optional' },
        },
        required: ['destination'],
      },
    },
    {
      name: 'edit_leg',
      description: 'Corrects an EXISTING leg\'s destination and/or dates — use this when the client\'s dates change, never add_leg (which always creates a new, separate stop). Itinerary day dates are derived from each leg\'s check_in, so a stale leg date silently overrides any day date saved after it — if the advisor says dates have moved, fix the leg here FIRST, then re-save the affected itinerary days so they re-anchor to the corrected dates.',
      input_schema: {
        type: 'object',
        properties: {
          leg_id:      { type: 'string' },
          destination: { type: 'string', description: 'Optional — omit to leave unchanged' },
          check_in:    { type: 'string', description: 'YYYY-MM-DD, optional — omit to leave unchanged' },
          check_out:   { type: 'string', description: 'YYYY-MM-DD, optional — omit to leave unchanged' },
        },
        required: ['leg_id'],
      },
    },
    {
      name: 'request_suggestion',
      description: 'Looks up dining/activity/notes suggestions for a destination (and optionally a specific property) — internal knowledge base first, general knowledge as fallback. Use this before writing itinerary content from scratch; the response states which source was used.',
      input_schema: {
        type: 'object',
        properties: {
          destination:   { type: 'string' },
          property_name: { type: 'string' },
          category:      { type: 'string', enum: ['dining', 'activities', 'general'] },
        },
        required: ['destination'],
      },
    },
    {
      name: 'save_itinerary_day',
      description: 'Saves (or updates, if this day already exists) day-by-day itinerary content for a leg. If this call directly follows request_suggestion, its source is inherited automatically (kb or llm_general). Otherwise it\'s tagged advisor_manual by default — so always call request_suggestion first for any recommendation you\'re authoring yourself, rather than writing it from memory unlabeled. Don\'t describe content as grounded or verified yourself either way.',
      input_schema: {
        type: 'object',
        properties: {
          leg_id:  { type: 'string' },
          day_num: { type: 'number' },
          date:    { type: 'string', description: 'YYYY-MM-DD, optional' },
          title:   { type: 'string' },
          items: {
            type: 'array',
            description: 'Every item here is read by the CLIENT, not the advisor — write it for them directly, never advisor-facing meta-commentary ("the client," "if the client wants X," "start this now"). Type controls both visual weight AND whether it renders inline on the day or gets collected elsewhere — pick deliberately, don\'t default everything to "dining"/"confirmed": ' +
              '"confirmed" = an included/booked logistics line, or an ACTUALLY confirmed reservation (dining included) — plain, renders inline. ' +
              '"hotel" = a short, specific highlight of the day\'s accommodation — the ACTUAL property on this trip, name matched exactly to the line item title, never a different (even if better-known) hotel in the same city. Exactly one per leg, on the day that property first appears — every leg needs one, not just some. Renders inline with brass emphasis. ' +
              '"dining" = the day\'s ANCHOR recommendation, the one restaurant you\'d actually book — renders inline, bold, shaded. Use ONLY when the advisor specifically asked for dining that day, or this is genuinely the one place worth booking for that day; usually one, rarely two per day. ' +
              '"alt" = a real secondary dining option — NOT rendered inline; collected into a separate "Dining Recommendations" section grouped by destination, so use it freely without worrying about cluttering the day. ' +
              '"casual" = a quick/backup dining mention — same as "alt", collected into the Dining Recommendations section, not inline. ' +
              '"note" = an important logistical note, not a recommendation — renders inline.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['confirmed', 'hotel', 'dining', 'alt', 'casual', 'note'] },
                text: { type: 'string' },
              },
              required: ['type', 'text'],
            },
          },
        },
        required: ['leg_id', 'day_num', 'items'],
      },
    },
    {
      name: 'submit_rate_paste',
      description: 'Extracts rate line items from pasted rate text and stages them as a draft pending advisor review (approve/edit/reject). For pasted text only — file uploads go through the upload endpoint directly, not this tool. A single paste can mix items for different legs (a flight plus hotels in two different cities) — extraction assigns each item to the right leg automatically by matching destination names, so there\'s no need to split a mixed paste into one call per leg.',
      input_schema: {
        type: 'object',
        properties: {
          leg_id:   { type: 'string', description: 'Optional — only when the advisor has said this whole paste is for one specific leg and extraction might not be able to tell from the text alone. Leave unset for a normal paste; per-item leg assignment happens automatically.' },
          raw_text: { type: 'string' },
        },
        required: ['raw_text'],
      },
    },
    {
      name: 'edit_rate_draft',
      description: 'Overwrites the extracted line items on a pending rate draft before approval. Rewrite the full items array — this replaces it, not merges with it.',
      input_schema: {
        type: 'object',
        properties: {
          draft_id: { type: 'string' },
          extracted_json: {
            type: 'array',
            items: LINE_ITEM_SCHEMA,
          },
        },
        required: ['draft_id', 'extracted_json'],
      },
    },
    {
      name: 'approve_rate_draft',
      description: 'Approves a pending rate draft, promoting its line items onto the trip as confirmed rates. Only call this once the advisor has actually approved — never assume approval from silence.',
      input_schema: {
        type: 'object',
        properties: {
          draft_id: { type: 'string' },
          items:    { type: 'array', items: LINE_ITEM_SCHEMA, description: 'Optional — pass edited items to approve those instead of the draft\'s extracted_json as-is' },
        },
        required: ['draft_id'],
      },
    },
    {
      name: 'reject_rate_draft',
      description: 'Rejects a pending rate draft — discards it without creating any line items.',
      input_schema: {
        type: 'object',
        properties: { draft_id: { type: 'string' } },
        required: ['draft_id'],
      },
    },
    {
      name: 'select_line_item',
      description: 'Marks one line item as the chosen option among multiple options in the same category+leg (e.g. picking one of three room types). Clears selection on the other options in that group.',
      input_schema: {
        type: 'object',
        properties: { line_item_id: { type: 'string' } },
        required: ['line_item_id'],
      },
    },
    {
      name: 'remove_line_item',
      description: 'Permanently deletes a CONFIRMED line item — for a duplicate from a re-paste, or a rate that turned out wrong after approval. This is not the same as reject_rate_draft, which only ever discards a draft before it was promoted; a confirmed line item can only be undone with this. Only call this once the advisor has clearly said which one to remove — never guess between near-identical items on your own.',
      input_schema: {
        type: 'object',
        properties: { line_item_id: { type: 'string' } },
        required: ['line_item_id'],
      },
    },
    {
      name: 'generate_document',
      description: 'Generates and stores the itinerary document or the rate sheet as a .docx, built fresh from whatever is currently on the trip. "itinerary" needs at least one saved itinerary day; "rate_sheet" needs at least one rate line item — rate status is irrelevant for the itinerary and vice versa, per the two independent tracks. Tell the advisor it\'s ready and to check the sidebar\'s Documents tab to download it — don\'t claim to attach or send the file yourself. If the result includes warnings (e.g. a hotel highlight present for one leg but missing on another), relay them to the advisor plainly — don\'t silently ignore them or fix the content yourself without being asked.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['itinerary', 'rate_sheet'] },
        },
        required: ['type'],
      },
    },
  ]

  const execute = async (name: string, input: any): Promise<{ output: unknown }> => {
    switch (name) {
      case 'get_trip_state':
        return { output: await getTripState(tripId) }

      case 'add_traveler': {
        const matches = await findClientByName(input.client_name)
        if (matches.length === 0) {
          return { output: { error: `No client found matching "${input.client_name}". Ask the advisor if they'd like a new client record created for this name, then use create_client and call add_traveler again.` } }
        }
        if (matches.length > 1) {
          return { output: { disambiguation: true, matches } }
        }
        await addTraveler(tripId, matches[0].id, 'companion')
        return { output: { added: matches[0] } }
      }

      case 'create_client':
        return executeCreateClient(input)

      case 'add_leg':
        return { output: await addLeg(tripId, input.destination, input.check_in ?? null, input.check_out ?? null) }

      case 'edit_leg':
        await assertLegInTrip(input.leg_id, tripId)
        return {
          output: await updateLeg(tripId, input.leg_id, {
            destination: input.destination,
            check_in:    input.check_in,
            check_out:   input.check_out,
          }),
        }

      case 'request_suggestion': {
        const result = await getKBSuggestion({
          destination:   input.destination,
          property_name: input.property_name ?? null,
          category:      input.category as SuggestionCategory | undefined,
        })
        lastSuggestionSource = result.source
        return { output: result }
      }

      case 'save_itinerary_day': {
        await assertLegInTrip(input.leg_id, tripId)
        const source = lastSuggestionSource ?? 'advisor_manual'
        lastSuggestionSource = null
        const day: TripItineraryDay = await saveItineraryDay(
          tripId, input.leg_id, input.day_num,
          input.date ?? null, input.title ?? null, input.items, source,
        )
        return { output: day }
      }

      case 'submit_rate_paste': {
        if (input.leg_id) await assertLegInTrip(input.leg_id, tripId)
        const state = await getTripState(tripId)
        const legs = state.legs.map(l => ({ id: l.id, destination: l.destination }))
        const extracted = await extractRateLineItems({ kind: 'text', text: input.raw_text }, legs)
        const finalItems = applyLegFallback(extracted, input.leg_id ?? null)
        const draft = await createRateDraft(tripId, input.leg_id ?? null, input.raw_text, finalItems)
        return { output: draft }
      }

      case 'edit_rate_draft':
        await assertDraftInTrip(input.draft_id, tripId)
        return { output: await editRateDraft(input.draft_id, input.extracted_json) }

      case 'approve_rate_draft':
        await assertDraftInTrip(input.draft_id, tripId)
        return { output: await approveRateDraft(input.draft_id, input.items) }

      case 'reject_rate_draft':
        await assertDraftInTrip(input.draft_id, tripId)
        await rejectRateDraft(input.draft_id)
        return { output: { ok: true } }

      case 'select_line_item':
        return { output: await selectLineItem(tripId, input.line_item_id) }

      case 'remove_line_item':
        await deleteLineItem(tripId, input.line_item_id)
        return { output: { ok: true } }

      case 'generate_document':
        return { output: await generateDocument(tripId, input.type) }

      default:
        return { output: { error: `Unknown tool "${name}"` } }
    }
  }

  return { tools, execute }
}

export type { ClientMatch }
