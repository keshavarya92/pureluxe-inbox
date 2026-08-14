// Trip Builder chat agent loop. Mirrors lib/trainer/agent.ts's shape
// (tool-calling loop, persisted user/assistant turns) with one structural
// difference: Trainer Chat is one ongoing conversation per team member,
// but Trip Builder's chat is scoped per trip — matching the sidebar, which
// is also per-trip (see build brief).
//
// That creates a bootstrapping question: a trip doesn't exist yet when the
// advisor's very first message is "start a new trip for...". Rather than
// adding a nullable trip_id to trip_chat_messages to store pre-trip
// messages that get retroactively claimed, that phase is handled as an
// ephemeral, client-held exchange: the caller passes `tripId: null` plus
// whatever prior turns it's holding locally in `priorMessages`, the only
// tool available is start_trip, and nothing is persisted until it
// succeeds. Once start_trip returns a tripId, the caller switches to
// normal (tripId-bound, server-persisted) mode for every message after —
// including the one that created the trip is not re-sent; the frontend
// just starts passing the new tripId.

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../supabase'
import { buildTripBuilderTools, START_TRIP_TOOL, CREATE_CLIENT_TOOL, executeStartTrip, executeCreateClient } from './tools'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-sonnet-4-6'
const MAX_TOOL_ROUNDS = 8 // guard against a runaway tool-call loop
// edit_rate_draft replaces (not merges) the full items array, so editing 2
// of 8 offers means the model has to regenerate all 8 verbatim plus the
// changed two — combined with an approve + a couple of removes in the same
// turn, 2048 was getting hit mid tool-call, truncating a tool_use block
// (stop_reason 'max_tokens') and leaving it structurally unresolved.
const MAX_TOKENS = 8192

const PRE_TRIP_SYSTEM_PROMPT = `You are the Trip Builder assistant for PureLuxe Studio, a luxury travel agency. No trip exists yet for this conversation — your only job right now is to gather what's needed and call start_trip.
- You need the client this trip is for. If the advisor's message doesn't name one clearly, ask.
- If several travelers are named for the same trip (a family, a group), that is still ONE call to start_trip — one name in client_name, everyone else in companion_names. NEVER call start_trip once per person; that creates a separate duplicate trip for each name instead of one trip with several travelers.
- If start_trip reports no match for the primary client, don't just give up — tell the advisor plainly, ask if they want a new client record created for that exact name (confirm spelling), and if they confirm, call create_client, then call start_trip again with the same name(s). If it reports several matches (for the primary or a companion), relay them and ask which one.
- Never call create_client speculatively — only after start_trip has failed to find someone AND the advisor has confirmed.
- Once start_trip succeeds, confirm briefly — including which companions were linked and which (if any) need clarification. Don't call any other tool — none are available yet.`

const POST_TRIP_SYSTEM_PROMPT = `You are the Trip Builder assistant for PureLuxe Studio, a luxury travel agency, helping an advisor build out an existing trip: itinerary content and rates are independent tracks — a leg can have one, both, or neither, and neither blocks the other.

Tools let you: check current trip state, add/link another traveler to this trip, add or edit legs, look up destination/property suggestions, save itinerary days, extract rate line items from pasted text into a draft, edit/approve/reject that draft, mark which option was chosen among multiple line items in the same category+leg, and generate the itinerary/rate sheet document.

Rules:
- Call get_trip_state before acting if you're not sure what's already on the trip — don't assume, including who's already a traveler.
- To add another traveler (family member/companion) to THIS trip, use add_traveler — never start_trip, which always creates a brand-new separate trip rather than adding someone to the current one.
- If the advisor says the trip's dates have moved, use edit_leg on the affected leg(s) — never add_leg, which only creates a new, separate stop. Itinerary day dates are derived from each leg's own check_in, so a leg's date staying stale silently overrides any day date saved afterward — fix the leg's dates with edit_leg FIRST, then re-save the itinerary days on that leg so they re-anchor to the corrected dates; re-saving them before fixing the leg accomplishes nothing.
- request_suggestion tags its own result as coming from the knowledge base ('kb') or general knowledge ('llm_general'). Never restate that as more or less certain than what the tool actually returned, and never claim something is "grounded" or "verified" on your own authority.
- Before saving any itinerary day content that names a specific property, restaurant, or activity as a recommendation, call request_suggestion first — don't write recommendations from your own memory unlabeled. A save_itinerary_day call with no request_suggestion beforehand is stamped advisor_manual, so skipping it isn't a shortcut — it just mislabels your own recommendation as the advisor's.
- save_itinerary_day items need real depth, not bare labels. When request_suggestion returns descriptive detail, carry that color into the item text — don't compress "a highly-rated izakaya near the ryokan, known for its seasonal kaiseki tasting menu" down to just the restaurant's name. For activities, give enough timing/pacing guidance to be useful (roughly when in the day, how long) plus a short reason it's worth doing, not just a label.
- Every leg needs exactly one "hotel" item, on the day its accommodation first appears — never write one for some legs and skip it for others; the document generator will flag that inconsistency back to you if it happens, so fix it before telling the advisor the document is ready. The hotel item must describe the ACTUAL accommodation on this trip — match the property name exactly to the accommodation line item's title from get_trip_state (or the leg's chosen hotel as the advisor has stated it). Never substitute a different, even if better-known, property in the same city — if you call request_suggestion for property color, pass property_name matching that exact title, and if nothing comes back for that exact property, say something true and general rather than describing a different hotel.
- Everything in save_itinerary_day is read by the CLIENT, not the advisor — never write advisor-facing meta-commentary into it. Don't write "the client" (they're the reader), "if the client wants X," "used on a past trip," or task-like instructions such as "book now" / "start this now" — those are notes to yourself, not something that belongs in their document. Urgency can still come through in client-appropriate language (e.g. "Limited to 10 seats — worth confirming early") but never phrased as an instruction to the advisor.
- Use save_itinerary_day's item types deliberately — they control what's inline on the day vs. collected separately. "dining" is the day's ONE anchor pick (rarely two) and renders directly on the day card — use it only when the advisor specifically asked for dining that day, or this genuinely is the one place worth booking for that day. "alt" (a real secondary option) and "casual" (a quick/backup mention) never render inline — they're automatically pulled into a separate Dining Recommendations section grouped by destination, so don't hold back on adding several of these even on a light day; they won't clutter the day card. An actually confirmed dining reservation is "confirmed", not "dining".
- submit_rate_paste only stages a draft — it does not commit anything. Always show the advisor what was extracted and wait for an explicit approve/edit/reject; don't approve on their behalf.
- reject_rate_draft only works on a pending draft — it cannot touch a line item that's already confirmed. To remove a confirmed line item (a duplicate from a re-paste, a wrong approval), use remove_line_item instead, and only once the advisor has clearly said which specific one to remove.
- If the advisor asks for a total-for-stay/flat/package price instead of a nightly breakdown, represent that as unit "flat" with quantity 1 and rate_per_unit equal to the stated total. Never write a multi-night total into unit "night" with quantity 1 — that silently understates the true nightly cost by however many nights it actually covers. If dividing into a true per-night rate instead, set quantity to the actual number of nights, not 1.
- The same room can have a different rate for each night of a multi-night stay — that's still ONE line item, not one per night. rate_per_unit should be the blended average (total ÷ nights, or the sum of the nightly rates ÷ nights if no total is stated), with quantity set to the number of nights. Never leave two items with the same title as separate one-night entries for the same stay.
- generate_document builds fresh from whatever's currently on the trip — it can't attach or send the file itself, only store it. Point the advisor to the sidebar's Documents tab to download it. If generation fails because there's nothing to generate from yet, relay that plainly rather than retrying blindly.
- When you tell the advisor you're about to do something ("let me add the legs and submit those rates"), actually call every tool that requires in this same turn before your final reply — don't describe a multi-step plan and then stop having only checked state. If it's genuinely too much for one turn, do as much as you can and say exactly what's left, rather than promising work you haven't started.
- Never write a numbered list of steps you're about to take ("1. Edit the draft 2. Approve it 3. Remove the old items... Let me start:") and then stop without calling a single tool for any of them — a plan described in prose is not progress, and doing this leaves the advisor thinking work happened when nothing did. If you find yourself about to write "I'll now:" followed by a list, stop and call the first tool in that list instead of describing it.
- Be concise — this is a working chat, not a report. Point to the sidebar for anything the advisor can just look at rather than narrating it back in full.`

export interface ToolCallRecord {
  name:          string
  input:         unknown
  output:        unknown
}

export interface ChatTurnResult {
  reply:     string
  toolCalls: ToolCallRecord[]
  tripId:    string | null
}

interface ChatMessage {
  role:    'user' | 'assistant'
  content: string
}

// Tools that only ever read state — never a sign real work happened. Used
// below to detect the "announced a plan, executed nothing" failure mode:
// the model calls one of these to orient itself, then writes a numbered
// "I'll now: 1... 2... 3..." plan and stops instead of actually calling the
// tools for those steps. Deliberately narrow (exact match to the observed
// pattern) rather than a broad heuristic, to keep false-positive nudges rare.
const READ_ONLY_TOOLS = new Set(['get_trip_state'])
const PLAN_NUMBERED_LIST  = /(?:^|\n)\s*\d+\.\s/
const PLAN_INTENT_PHRASE  = /\b(I'?ll|I will|let me|going to)\b/i
// Catches both the numbered-list phrasing ("1. Edit... 2. Approve...") and
// the looser prose variant ("I'll edit those two, then approve the draft
// and remove the old items") — the latter has no numbered list at all, just
// several action verbs strung together after an intent phrase. Two or more
// tool-shaped verbs is the signal a real multi-step plan is being narrated
// rather than a single passing mention of one.
const PLAN_ACTION_VERBS = /\b(edit|approve|reject|remove|delete|add|save|submit|generate|create)\b/gi
function looksLikeStalledPlan(text: string): boolean {
  if (!PLAN_INTENT_PHRASE.test(text)) return false
  if (PLAN_NUMBERED_LIST.test(text)) return true
  const verbMatches = text.match(PLAN_ACTION_VERBS)
  return (verbMatches?.length ?? 0) >= 2
}

async function runToolLoop(
  systemPrompt: string,
  tools:        Anthropic.Tool[],
  messages:     Anthropic.MessageParam[],
  execute:      (name: string, input: any) => Promise<{ output: unknown }>,
): Promise<{ finalText: string; toolCalls: ToolCallRecord[] }> {
  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  let nudged = false

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
    })

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    if (textBlocks.length) finalText = textBlocks.map(b => b.text).join('\n')

    // Branch on whether there are tool_use blocks to run, not on stop_reason
    // — a response can be cut off by max_tokens mid tool-call (stop_reason
    // 'max_tokens') while content still holds a tool_use block. Keying off
    // stop_reason alone treated that as a finished/stalled turn and pushed
    // a plain-text message right after it, leaving the tool_use with no
    // matching tool_result — which the API then rejects outright on the
    // next call. Any tool_use present must always be executed and answered.
    if (toolUseBlocks.length === 0) {
      const onlyReadsSoFar = toolCalls.every(t => READ_ONLY_TOOLS.has(t.name))
      if (!nudged && onlyReadsSoFar && looksLikeStalledPlan(finalText)) {
        nudged = true
        messages.push({ role: 'assistant', content: response.content })
        messages.push({
          role: 'user',
          content: 'You just described a plan but didn\'t call any of the tools for it. Call the actual tools for every step now, in this response — don\'t describe the plan again.',
        })
        continue
      }
      break
    }

    messages.push({ role: 'assistant', content: response.content })

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of toolUseBlocks) {
      let resultPayload: unknown
      try {
        const { output } = await execute(block.name, block.input)
        resultPayload = output
      } catch (err: any) {
        resultPayload = { error: err.message }
      }
      toolCalls.push({ name: block.name, input: block.input, output: resultPayload })
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(resultPayload) })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  if (!finalText) {
    finalText = toolCalls.length
      ? "I ran a few actions but didn't manage to put together a final reply — try rephrasing, or ask me to summarize what I just did."
      : "I wasn't able to come up with a response — try rephrasing."
  }

  return { finalText, toolCalls }
}

// Pre-trip turn — ephemeral, nothing persisted. priorMessages is whatever
// the caller has been holding client-side for this not-yet-a-trip thread.
export async function runPreTripChatTurn(
  userMessage:    string,
  priorMessages:  ChatMessage[] = [],
  createdBy:      string,
): Promise<ChatTurnResult> {
  const messages: Anthropic.MessageParam[] = [
    ...priorMessages.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  let tripId: string | null = null
  const { finalText, toolCalls } = await runToolLoop(
    PRE_TRIP_SYSTEM_PROMPT,
    [START_TRIP_TOOL, CREATE_CLIENT_TOOL],
    messages,
    async (name, input) => {
      if (name === 'start_trip') {
        const result = await executeStartTrip(input, createdBy)
        if (result.trip) tripId = result.trip.id
        return { output: result.output }
      }
      if (name === 'create_client') {
        return executeCreateClient(input)
      }
      return { output: { error: `Unknown tool "${name}"` } }
    },
  )

  return { reply: finalText, toolCalls, tripId }
}

// Post-trip turn — full tool set, history loaded from and persisted to
// trip_chat_messages.
export async function runTripChatTurn(
  tripId:      string,
  userEmail:   string,
  userMessage: string,
): Promise<ChatTurnResult> {
  const { data: history, error: histErr } = await supabase
    .from('trip_chat_messages')
    .select('role, content')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true })
  if (histErr) throw new Error(`runTripChatTurn history: ${histErr.message}`)

  const messages: Anthropic.MessageParam[] = (history ?? []).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))
  messages.push({ role: 'user', content: userMessage })

  const { tools, execute } = buildTripBuilderTools(tripId)
  const { finalText, toolCalls } = await runToolLoop(POST_TRIP_SYSTEM_PROMPT, tools, messages, execute)

  const { error: insertUserErr } = await supabase.from('trip_chat_messages').insert({
    trip_id: tripId, created_by: userEmail, role: 'user', content: userMessage,
  })
  if (insertUserErr) throw new Error(`runTripChatTurn insert user message: ${insertUserErr.message}`)

  const { error: insertAssistantErr } = await supabase.from('trip_chat_messages').insert({
    trip_id: tripId, created_by: userEmail, role: 'assistant', content: finalText,
    tool_calls: toolCalls.length ? toolCalls : null,
  })
  if (insertAssistantErr) throw new Error(`runTripChatTurn insert assistant message: ${insertAssistantErr.message}`)

  return { reply: finalText, toolCalls, tripId }
}
