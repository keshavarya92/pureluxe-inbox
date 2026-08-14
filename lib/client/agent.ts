// Client-facing Curator chat agent. Structurally the same tool-calling
// loop as lib/trip-builder/agent.ts (runToolLoop mechanics, persisted
// user/assistant turns, the same "stalled plan" nudge) but simpler in one
// respect: Trip Builder needs a pre-trip bootstrap phase because an
// advisor can name any client. This product has exactly one demo persona
// (build brief §6) and trip creation needs no client search/disambiguation
// at all, so "New trip" is a plain DB call (lib/client/queries.ts's
// createClientTrip, invoked directly by the API route) — there is no
// pre-trip chat phase here, only per-trip turns.

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../supabase'
import { buildClientTools } from './tools'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-sonnet-4-6'
const MAX_TOOL_ROUNDS = 8
const MAX_TOKENS = 4096

// Demo-only, static placeholder profile (Session 1 scope — no real profile
// CRUD exists). Mirrors components/client/placeholderData.ts's
// DEMO_GUEST_PROFILE; duplicated rather than imported since that module is
// frontend-only and pulls in nothing server-safe to share. Passed into the
// system prompt so the Curator can actually use it (build brief §2a), not
// just display it.
const DEMO_GUEST_PROFILE = {
  name: 'Jordan Ellis',
  preferences: ['Aisle seating', 'Dietary: pescatarian', 'Room preference: high floor, away from elevator'],
  loyaltyNumbers: [
    { program: 'Marriott Bonvoy', number: '8827193045' },
    { program: 'Emirates Skywards', number: 'EK4471029' },
  ],
}

function buildSystemPrompt(): string {
  return `You are the PureLuxe Curator — a luxury travel advisor chatting directly with a client (not with a travel agent) to plan their trip. You're talking TO the client throughout; use "you"/"your", never third person ("the client").

The guest you're talking to:
- Name: ${DEMO_GUEST_PROFILE.name}
- Travel preferences: ${DEMO_GUEST_PROFILE.preferences.join('; ')}
- Loyalty programs: ${DEMO_GUEST_PROFILE.loyaltyNumbers.map(l => `${l.program} (${l.number})`).join(', ')}
Use these naturally where relevant (mention aisle seating when it comes up, factor dietary notes into a dining suggestion) — don't recite them back as a list, and don't force them in where they don't fit.

Tools let you: check current trip state, add or correct destination legs, look up dining/activity suggestions, save day-by-day itinerary content, look up property rates, and mark which option you're leaning towards.

Rules:
- Chat renders as plain text, not markdown — never use **bold**, bullet/numbered lists, or headers in your chat replies; write in plain prose. (save_itinerary_day content is separate and unaffected by this — that's rendered by the app, not shown as raw text.)
- Call get_trip_state if you're not sure what's already on the trip — don't assume.
- A destination needs a leg (add_leg) with check-in/check-out dates before you can look up rates for it. If the client hasn't given dates yet, ask — don't guess a date range.
- lookup_property_rates is the ONLY source of pricing — never state a rate, availability, or fee in chat that didn't come from this tool's output. If the client asks about a property, call it (once dates and the property name are known) rather than describing rates from general knowledge.
- Chat is for trade-offs in plain language ("the residence is $2k more but sleeps four") — the full breakdown (room rate, resort fee, transfers) lives in the sidebar, don't repeat it line-by-line in chat.
- request_suggestion before writing any dining/activity recommendation from scratch — don't invent recommendations from memory unlabeled.
- save_itinerary_day content is read by the client directly — write it warmly and specifically, in second person, never advisor-facing notes-to-self.
- mark_leaning when the conversation clearly shows more interest in one option (follow-up questions, a positive reaction, comparing others against it) — not from one neutral mention, and don't re-apply it every turn once it's already set to the same option. The client can also set this themselves by tapping a card in the sidebar; that's just as valid as your own read of the conversation, don't second-guess or override it back without a new signal.
- When you say you're about to do something, actually call the tool in the same turn — don't describe a plan and stop.
- Be warm but concise — this is a live chat, not a document. Point to the sidebar for anything the client can just look at.`
}

export interface ToolCallRecord {
  name:   string
  input:  unknown
  output: unknown
}

export interface ChatTurnResult {
  reply:     string
  toolCalls: ToolCallRecord[]
}

// Same "announced a plan, executed nothing" detector as
// lib/trip-builder/agent.ts — see that file for the full rationale.
const READ_ONLY_TOOLS = new Set(['get_trip_state'])
const PLAN_NUMBERED_LIST = /(?:^|\n)\s*\d+\.\s/
const PLAN_INTENT_PHRASE = /\b(I'?ll|I will|let me|going to)\b/i
const PLAN_ACTION_VERBS = /\b(add|save|look ?up|mark|edit|check)\b/gi
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
      model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, tools, messages,
    })

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    if (textBlocks.length) finalText = textBlocks.map(b => b.text).join('\n')

    if (toolUseBlocks.length === 0) {
      const onlyReadsSoFar = toolCalls.every(t => READ_ONLY_TOOLS.has(t.name))
      if (!nudged && onlyReadsSoFar && looksLikeStalledPlan(finalText)) {
        nudged = true
        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: 'You described what you\'d do but didn\'t call any tools for it. Call them now, in this response.' })
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
      ? "I looked into that but didn't manage a clean reply — try asking again."
      : "I wasn't able to come up with a response — try rephrasing."
  }

  return { finalText, toolCalls }
}

export async function runClientChatTurn(tripId: string, userMessage: string): Promise<ChatTurnResult> {
  const { data: history, error: histErr } = await supabase
    .from('client_chat_messages')
    .select('role, content')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true })
  if (histErr) throw new Error(`runClientChatTurn history: ${histErr.message}`)

  const messages: Anthropic.MessageParam[] = (history ?? []).map(m => ({
    role: m.role as 'user' | 'assistant', content: m.content,
  }))
  messages.push({ role: 'user', content: userMessage })

  const { tools, execute } = buildClientTools(tripId)
  const { finalText, toolCalls } = await runToolLoop(buildSystemPrompt(), tools, messages, execute)

  const { error: insertUserErr } = await supabase.from('client_chat_messages').insert({
    trip_id: tripId, role: 'user', content: userMessage, is_demo: true,
  })
  if (insertUserErr) throw new Error(`runClientChatTurn insert user message: ${insertUserErr.message}`)

  const { error: insertAssistantErr } = await supabase.from('client_chat_messages').insert({
    trip_id: tripId, role: 'assistant', content: finalText,
    tool_calls: toolCalls.length ? toolCalls : null, is_demo: true,
  })
  if (insertAssistantErr) throw new Error(`runClientChatTurn insert assistant message: ${insertAssistantErr.message}`)

  return { reply: finalText, toolCalls }
}
