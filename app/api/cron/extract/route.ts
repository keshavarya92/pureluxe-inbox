import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const BATCH_LIMIT = 10

const SYSTEM = `You are a booking data extraction system for PureLuxe, a luxury travel agency based in Mumbai (KFT Corporation).
Extract structured booking data from hotel confirmation emails, option emails, and rate quotes.
Respond ONLY with valid JSON. No markdown, no explanation, no backticks.`

function buildPrompt(subject: string, body: string | null, snippet: string): string {
  return `Extract all booking data from this email.

SUBJECT: ${subject}
BODY:
${body || snippet}

Return this exact JSON (use null for any field you cannot find with confidence):
{
  "client_name": "Full client name or null",
  "hotel_name": "Hotel or resort name or null",
  "city": "City or null",
  "country": "Country or null",
  "chain": "Hotel chain/brand or null",
  "check_in": "YYYY-MM-DD or null",
  "check_out": "YYYY-MM-DD or null",
  "num_rooms": number or null,
  "num_adults": number or null,
  "total_cost": number or null,
  "currency": "3-letter currency code or null",
  "total_cost_usd": number or null,
  "commission_rate": number or null,
  "commission_expected": number or null,
  "commission_channel": "channel name or null",
  "amadeus_ref": "Amadeus PNR or null",
  "lhw_ref": "LHW reference number or null",
  "hotel_ref": "Hotel confirmation number or null",
  "booking_source": "AMADEUS or LHW or DIRECT or ONYX or null",
  "status": "confirmed or option or cancelled or null",
  "booked_by_name": "Name of agent/person who made the booking or null",
  "cancellation_deadline": "YYYY-MM-DD or null",
  "cancellation_policy": "Cancellation policy text or null",
  "special_occasion": "Birthday/anniversary/honeymoon/etc or null",
  "vip_flag": true or false
}`
}

async function extractBooking(subject: string, body: string | null, snippet: string): Promise<Record<string, unknown> | null> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(subject, body, snippet) }],
  })

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  const cleaned = text.replace(/```json|```/g, '').trim()
  return JSON.parse(cleaned)
}

async function upsertBooking(data: Record<string, unknown>, emailId: string): Promise<'inserted' | 'updated'> {
  // Check for an existing booking by hotel_ref or amadeus_ref — whichever are non-null
  const orParts: string[] = []
  if (data.hotel_ref)   orParts.push(`hotel_ref.eq.${data.hotel_ref}`)
  if (data.amadeus_ref) orParts.push(`amadeus_ref.eq.${data.amadeus_ref}`)

  let existingId: string | null = null

  if (orParts.length > 0) {
    const { data: existing } = await supabase
      .from('bookings')
      .select('id')
      .or(orParts.join(','))
      .maybeSingle()
    existingId = existing?.id ?? null
  }

  const payload = { ...data, email_id: emailId }

  if (existingId) {
    const { error } = await supabase.from('bookings').update(payload).eq('id', existingId)
    if (error) throw new Error(error.message)
    return 'updated'
  } else {
    const { error } = await supabase.from('bookings').insert(payload)
    if (error) throw new Error(error.message)
    return 'inserted'
  }
}

async function markExtracted(emailId: string): Promise<void> {
  const { error } = await supabase
    .from('inbox_emails')
    .update({ booking_extracted: true })
    .eq('id', emailId)
  if (error) throw new Error(error.message)
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch up to BATCH_LIMIT unextracted booking emails
  const { data: emails, error: fetchError } = await supabase
    .from('inbox_emails')
    .select('id, subject, body, snippet')
    .eq('category', 'booking')
    .eq('booking_extracted', false)
    .limit(BATCH_LIMIT)

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  if (!emails || emails.length === 0) {
    return NextResponse.json({ processed: 0, message: 'No unextracted booking emails', timestamp: new Date().toISOString() })
  }

  const results: { id: string; outcome: 'inserted' | 'updated' | 'skipped' | 'error'; detail?: string }[] = []

  for (const email of emails) {
    try {
      const extracted = await extractBooking(email.subject, email.body, email.snippet)

      if (!extracted || (!extracted.hotel_name && !extracted.client_name)) {
        // Claude found nothing useful — mark extracted to skip on next run
        await markExtracted(email.id)
        results.push({ id: email.id, outcome: 'skipped', detail: 'No booking data found' })
        continue
      }

      const outcome = await upsertBooking(extracted, email.id)
      await markExtracted(email.id)
      results.push({ id: email.id, outcome })
    } catch (err: any) {
      console.error('Extraction failed for email:', email.id, err)
      // Mark extracted anyway to avoid retrying a permanently broken email
      await markExtracted(email.id).catch(() => {})
      results.push({ id: email.id, outcome: 'error', detail: err.message })
    }
  }

  const inserted = results.filter(r => r.outcome === 'inserted').length
  const updated  = results.filter(r => r.outcome === 'updated').length
  const skipped  = results.filter(r => r.outcome === 'skipped').length
  const errors   = results.filter(r => r.outcome === 'error').length

  return NextResponse.json({
    processed: emails.length,
    inserted,
    updated,
    skipped,
    errors,
    timestamp: new Date().toISOString(),
  })
}
