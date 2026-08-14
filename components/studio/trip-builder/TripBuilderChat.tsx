'use client'

import { useState, useEffect, useRef, type ChangeEvent } from 'react'
import { SuggestionCard } from './SuggestionCard'
import { RateDraftCard, type ExtractedLineItem } from './RateDraftCard'
import { TripPicker } from './TripPicker'

interface ToolCallRecord {
  name:   string
  input:  any
  output: any
}

interface ChatMessage {
  id:         string
  role:       'user' | 'assistant'
  content:    string
  tool_calls?: ToolCallRecord[] | null
}

let seq = 0
const tempId = () => `tmp-${++seq}`

// Short confirmation labels for tool calls that don't get their own card —
// per the build brief, the chat pane keeps these to one line and points to
// the sidebar for detail (sidebar itself lands in a later build step).
const TOOL_LABELS: Record<string, string> = {
  get_trip_state:     'Checked trip status',
  add_leg:            'Added a leg',
  save_itinerary_day: 'Saved itinerary content',
  edit_rate_draft:    'Edited rate draft',
  approve_rate_draft: 'Approved rate draft',
  reject_rate_draft:  'Rejected rate draft',
  select_line_item:   'Selected an option',
  start_trip:         'Started trip',
}

function ToolCallCards({ toolCalls, onActivity }: { toolCalls: ToolCallRecord[]; onActivity?: () => void }) {
  return (
    <div className="space-y-2">
      {toolCalls.map((t, i) => {
        if (t.name === 'request_suggestion' && t.output && !t.output.error) {
          return (
            <SuggestionCard
              key={i}
              destination={t.output.destination}
              property_name={t.output.property_name}
              source={t.output.source}
              content={t.output.content}
            />
          )
        }
        if (t.name === 'submit_rate_paste' && t.output?.id) {
          return (
            <RateDraftCard
              key={i}
              draftId={t.output.id}
              initialItems={t.output.extracted_json as ExtractedLineItem[]}
              initialStatus={t.output.status}
              onActivity={onActivity}
            />
          )
        }
        return (
          <p key={i} className="text-[10px] text-[#9B9A97]">
            {t.output?.error ? `${TOOL_LABELS[t.name] ?? t.name} — ${t.output.error}` : (TOOL_LABELS[t.name] ?? t.name)}
          </p>
        )
      })}
    </div>
  )
}

interface Props {
  tripId:         string | null
  onTripIdChange: (tripId: string | null) => void
  // Called after any successful action that changes trip data (send,
  // upload, or a draft card's approve/edit/reject) — lets a parent
  // workspace refresh the sidebar without this component knowing it exists.
  onActivity?:    () => void
}

export function TripBuilderChat({ tripId, onTripIdChange, onActivity }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(!!tripId)
  const [sending, setSending]   = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const MAX_INPUT_HEIGHT = 200
  function resizeTextarea() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }
  useEffect(resizeTextarea, [input])

  // Load persisted history when a tripId is present (deep link, reload, or
  // switching to a different trip via the picker). Clears stale messages
  // from whatever trip was previously open before the new history arrives.
  useEffect(() => {
    if (!tripId) return
    setLoading(true)
    setMessages([])
    setError(null)
    fetch(`/api/studio/trip-builder/chat?tripId=${tripId}`)
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load chat history')
        setMessages(data.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content, tool_calls: m.tool_calls })))
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
    // Only re-run if the trip actually changes (e.g. "New trip" reset).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending, uploading])

  function startNewTrip() {
    onTripIdChange(null)
    setMessages([])
    setError(null)
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setError(null)
    setMessages(prev => [...prev, { id: tempId(), role: 'user', content: text }])
    setSending(true)

    try {
      const body: Record<string, unknown> = tripId
        ? { tripId, message: text }
        : { tripId: null, message: text, history: messages.map(m => ({ role: m.role, content: m.content })) }

      const res = await fetch('/api/studio/trip-builder/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to send message')

      setMessages(prev => [...prev, { id: tempId(), role: 'assistant', content: data.reply, tool_calls: data.toolCalls }])
      if (!tripId && data.tripId) onTripIdChange(data.tripId)
      onActivity?.()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!tripId) {
      setError('Start a trip before uploading a rate document.')
      return
    }

    setUploading(true)
    setError(null)
    setMessages(prev => [...prev, { id: tempId(), role: 'user', content: `📎 Uploaded ${file.name}` }])

    try {
      const formData = new FormData()
      formData.append('tripId', tripId)
      formData.append('file', file)
      const res = await fetch('/api/studio/trip-builder/rate-drafts', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')

      // Uploads bypass the chat tool loop (they're not text the model can
      // reason over inline) — so this exchange isn't part of trip_chat_messages
      // history. The draft itself is fully persisted; only its appearance
      // here, in this session's transcript, is synthetic.
      setMessages(prev => [...prev, {
        id: tempId(), role: 'assistant', content: '',
        tool_calls: [{ name: 'submit_rate_paste', input: {}, output: data.draft }],
      }])
      onActivity?.()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-5 py-2 border-b border-[#E5E4E0] shrink-0">
        <p className="text-[11px] text-[#9B9A97]">{tripId ? `Trip ${tripId.slice(0, 8)}` : 'No trip open'}</p>
        <div className="flex items-center gap-3">
          {tripId && (
            <button onClick={startNewTrip} className="text-[11px] text-[#6B6A67] hover:text-[#0F0F0D]">
              + New trip
            </button>
          )}
          <TripPicker onSelect={onTripIdChange} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {loading && <p className="text-[12px] text-[#9B9A97]">Loading…</p>}
        {!loading && messages.length === 0 && !tripId && (
          <div className="text-[12px] text-[#9B9A97] max-w-md">
            <p className="mb-2">Tell me who this trip is for to get started, e.g.:</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>&quot;Start a trip for Meera Shah&quot;</li>
              <li>&quot;New trip for the Kapoor family — Maldives honeymoon&quot;</li>
            </ul>
          </div>
        )}
        {!loading && messages.length === 0 && tripId && (
          <p className="text-[12px] text-[#9B9A97]">
            No conversation on this trip yet — ask a question or give an instruction to get started.
          </p>
        )}
        {messages.map(m => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={m.role === 'user' ? 'max-w-[75%]' : 'max-w-[85%] space-y-2'}>
              {m.content && (
                <div
                  className={[
                    'rounded-lg px-3 py-2 text-[12px] whitespace-pre-wrap',
                    m.role === 'user' ? 'bg-[#0F0F0D] text-white' : 'bg-[#F5F4F1] text-[#0F0F0D]',
                  ].join(' ')}
                >
                  {m.content}
                </div>
              )}
              {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                <ToolCallCards toolCalls={m.tool_calls} onActivity={onActivity} />
              )}
            </div>
          </div>
        ))}
        {(sending || uploading) && <p className="text-[12px] text-[#9B9A97]">{uploading ? 'Extracting…' : 'Thinking…'}</p>}
        {error && <p className="text-[12px] text-[#E24B4A]">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-[#E5E4E0] px-5 py-3 shrink-0">
        <div className="flex gap-2">
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={handleFileSelected} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !tripId}
            title={tripId ? 'Upload a rate document (image or PDF)' : 'Start a trip first'}
            className="text-[11px] border border-[#E5E4E0] rounded-md px-3 py-2 self-end disabled:opacity-40"
          >
            Attach
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={tripId ? 'Ask a question, give an instruction, or paste rate text…' : 'Who is this trip for?'}
            disabled={sending}
            className="flex-1 text-[12px] border border-[#E5E4E0] rounded px-3 py-2 resize-none overflow-y-auto leading-normal focus:outline-none focus:border-[#9B9A97] disabled:bg-[#F5F4F1]"
          />
          <button
            onClick={handleSend}
            disabled={sending || !input.trim()}
            className="text-[11px] bg-[#0F0F0D] text-white px-3 py-2 rounded-md hover:opacity-90 disabled:opacity-50 self-end"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
