// The unified Trainer Chat agent loop — replaces the fixed
// question-queue interview flow with a real conversation: Claude decides,
// per message, whether to look something up, write something, or just
// reply, calling tools from lib/trainer/tools.ts as needed.
//
// Persistence: only the conversational turns (user message, final
// assistant reply) are stored in trainer_chat_messages — the intermediate
// tool_use/tool_result exchanges within a single turn are transient
// scaffolding for that response and aren't fed back into future turns as
// history. tool_calls is stored alongside the assistant row purely for an
// auditable "what did it actually do" transcript in the UI.

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../supabase'
import { TRAINER_TOOLS, executeTool } from './tools'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-sonnet-4-6'
const MAX_TOOL_ROUNDS = 8 // guard against a runaway tool-call loop

const SYSTEM_PROMPT = `You are the Trainer Chat assistant for PureLuxe Studio, a luxury travel agency. You help the ops team (Sonali, Shreya, Ria, and others) clean up and enrich client data — mainly family-structure links (who's related to whom), but also contact details, preferences, and general notes.

You have tools to look up client/family data and to write changes. Rules:
- Answer questions by calling a lookup tool first — never state facts about specific clients from memory, always check live.
- When given a direct instruction ("link X to Y", "group these people"), call the write tool(s) and report back what you did. Don't ask for confirmation on every single write — that defeats the point of a chat interface.
- Never invent a relationship or fact the team member didn't state or clearly confirm. If you're inferring something (e.g. grouping people by a naming pattern) rather than acting on something explicitly said, say so out loud as you do it, so it's visibly a suggestion, not a stated fact.
- A shared surname is NOT proof two people are related — this whole cleanup effort exists because that assumption caused real data problems (the same surname can cover several unrelated households). Don't assume family membership from a name alone.
- If a write tool reports a conflict (two people already in different family records), explain the conflict plainly and let the team member decide — don't try to force it through.
- Session 1 priority order is Patni, Choksey, Jain, Agarwal — mention this if asked what to work on next, but you're not restricted to it; help with whatever's asked.
- Be concise. This is a working chat, not a report.
- Today's date context isn't reliable from training — trust tool results over your own assumptions about current data.`

export interface ToolCallRecord {
  name: string
  input: unknown
  output: unknown
  confirmation?: string
}

export interface ChatTurnResult {
  reply: string
  toolCalls: ToolCallRecord[]
}

export async function runChatTurn(userEmail: string, userMessage: string): Promise<ChatTurnResult> {
  const { data: history, error: histErr } = await supabase
    .from('trainer_chat_messages')
    .select('role, content')
    .eq('created_by', userEmail)
    .order('created_at', { ascending: true })
  if (histErr) throw new Error(`runChatTurn history: ${histErr.message}`)

  const messages: Anthropic.MessageParam[] = (history ?? []).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))
  messages.push({ role: 'user', content: userMessage })

  const toolCalls: ToolCallRecord[] = []
  let finalText = ''

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TRAINER_TOOLS,
      messages,
    })

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    if (textBlocks.length) finalText = textBlocks.map(b => b.text).join('\n')

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) break

    messages.push({ role: 'assistant', content: response.content })

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of toolUseBlocks) {
      let resultPayload: unknown
      let confirmation: string | undefined
      try {
        const { output, confirmation: c } = await executeTool(block.name, block.input, { created_by: userEmail })
        resultPayload = output
        confirmation = c
      } catch (err: any) {
        resultPayload = { error: err.message }
      }
      toolCalls.push({ name: block.name, input: block.input, output: resultPayload, confirmation })
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(resultPayload) })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  if (!finalText) {
    finalText = toolCalls.length
      ? "I ran a few lookups/writes but didn't manage to put together a final reply — try rephrasing, or ask me to summarize what I just did."
      : "I wasn't able to come up with a response — try rephrasing."
  }

  const { error: insertUserErr } = await supabase.from('trainer_chat_messages').insert({
    created_by: userEmail, role: 'user', content: userMessage,
  })
  if (insertUserErr) throw new Error(`runChatTurn insert user message: ${insertUserErr.message}`)

  const { error: insertAssistantErr } = await supabase.from('trainer_chat_messages').insert({
    created_by: userEmail, role: 'assistant', content: finalText,
    tool_calls: toolCalls.length ? toolCalls : null,
  })
  if (insertAssistantErr) throw new Error(`runChatTurn insert assistant message: ${insertAssistantErr.message}`)

  return { reply: finalText, toolCalls }
}
