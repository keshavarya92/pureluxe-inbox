// Tool definitions + executors for the client-facing Curator agent
// (lib/client/agent.ts). Mirrors lib/trip-builder/tools.ts's shape (one
// buildXTools(tripId) factory closing over the trip so the model can't
// touch another trip's data) but with a much smaller tool set — no
// client-search/creation (there's exactly one demo persona, see
// lib/client/queries.ts), no rate-draft paste/approval flow (lookup_property_rates
// generates and confirms rates directly, there's no advisor to review a
// draft), and one new tool with no Trip Builder analog: lookup_property_rates,
// the client demo's mock rate lookup (build brief §3).

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../supabase'
import {
  getTripState, addLeg, updateLeg, saveItineraryDay, selectLineItem,
  type TripItineraryDay,
} from '../trip-builder/queries'
import { getKBSuggestion, type SuggestionCategory } from '../trip-builder/kb-tool'
import { resolveRateRouting } from '../trip-builder/rate-routing'
import { resolveRateSelection } from '../trip-builder/rate-selection'
import { mockRegistry, nightsBetween, type MockRateRaw } from './mock-rates'
import { computeDestinationFees } from './destination-fees'
import { findOrCreateProperty } from './queries'
import { hashSeed } from './seed'

async function getLegOrThrow(tripId: string, legId: string) {
  const { data, error } = await supabase.from('trip_legs').select('*').eq('id', legId).eq('trip_id', tripId).maybeSingle()
  if (error) throw new Error(`leg lookup: ${error.message}`)
  if (!data) throw new Error(`leg ${legId} does not belong to this trip`)
  return data
}

export interface ClientToolSet {
  tools:   Anthropic.Tool[]
  execute: (name: string, input: any) => Promise<{ output: unknown }>
}

export function buildClientTools(tripId: string): ClientToolSet {
  // Same provenance-tracking pattern as Trip Builder's buildTripBuilderTools
  // — consumed (reset to null) by the save_itinerary_day call that
  // immediately follows a request_suggestion, so only that save inherits
  // 'kb'/'llm_general'; otherwise defaults to 'advisor_manual' (no advisor
  // exists in this product, but the column's existing CHECK constraint has
  // no client-authored value — 'advisor_manual' is the least-wrong existing
  // option for "no grounding tool call preceded this," not a claim of
  // advisor origin).
  let lastSuggestionSource: 'kb' | 'llm_general' | null = null

  const tools: Anthropic.Tool[] = [
    {
      name: 'get_trip_state',
      description: 'Returns everything currently on this trip: legs, itinerary days, and rate options generated so far. Call this to check current state before acting — never guess what\'s already on the trip.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'add_leg',
      description: 'Adds a new destination stop to the trip, appended after any existing legs. Required before looking up rates for a destination not yet on the trip — lookup_property_rates needs a leg_id with dates on it. Safe to call again for a destination already on the trip (e.g. you forgot the leg_id from earlier in the conversation) — it reuses the existing leg rather than creating a duplicate, updating its dates if you passed different ones.',
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
      description: 'Corrects an existing leg\'s destination and/or dates — use this when the client\'s dates change, never add_leg (which always creates a new, separate stop).',
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
      description: 'Looks up dining/activity/notes suggestions for a destination (and optionally a specific property) — internal knowledge base first, general knowledge as fallback. Call this before writing any recommendation from scratch.',
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
      description: 'Saves (or updates) day-by-day itinerary content for a leg — this is what fills the client\'s Itinerary tab. If this call directly follows request_suggestion, its source is inherited automatically.',
      input_schema: {
        type: 'object',
        properties: {
          leg_id:  { type: 'string' },
          day_num: { type: 'number' },
          date:    { type: 'string', description: 'YYYY-MM-DD, optional' },
          title:   { type: 'string' },
          items: {
            type: 'array',
            description: 'Every item here is read by the client directly — write it for them, in a warm, concrete, second/third-person voice, never advisor-facing meta-commentary.',
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
      name: 'lookup_property_rates',
      description: 'Looks up availability and pricing for a specific property on one of this trip\'s legs, generating 1-3 bookable room/package options (name, total, full breakdown). The leg must already exist with check-in/check-out dates — call add_leg first if it doesn\'t. Numbers here are the only source of truth for pricing — never state a rate in chat that didn\'t come from this tool. Calling this again for the same property/leg refreshes its options (new numbers replace old for that property).',
      input_schema: {
        type: 'object',
        properties: {
          leg_id:        { type: 'string' },
          property_name: { type: 'string' },
          num_options:   { type: 'number', description: 'How many room/package options to generate for this property, 1-3. Defaults to 2.' },
          num_adults:    { type: 'number', description: 'Defaults to 2 if not otherwise known from the conversation.' },
          num_children:  { type: 'number' },
        },
        required: ['leg_id', 'property_name'],
      },
    },
    {
      name: 'mark_leaning',
      description: 'Marks one rate option as "leaning towards this" — a soft signal, not a booking. Use this when the conversation clearly shows more interest in one option over its alternatives (the client asking follow-up questions about it, reacting positively, comparing others against it). Don\'t apply it from a single neutral mention, and don\'t re-apply it every turn once set — only when interest has genuinely shifted. The client can also set this directly by tapping a card, which is just as valid as your own inference.',
      input_schema: {
        type: 'object',
        properties: { line_item_id: { type: 'string' } },
        required: ['line_item_id'],
      },
    },
  ]

  const execute = async (name: string, input: any): Promise<{ output: unknown }> => {
    switch (name) {
      case 'get_trip_state':
        return { output: await getTripState(tripId) }

      case 'add_leg': {
        // Reuse an existing same-destination leg rather than creating a
        // duplicate — the model isn't reliable about calling get_trip_state
        // first, and a second "Maldives" leg silently splits itinerary/rate
        // content across two leg_ids instead of merging into one. Case-
        // insensitive exact match only (not ilike-substring), so "Maldives"
        // and "maldives" collapse but "Malé" and "North Malé" don't.
        const { data: existingLegs, error: findErr } = await supabase
          .from('trip_legs').select('*').eq('trip_id', tripId)
        if (findErr) throw new Error(`add_leg existing-leg lookup: ${findErr.message}`)
        const existing = (existingLegs ?? []).find(l => l.destination.toLowerCase() === String(input.destination).toLowerCase())

        if (existing) {
          const hasNewDates = (input.check_in && input.check_in !== existing.check_in) || (input.check_out && input.check_out !== existing.check_out)
          const leg = hasNewDates
            ? await updateLeg(tripId, existing.id, { check_in: input.check_in ?? undefined, check_out: input.check_out ?? undefined })
            : existing
          return { output: { ...leg, reused_existing_leg: true } }
        }

        return { output: await addLeg(tripId, input.destination, input.check_in ?? null, input.check_out ?? null) }
      }

      case 'edit_leg':
        await getLegOrThrow(tripId, input.leg_id)
        return {
          output: await updateLeg(tripId, input.leg_id, {
            destination: input.destination, check_in: input.check_in, check_out: input.check_out,
          }),
        }

      case 'request_suggestion': {
        const result = await getKBSuggestion({
          destination: input.destination,
          property_name: input.property_name ?? null,
          category: input.category as SuggestionCategory | undefined,
        })
        lastSuggestionSource = result.source
        return { output: result }
      }

      case 'save_itinerary_day': {
        await getLegOrThrow(tripId, input.leg_id)
        const source = lastSuggestionSource ?? 'advisor_manual'
        lastSuggestionSource = null
        const day: TripItineraryDay = await saveItineraryDay(
          tripId, input.leg_id, input.day_num, input.date ?? null, input.title ?? null, input.items, source,
        )
        return { output: day }
      }

      case 'lookup_property_rates': {
        const leg = await getLegOrThrow(tripId, input.leg_id)
        if (!leg.check_in || !leg.check_out) {
          return { output: { error: `Leg "${leg.destination}" has no check-in/check-out dates yet — use edit_leg to set them before looking up rates.` } }
        }

        const propertyId = await findOrCreateProperty(input.property_name, leg.destination)
        const routing = await resolveRateRouting({ destinations: [leg.destination], propertyIds: [propertyId] })
        const numOptions = Math.min(Math.max(Math.round(input.num_options ?? 2), 1), 3)
        const nights = nightsBetween(leg.check_in, leg.check_out)
        const tripContext = {
          destinations: [leg.destination], propertyIds: [propertyId],
          checkIn: leg.check_in, checkOut: leg.check_out,
          numAdults: input.num_adults ?? 2, numChildren: input.num_children ?? 0,
        }

        // Clear this property's previous options on this leg before
        // regenerating — a re-call (e.g. dates changed) should replace,
        // not pile up duplicates alongside the old numbers.
        await supabase.from('trip_line_items')
          .delete()
          .eq('trip_id', tripId).eq('leg_id', input.leg_id)
          .eq('property_name', input.property_name).eq('category', 'accommodation')

        const options: unknown[] = []
        let advisoryFlag = false
        for (let i = 0; i < numOptions; i++) {
          const selection = await resolveRateSelection(routing, tripContext, mockRegistry(i))
          if (selection.status !== 'rate_found') continue
          advisoryFlag = advisoryFlag || selection.rate.advisory_flag

          const roomRateTotal = selection.rate.base_rate * nights
          const feeLines = computeDestinationFees(leg.destination, hashSeed(`${propertyId}|${leg.check_in}|${leg.check_out}|${i}`), nights)
          const breakdown = [{ label: 'Room rate', amount: roomRateTotal }, ...feeLines]
          const mockRaw = selection.rate.raw as MockRateRaw

          const { data: inserted, error: insertErr } = await supabase
            .from('trip_line_items')
            .insert({
              trip_id: tripId, leg_id: input.leg_id, category: 'accommodation',
              title: selection.rate.room_type ?? 'Room', subtitle: `${nights} night${nights > 1 ? 's' : ''}`,
              details: selection.rate.board_basis ?? null,
              unit: 'night', quantity: nights, rate_per_unit: selection.rate.base_rate,
              unit_count: 1, currency: selection.rate.currency,
              inclusions: selection.rate.board_basis ? [selection.rate.board_basis] : [],
              cancellation_policy: selection.rate.cancellation_policy ?? null,
              breakdown, property_name: input.property_name,
              room_size: mockRaw.roomSize, room_features: mockRaw.roomFeatures,
              payment_policy: mockRaw.paymentPolicy,
              loyalty_hotel_eligible: mockRaw.loyaltyHotelEligible,
              loyalty_pureluxe_eligible: mockRaw.loyaltyPureluxeEligible,
              status: 'confirmed', selected: false, source: 'api',
            })
            .select()
            .single()
          if (insertErr) throw new Error(`lookup_property_rates insert: ${insertErr.message}`)
          options.push({
            line_item_id: inserted.id, room_type: inserted.title,
            room_size: mockRaw.roomSize, room_features: mockRaw.roomFeatures,
            check_in: leg.check_in, check_out: leg.check_out,
            inclusions: inserted.inclusions, cancellation_policy: inserted.cancellation_policy,
            payment_policy: mockRaw.paymentPolicy,
            loyalty_hotel_eligible: mockRaw.loyaltyHotelEligible,
            loyalty_pureluxe_eligible: mockRaw.loyaltyPureluxeEligible,
            total: breakdown.reduce((s, l) => s + l.amount, 0), breakdown,
          })
        }

        if (!options.length) {
          return { output: { error: `No availability generated for "${input.property_name}" — try again or a different property.` } }
        }
        return { output: { property_name: input.property_name, routing_path: routing.path, advisory_flag: advisoryFlag, options } }
      }

      case 'mark_leaning':
        return { output: await selectLineItem(tripId, input.line_item_id) }

      default:
        return { output: { error: `Unknown tool "${name}"` } }
    }
  }

  return { tools, execute }
}
