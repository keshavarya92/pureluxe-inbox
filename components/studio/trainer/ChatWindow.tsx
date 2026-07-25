'use client'

import { useState, useEffect, useRef } from 'react'

interface ToolCallRecord {
  name: string
  confirmation?: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  tool_calls?: ToolCallRecord[] | null
}

let seq = 0
const tempId = () => `tmp-${++seq}`

export function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(true)
  const [sending, setSending]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the input with content (line breaks, long pastes) up to a
  // max height, then let it scroll internally instead of pushing the rest
  // of the page around.
  const MAX_INPUT_HEIGHT = 200
  function resizeTextarea() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }
  useEffect(resizeTextarea, [input])

  useEffect(() => {
    fetch('/api/trainer/chat')
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load chat history')
        setMessages(data.messages)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

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
      const res = await fetch('/api/trainer/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to send message')
      setMessages(prev => [...prev, { id: tempId(), role: 'assistant', content: data.reply, tool_calls: data.toolCalls }])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {loading && <p className="text-[12px] text-[#9B9A97]">Loading conversation…</p>}
        {!loading && messages.length === 0 && (
          <div className="text-[12px] text-[#9B9A97] max-w-md">
            <p className="mb-2">Ask about a client or family, or tell me what to do — e.g.:</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>&quot;List the Jain family&quot;</li>
              <li>&quot;Link Abhiraj Atul Choksey as spouse of Biyash Choksey&quot;</li>
              <li>&quot;What do we know about Sandeep Jain?&quot;</li>
              <li>&quot;What should I work on next?&quot;</li>
            </ul>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={[
                'max-w-[75%] rounded-lg px-3 py-2 text-[12px] whitespace-pre-wrap',
                m.role === 'user' ? 'bg-[#0F0F0D] text-white' : 'bg-[#F5F4F1] text-[#0F0F0D]',
              ].join(' ')}
            >
              {m.content}
              {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[#E5E4E0] space-y-0.5">
                  {m.tool_calls.map((t, i) => (
                    <p key={i} className="text-[10px] text-[#9B9A97]">
                      {t.confirmation ?? t.name}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && <p className="text-[12px] text-[#9B9A97]">Thinking…</p>}
        {error && <p className="text-[12px] text-[#E24B4A]">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-[#E5E4E0] px-5 py-3 shrink-0">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              // Enter sends; Shift+Enter inserts a newline — lets you type
              // (or paste) multi-line feedback without it firing early.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Ask a question or give an instruction…"
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
