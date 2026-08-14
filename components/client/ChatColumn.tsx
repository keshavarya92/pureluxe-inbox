'use client'

import { useState, useEffect, useRef } from 'react'

interface ToolCallRecord {
  name:   string
  input:  any
  output: any
}

interface ChatMessage {
  id:          string
  role:        'user' | 'assistant'
  content:     string
  tool_calls?: ToolCallRecord[] | null
}

let seq = 0
const tempId = () => `tmp-${++seq}`

// One-line confirmations for tool calls, matching the pattern Studio's
// Trip Builder chat uses (TOOL_LABELS in TripBuilderChat.tsx) — detail
// lives in the sidebar, chat just confirms something happened.
const TOOL_LABELS: Record<string, string> = {
  get_trip_state:    'Checked trip status',
  add_leg:           'Added a stop',
  edit_leg:          'Updated dates',
  request_suggestion: 'Looked up a suggestion',
  save_itinerary_day: 'Updated the itinerary',
  mark_leaning:      'Updated leaning selection',
}

function toolCallLabel(t: ToolCallRecord): string {
  if (t.name === 'lookup_property_rates') {
    if (t.output?.error) return `Rate lookup — ${t.output.error}`
    const count = t.output?.options?.length ?? 0
    return `Found ${count} option${count === 1 ? '' : 's'} for ${t.output?.property_name ?? 'that property'} — see Rates`
  }
  if (t.output?.error) return `${TOOL_LABELS[t.name] ?? t.name} — ${t.output.error}`
  return TOOL_LABELS[t.name] ?? t.name
}

interface Props {
  tripId:     string
  tripTitle:  string
  onActivity: () => void
}

export function ChatColumn({ tripId, tripTitle, onActivity }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(true)
  const [sending, setSending]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/client/trips/${tripId}/chat`)
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load chat history')
        setMessages(data.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content, tool_calls: m.tool_calls })))
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [tripId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setError(null)
    setMessages(prev => [...prev, { id: tempId(), role: 'user', content: text }])
    setSending(true)

    try {
      const res = await fetch(`/api/client/trips/${tripId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to send message')
      setMessages(prev => [...prev, { id: tempId(), role: 'assistant', content: data.reply, tool_calls: data.toolCalls }])
      onActivity()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 py-3 border-b border-[#E5E4E0] shrink-0">
        <p className="text-[13px] font-medium text-[#0F0F0D] truncate">{tripTitle}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
        {loading && <p className="text-[12.5px] text-[#9B9A97]">Loading…</p>}
        {!loading && messages.length === 0 && (
          <div className="text-[13px] text-[#9B9A97] max-w-md">
            <p>Tell PureLuxe about the trip you have in mind, e.g.:</p>
            <ul className="list-disc pl-4 mt-2 space-y-1">
              <li>&quot;Looking for a quiet beach escape in the Maldives, 5 nights in October&quot;</li>
              <li>&quot;Somewhere in Italy with a view, for our anniversary in June&quot;</li>
            </ul>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={m.role === 'user' ? 'max-w-[78%]' : 'max-w-[85%] space-y-1.5'}>
              {m.content && (
                <div
                  className={[
                    'text-[14px] leading-relaxed rounded-lg px-3.5 py-2.5 whitespace-pre-wrap',
                    m.role === 'user' ? 'bg-[#0F0F0D] text-white' : 'bg-[#F5F4F1] text-[#0F0F0D]',
                  ].join(' ')}
                >
                  {m.content}
                </div>
              )}
              {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                <div className="space-y-1">
                  {m.tool_calls.map((t, i) => (
                    <p key={i} className="text-[10.5px] text-[#9B9A97]">{toolCallLabel(t)}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && <p className="text-[12.5px] text-[#9B9A97]">Thinking…</p>}
        {error && <p className="text-[12.5px] text-[#E24B4A]">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-[#E5E4E0] px-5 py-4 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Message PureLuxe"
            disabled={sending}
            className="flex-1 text-[13.5px] border border-[#E5E4E0] rounded-lg px-3.5 py-2.5 resize-none overflow-y-auto leading-normal max-h-[160px] focus:outline-none focus:border-[#9B9A97] disabled:bg-[#F5F4F1]"
          />
          <button
            onClick={handleSend}
            disabled={sending || !input.trim()}
            aria-label="Send"
            className="w-9 h-9 flex items-center justify-center bg-[#0F0F0D] text-white rounded-lg hover:opacity-90 disabled:opacity-40 shrink-0"
          >
            →
          </button>
        </div>
      </div>
    </div>
  )
}
