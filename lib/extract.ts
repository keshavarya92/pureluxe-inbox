import { supabase } from './supabase'
import { getGmailClient } from './gmail'
import { processEmailAttachments } from './attachments'

const BATCH_LIMIT = 10

// ----------------------------------------------------------------
// Relationship resolution
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

export function parseCancellationDeadline(value: string | null, checkIn: string | null): string | null {
  if (!value) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim()

  if (/non.?refundable|no cancell/i.test(value)) return checkIn ?? null

  if (!checkIn) return null

  const base = new Date(checkIn)
  if (isNaN(base.getTime())) return null

  const v = value.toLowerCase()
  let days: number | null = null

  if      (/1\s*day|24\s*hour/i.test(v))    days = 1
  else if (/2\s*day/i.test(v))              days = 2
  else if (/3\s*day/i.test(v))              days = 3
  else if (/7\s*day|1\s*week/i.test(v))     days = 7
  else if (/14\s*day|2\s*week/i.test(v))    days = 14
  else if (/30\s*day|1\s*month/i.test(v))   days = 30
  else if (/45\s*day/i.test(v))             days = 45
  else if (/60\s*day|2\s*month/i.test(v))   days = 60
  else if (/90\s*day|3\s*month/i.test(v))   days = 90

  if (days === null) return null

  base.setUTCDate(base.getUTCDate() - days)
  return base.toISOString().slice(0, 10)
}

// ----------------------------------------------------------------
// Map Haiku's booking JSONB to bookings table columns
// ----------------------------------------------------------------

// Normalises dates to YYYY-MM-DD. Handles ISO dates and Amadeus
// format (DDMMMYYYY, e.g. 04JUL2026) so Postgres date columns accept them.
function toISODate(v: string | null | undefined): string | null {
  if (!v) return null
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const amadeusMatch = s.match(/^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/i)
  if (amadeusMatch) {
    const m: Record<string, string> = {
      JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
      JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12',
    }
    return `${amadeusMatch[3]}-${m[amadeusMatch[2].toUpperCase()]}-${amadeusMatch[1]}`
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function mapBookingJson(b: Record<string, any>): Record<string, unknown> {
  return {
    client_name:         b.clientName         ?? null,
    hotel_name:          b.property           ?? null,
    check_in:            toISODate(b.checkIn),
    check_out:           toISODate(b.checkOut),
    num_rooms:           b.rooms              ?? null,
    num_adults:          b.guests             ?? null,
    total_cost:          b.totalAmount        ?? null,
    currency:            b.currency           ?? null,
    status:              b.status             ?? null,
    amadeus_ref:         b.gdsRef             ?? null,
    hotel_ref:           b.confirmationNumber ?? null,
    commission_rate:     b.commissionRate     ?? null,
    commission_expected: b.commissionAmount   ?? null,
    booking_source:      b.gdsRef ? 'AMADEUS' : null,
    notes:               b.cancellationDeadline ?? null,
  }
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

  const payload: Record<string, unknown> = {
    email_id:              emailId,
    client_id:             clientId,
    property_id:           propertyId,
    booked_by:             bookedBy,
    check_in:              extracted.check_in              ?? null,
    check_out:             extracted.check_out             ?? null,
    num_rooms:             extracted.num_rooms             ?? null,
    num_adults:            extracted.num_adults            ?? null,
    total_cost:            extracted.total_cost            ?? null,
    currency:              extracted.currency              ?? null,
    total_cost_usd:        extracted.total_cost_usd        ?? null,
    commission_rate:       extracted.commission_rate       ?? null,
    commission_expected:   extracted.commission_expected   ?? null,
    commission_channel:    extracted.commission_channel    ?? null,
    amadeus_ref:           extracted.amadeus_ref           ?? null,
    lhw_ref:               extracted.lhw_ref               ?? null,
    hotel_ref:             extracted.hotel_ref             ?? null,
    booking_source:        extracted.booking_source        ?? null,
    status:                extracted.status                ?? null,
    cancellation_deadline: extracted.cancellation_deadline ?? null,
    cancellation_policy:   extracted.cancellation_policy   ?? null,
    special_occasion:      extracted.special_occasion      ?? null,
    vip_flag:              extracted.vip_flag              ?? false,
    notes:                 extracted.notes                 ?? null,
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

async function insertCommission(bookingId: string, extracted: Record<string, unknown>): Promise<void> {
  if (!extracted.commission_rate && !extracted.commission_expected) return
  const { error } = await supabase.from('commissions').insert({
    booking_id:          bookingId,
    commission_rate:     extracted.commission_rate     ?? null,
    commission_expected: extracted.commission_expected ?? null,
    commission_channel:  extracted.commission_channel  ?? null,
    currency:            extracted.currency            ?? null,
  })
  if (error) console.error('commissions insert:', error.message)
}

const ATTACHMENT_PHRASES = /please find attached|confirmation letter attached|please see attached|kindly find attached|booking confirmation attached|voucher attached/i

const NON_HOTEL_SUBJECTS = /boarding pass|flight check-in|bags? are checked|trip reminder/i

function hasConfirmationAttachment(snippet: string | null, body: string | null): boolean {
  return ATTACHMENT_PHRASES.test(snippet ?? '') || ATTACHMENT_PHRASES.test(body ?? '')
}

async function markAttachmentPending(emailId: string): Promise<void> {
  // Only flag — leave booking_extracted = false so the attachment pass can pick it up
  const { error } = await supabase
    .from('inbox_emails')
    .update({ has_confirmation_attachment: true })
    .eq('id', emailId)
  if (error) throw new Error(error.message)
}

async function markExtracted(emailId: string): Promise<void> {
  const { error } = await supabase
    .from('inbox_emails')
    .update({ booking_extracted: true })
    .eq('id', emailId)
  if (error) throw new Error(error.message)
}

// ----------------------------------------------------------------
// Public: run one batch of extraction
// ----------------------------------------------------------------

export interface ExtractionResult {
  processed: number
  inserted: number
  updated: number
  skipped: number
  errors: number
  attachments_processed: number
  timestamp: string
}

export async function runExtraction(): Promise<ExtractionResult> {
  // ---- Pass 1: read booking JSONB written by Haiku during classification ----

  const { data: emails, error: fetchError } = await supabase
    .from('inbox_emails')
    .select('id, subject, body, snippet, inbox_address, booking')
    .eq('category', 'booking')
    .eq('booking_extracted', false)
    .eq('has_confirmation_attachment', false)
    .not('booking', 'is', null)
    .limit(BATCH_LIMIT)

  if (fetchError) throw new Error(fetchError.message)

  const results: Array<'inserted' | 'updated' | 'skipped' | 'error'> = []

  for (const email of emails ?? []) {
    try {
      // Skip non-hotel transactional emails that Haiku may mis-classify
      if (NON_HOTEL_SUBJECTS.test(email.subject)) {
        await markExtracted(email.id)
        results.push('skipped')
        continue
      }

      if (hasConfirmationAttachment(email.snippet, email.body)) {
        // Flag for attachment pass; leave booking_extracted = false
        await markAttachmentPending(email.id)
        results.push('skipped')
        continue
      }

      const extracted = mapBookingJson(email.booking as Record<string, any>)

      // Skip only if we have neither a client nor a property — a partial record is fine
      if (!extracted.client_name && !extracted.hotel_name) {
        await markExtracted(email.id)
        results.push('skipped')
        continue
      }

      // Fall back to 'Unknown' so the record can be inserted and enriched later
      if (!extracted.hotel_name) extracted.hotel_name = 'Unknown'

      console.log('Upserting booking:', {
        emailId:     email.id,
        subject:     email.subject,
        client_name: extracted.client_name,
        hotel_name:  extracted.hotel_name,
        check_in:    extracted.check_in,
        check_out:   extracted.check_out,
        status:      extracted.status,
        amadeus_ref: extracted.amadeus_ref,
        hotel_ref:   extracted.hotel_ref,
      })

      const [clientId, propertyId, bookedBy] = await Promise.all([
        extracted.client_name
          ? resolveClient(extracted.client_name as string)
          : Promise.resolve(null),
        extracted.hotel_name
          ? resolveProperty(extracted.hotel_name as string, null, null, null)
          : Promise.resolve(null),
        email.inbox_address
          ? resolveBookedBy(email.inbox_address)
          : Promise.resolve(null),
      ])

      const outcome = await upsertBooking(extracted, email.id, clientId, propertyId, bookedBy)
      await markExtracted(email.id)
      results.push(outcome)
    } catch (err: any) {
      console.error('JSONB extraction failed for email:', email.id, err)
      await markExtracted(email.id).catch(() => {})
      results.push('error')
    }
  }

  // ---- Pass 2: attachment-based extraction via Sonnet ----

  const { data: attachmentEmails, error: attachFetchError } = await supabase
    .from('inbox_emails')
    .select('id, subject, from_email, snippet, inbox_address')
    .eq('has_confirmation_attachment', true)
    .eq('booking_extracted', false)
    .limit(5)

  if (attachFetchError) console.error('Attachment pass fetch error:', attachFetchError.message)

  let attachmentsProcessed = 0

  for (const email of attachmentEmails ?? []) {
    try {
      const { data: user } = await supabase
        .from('inbox_users')
        .select('access_token, refresh_token')
        .eq('email', email.inbox_address)
        .maybeSingle()

      if (!user?.access_token) {
        console.error('No Gmail tokens for inbox:', email.inbox_address)
        await markExtracted(email.id)
        continue
      }

      const gmail = getGmailClient(user.access_token, user.refresh_token)

      const extracted = await processEmailAttachments(gmail, email.id, {
        subject:   email.subject,
        from:      email.from_email,
        messageId: email.id,
      })

      if (!extracted || (!extracted.hotel_name && !extracted.client_name)) {
        await markExtracted(email.id)
        continue
      }

      extracted.cancellation_deadline = parseCancellationDeadline(
        extracted.cancellation_deadline as string | null,
        extracted.check_in as string | null,
      )

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

      if (outcome === 'inserted') {
        const { data: booking } = await supabase
          .from('bookings')
          .select('id')
          .eq('email_id', email.id)
          .maybeSingle()
        if (booking?.id) {
          await insertCommission(booking.id, extracted)
        }
      }

      await markExtracted(email.id)
      attachmentsProcessed++
    } catch (err: any) {
      console.error('Attachment extraction failed for email:', email.id, err)
      await markExtracted(email.id).catch(() => {})
    }
  }

  return {
    processed:             (emails?.length ?? 0),
    inserted:              results.filter(r => r === 'inserted').length,
    updated:               results.filter(r => r === 'updated').length,
    skipped:               results.filter(r => r === 'skipped').length,
    errors:                results.filter(r => r === 'error').length,
    attachments_processed: attachmentsProcessed,
    timestamp:             new Date().toISOString(),
  }
}
