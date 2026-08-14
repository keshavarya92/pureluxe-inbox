import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runClientChatTurn } from '@/lib/client/agent'

// GET — persisted chat history for a trip.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { data, error } = await supabase
    .from('client_chat_messages')
    .select('id, role, content, tool_calls, created_at')
    .eq('trip_id', id)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ messages: data ?? [] })
}

// POST — send a message to the Curator agent.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { message } = await req.json()
  if (typeof message !== 'string' || !message.trim()) {
    return NextResponse.json({ error: 'message required' }, { status: 400 })
  }

  try {
    const result = await runClientChatTurn(id, message.trim())
    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[client/trips/chat] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
