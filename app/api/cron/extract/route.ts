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

// ----------------------------------------------------------------
// Relationship resolution helpers
// ----------------------------------------------------------------

async function resolveClient(clientName: string): Promise<string> {
  const { data } = await supabase
    .from('clients')
    .select('id')
    .ilike('full_name', clientName)
    .maybeSingle()

  if (data) return data.id

  const { data: created, error } = await supabase
    .from('clients')
    .insert({ full_name: clientName })
    .select('id')
    .single()
  if (error) throw new Error(`clients insert: ${error.message}`)
  return created.id
}

async function resolveProperty(
  hotelName: string,
  city: string | null,
  country: string | null,
  chain: string | null,
): Promise<string> {
  const { data } = await supabase
    .from('properties')
    .select('id')
    .ilike('name', hotelName)
    .maybeSingle()

  if (data) return data.id

  const { data: created, error } = await supabase
    .from('properties')
    .insert({ name: hotelName, city, country, chain })
    .select('id')
    .single()
  if (error) throw new Error(`properties insert: ${error.message}`)
  return created.id
}

async function resolveBookedBy(inboxAddress: string): Promise<string | null> {
  const { data } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', inboxAddress)
    .maybeSingle()
  return data?.id ?? null
}

// ----------------------------------------------------------------
// Cancellation deadline parsing
// ----------------------------------------------------------------

function parseCancellationDeadline(value: string | null, checkIn: string | null): string | null {
  if (!value) return null

  // Already a YYYY-MM-DD date
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim()

  // Non-refundable — no free cancellation window, treat as check-in date
  if (/non.?refundable|no cancell/i.test(value)) {
    return checkIn ?? null
  }

  if (!checkIn) return null

  const base = new Date(checkIn)
  if (isNaN(base.getTime())) return null

  const v = value.toLowerCase()

  let days: number | null = null

  if (/1\s*day|24\s*hour/i.test(v))           days = 1
  else if (/2\s*day/i.test(v))                 days = 2
  else if (/3\s*day/i.test(v))                 days = 3
  else if (/7\s*day|1\s*week/i.test(v))        days = 7
  else if (/14\s*day|2\s*week/i.test(v))       days = 14
  else if (/30\s*day|1\s*month/i.test(v))      days = 30
  else if (/45\s*day/i.test(v))                days = 45
  else if (/60\s*day|2\s*month/i.test(v))      days = 60
  else if (/90\s*day|3\s*month/i.test(v))      days = 90

  if (days === null) return null

  base.setUTCDate(base.getUTCDate() - days)
  return base.toISOString().slice(0, 10)
}

// ----------------------------------------------------------------
// Extraction
// ----------------------------------------------------------------

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

// ----------------------------------------------------------------
// Upsert — deduplicates on hotel_ref / amadeus_ref
// ----------------------------------------------------------------

async function upsertBooking(
  extracted: Record<string, unknown>,
  emailId: string,
  clientId: string | null,
  propertyId: string | null,
  bookedBy: string | null,
): Promise<'inserted' | 'updated'> {
  // Check for an existing booking by hotel_ref or amadeus_ref
  const orParts: string[] = []
  if (extracted.hotel_ref)   orParts.push(`hotel_ref.eq.${extracted.hotel_ref}`)
  if (extracted.amadeus_ref) orParts.push(`amadeus_ref.eq.${extracted.amadeus_ref}`)

  let existingId: string | null = null
  if (orParts.length > 0) {
    const { data: existing } = await supabase
      .from('bookings')
      .select('id')
      .or(orParts.join(','))
      .maybeSingle()
    existingId = existing?.id ?? null
  }

  // Build payload — explicit field list; no nights (generated), no sub_agent_id/enquiry_id/amended_from
  const payload: Record<string, unknown> = {
    email_id:             emailId,
    client_id:            clientId,
    property_id:          propertyId,
    booked_by:            bookedBy,
    check_in:             extracted.check_in             ?? null,
    check_out:            extracted.check_out            ?? null,
    num_rooms:            extracted.num_rooms            ?? null,
    num_adults:           extracted.num_adults           ?? null,
    total_cost:           extracted.total_cost           ?? null,
    currency:             extracted.currency             ?? null,
    total_cost_usd:       extracted.total_cost_usd       ?? null,
    commission_rate:      extracted.commission_rate      ?? null,
    commission_expected:  extracted.commission_expected  ?? null,
    commission_channel:   extracted.commission_channel   ?? null,
    amadeus_ref:          extracted.amadeus_ref          ?? null,
    lhw_ref:              extracted.lhw_ref              ?? null,
    hotel_ref:            extracted.hotel_ref            ?? null,
    booking_source:       extracted.booking_source       ?? null,
    status:               extracted.status               ?? null,
    cancellation_deadline: extracted.cancellation_deadline ?? null,
    cancellation_policy:  extracted.cancellation_policy  ?? null,
    special_occasion:     extracted.special_occasion     ?? null,
    vip_flag:             extracted.vip_flag             ?? false,
  }

  if (existingId) {
    const { error } = await supabase.from('bookings').update(payload).eq('id', existingId)
    if (error) throw new Error(`bookings update: ${error.message}`)
    return 'updated'
  } else {
    const { error } = await supabase.from('bookings').insert(payload)
    if (error) throw new Error(`bookings insert: ${error.message}`)
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

// ----------------------------------------------------------------
// Handler
// ----------------------------------------------------------------

async function handler(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch inbox_address so we can look up the booked_by team member
  const { data: emails, error: fetchError } = await supabase
    .from('inbox_emails')
    .select('id, subject, body, snippet, inbox_address')
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
        await markExtracted(email.id)
        results.push({ id: email.id, outcome: 'skipped', detail: 'No booking data found' })
        continue
      }

      // Normalise cancellation_deadline from natural language → YYYY-MM-DD
      extracted.cancellation_deadline = parseCancellationDeadline(
        extracted.cancellation_deadline as string | null,
        extracted.check_in as string | null,
      )

      // Resolve all relationships before inserting
      const [clientId, propertyId, bookedBy] = await Promise.all([
        extracted.client_name
          ? resolveClient(extracted.client_name as string)
          : Promise.resolve(null),
        extracted.hotel_name
          ? resolveProperty(
              extracted.hotel_name as string,
              extracted.city as string | null,
              extracted.country as string | null,
              extracted.chain as string | null,
            )
          : Promise.resolve(null),
        email.inbox_address
          ? resolveBookedBy(email.inbox_address)
          : Promise.resolve(null),
      ])

      const outcome = await upsertBooking(extracted, email.id, clientId, propertyId, bookedBy)
      await markExtracted(email.id)
      results.push({ id: email.id, outcome })
    } catch (err: any) {
      console.error('Extraction failed for email:', email.id, err)
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

export const GET = handler
export const POST = handler
