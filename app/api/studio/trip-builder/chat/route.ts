import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { supabase } from '@/lib/supabase'
import { runPreTripChatTurn, runTripChatTurn } from '@/lib/trip-builder/agent'

// GET — persisted chat history for an existing trip.
export async function GET(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tripId = req.nextUrl.searchParams.get('tripId')
  if (!tripId) return NextResponse.json({ error: 'tripId required' }, { status: 400 })

  const { data, error } = await supabase
    .from('trip_chat_messages')
    .select('id, role, content, tool_calls, created_at')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ messages: data ?? [] })
}

// POST — send a message.
// { tripId: string, message: string } once a trip exists — history loads
//   from and persists to trip_chat_messages.
// { tripId: null, message: string, history?: [...] } before a trip exists —
//   the caller holds the thread client-side (see lib/trip-builder/agent.ts)
//   until start_trip succeeds and returns a tripId to switch to.
export async function POST(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tripId, message, history } = await req.json()
  if (typeof message !== 'string' || !message.trim()) {
    return NextResponse.json({ error: 'message required' }, { status: 400 })
  }

  try {
    const result = tripId
      ? await runTripChatTurn(tripId, user.email, message.trim())
      : await runPreTripChatTurn(message.trim(), Array.isArray(history) ? history : [], user.email)
    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[trip-builder/chat] error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
