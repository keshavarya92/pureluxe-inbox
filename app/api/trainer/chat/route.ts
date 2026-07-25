import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { supabase } from '@/lib/supabase'
import { runChatTurn } from '@/lib/trainer/agent'

// GET — load this team member's chat history (persisted, per-user).
export async function GET() {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('trainer_chat_messages')
    .select('id, role, content, tool_calls, created_at')
    .eq('created_by', user.email)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ messages: data ?? [] })
}

// POST — send a message, get the assistant's reply (runs the tool-calling loop).
export async function POST(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { message } = await req.json()
  if (typeof message !== 'string' || !message.trim()) {
    return NextResponse.json({ error: 'message required' }, { status: 400 })
  }

  try {
    const result = await runChatTurn(user.email, message.trim())
    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[trainer/chat] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
