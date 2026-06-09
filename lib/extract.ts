// Schema-aware AI extraction agent.
// A single Sonnet call per email extracts all structured data across all tables.
// Rules-based logic, JSONB mapping, category filtering, and phrase detection are gone.

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getGmailClient } from './gmail'
import { fetchAttachments, extractTextFromAttachment, type Attachment } from './attachments'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ----------------------------------------------------------------
// Relationship resolution
// ----------------------------------------------------------------

export async function resolveClient(name: string): Promise<string> {
  const { data } = await supabase.from('clients').select('id').ilike('full_name', name).maybeSingle()
  if (data) return data.id
  const { data: created, error } = await supabase
    .from('clients').insert({ full_name: name }).select('id').single()
  if (error) throw new Error(`clients insert: ${error.message}`)
  return created.id
}

export async function resolveProperty(
  name: string,
  city: string | null,
  country: string | null,
  chain: string | null,
): Promise<string> {
  const { data } = await supabase.from('properties').select('id').ilike('name', name).maybeSingle()
  if (data) return data.id
  const { data: created, error } = await supabase
    .from('properties').insert({ name, city, country, chain }).select('id').single()
  if (error) throw new Error(`properties insert: ${error.message}`)
  return created.id
}

export async function resolveBookedBy(inboxAddress: string): Promise<string | null> {
  const { data } = await supabase
    .from('team_members').select('id').eq('email', inboxAddress).maybeSingle()
  return data?.id ?? null
}

// ----------------------------------------------------------------
// Cancellation deadline parser (utility export)
// ----------------------------------------------------------------

export function parseCancellationDeadline(
  value: string | null,
  checkIn: string | null,
): string | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim()
  if (/non.?refundable|no cancell/i.test(value)) return checkIn ?? null
  if (!checkIn) return null
  const base = new Date(checkIn)
  if (isNaN(base.getTime())) return null
  const v = value.toLowerCase()
  let days: number | null = null
  if      (/1\s*day|24\s*hour/i.test(v))  days = 1
  else if (/2\s*day/i.test(v))            days = 2
  else if (/3\s*day/i.test(v))            days = 3
  else if (/7\s*day|1\s*week/i.test(v))   days = 7
  else if (/14\s*day|2\s*week/i.test(v))  days = 14
  else if (/30\s*day|1\s*month/i.test(v)) days = 30
  else if (/45\s*day/i.test(v))           days = 45
  else if (/60\s*day|2\s*month/i.test(v)) days = 60
  else if (/90\s*day|3\s*month/i.test(v)) days = 90
  if (days === null) return null
  base.setUTCDate(base.getUTCDate() - days)
  return base.toISOString().slice(0, 10)
}

// ----------------------------------------------------------------
// Identity document upload to Supabase Storage
// ----------------------------------------------------------------

async function uploadIdentityDoc(emailId: string, att: Attachment): Promise<void> {
  const path = `${emailId}/${att.filename}`
  const { error } = await supabase.storage
    .from('client-documents')
    .upload(path, att.data, { contentType: att.mimeType, upsert: true })
  if (error) {
    console.error('Storage upload failed:', error.message)
    return
  }
  // Insert record if client_documents table exists
  await supabase.from('client_documents').insert({
    email_id:     emailId,
    filename:     att.filename,
    mime_type:    att.mimeType,
    storage_path: path,
  }).catch(() => {})
}

// ----------------------------------------------------------------
// Extraction system prompt
// ----------------------------------------------------------------

const EXTRACTION_SYSTEM = `You are a data extraction agent for PureLuxe International, a luxury travel agency (KFT Corporation, Mumbai). You have access to our complete database schema. Read this email carefully including any attachment content provided. Extract ALL structured data and map it to our database tables. Use your judgment — you understand what each table is for.

Our database tables and their key columns:
- bookings: client_name, hotel_name, city, country, chain, check_in (YYYY-MM-DD), check_out (YYYY-MM-DD), num_rooms, num_adults, total_cost, currency, commission_rate, commission_expected, commission_channel, hotel_ref, amadeus_ref, lhw_ref, onyx_ref, status (confirmed/option/enquiry/cancelled), cancellation_deadline (YYYY-MM-DD), cancellation_policy, special_occasion, vip_flag, booked_by_name, booking_source, group_name, notes, misc
- commissions: amount_expected, currency, channel (TACS/ONYX/BANK_TRANSFER/SLH/DIRECT), status (pending/received/disputed), date_received (YYYY-MM-DD), bank_ref, notes, misc
- clients: full_name, title, first_name, last_name, email, phone, nationality, loyalty_programs (array of {chain, number, tier}), birthday, anniversary, general_notes, misc
- client_preferences: client_name (for lookup), category (room/dining/beverage/amenity/service/health), preference, preference_type (like/dislike/allergy/requirement), notes
- client_health_notes: client_name (for lookup), condition, details, dietary_restrictions (array), mobility_notes
- property_contacts: name, title, email, phone, property (name for lookup), department
- properties: name, chain, city, country, property_type, reservations_email, default_commission, commission_channel
- pre_stay_tasks: task_type (arrival_time_request/dietary_brief/wellness_questionnaire/room_preference_request/transfer_coordination/vip_brief/upgrade_request), description, due_date (YYYY-MM-DD)
- air_bookings: passenger_name, airline, flight_number, origin (IATA), destination (IATA), departure_datetime, cabin_class, pnr, ticket_number, fare_inr, total_inr, consolidator, client_type (leisure/corporate), corporate_account
- airport_vip_services: airport (IATA), airport_name, service_type (meet_assist/vip_lounge/fast_track), service_date (YYYY-MM-DD), flight_number, pax_names (array), provider, status, cost, currency
- enquiries: client_name, property_name, destination, check_in, check_out, num_rooms, num_adults, quoted_rate, quoted_currency, notes, misc
- visa_tracking: client_name (for lookup), destination_country, nationality, visa_required, visa_type, visa_status, application_date, expected_date, notes

Return ONLY valid JSON with this structure. Use null for any table where no relevant data exists. Never invent data — only extract what is explicitly present in the email.
{
  "bookings": [ {...} ] or null,
  "commissions": [ {...} ] or null,
  "clients": [ {...} ] or null,
  "client_preferences": [ {...} ] or null,
  "client_health_notes": [ {...} ] or null,
  "property_contacts": [ {...} ] or null,
  "properties": [ {...} ] or null,
  "pre_stay_tasks": [ {...} ] or null,
  "air_bookings": [ {...} ] or null,
  "airport_vip_services": [ {...} ] or null,
  "enquiries": [ {...} ] or null,
  "visa_tracking": [ {...} ] or null,
  "misc": "any relevant data that does not fit the above tables as free text"
}`

// ----------------------------------------------------------------
// Step 1 + 2: gather all content and run a single Sonnet call
// ----------------------------------------------------------------

interface EmailInput {
  id: string
  subject: string
  from: string
  to: string[]
  date: string
  snippet: string
  body: string | null
  inbox_address: string
}

async function extractFromEmail(
  email: EmailInput,
  gmail: any | null,
): Promise<Record<string, any> | null> {
  const blocks: any[] = []

  // Email context as first text block
  blocks.push({
    type: 'text',
    text: `FROM: ${email.from}\nTO: ${email.to.join(', ')}\nDATE: ${email.date}\nSUBJECT: ${email.subject}\n\n${email.body || email.snippet}`,
  })

  // Attachments
  if (gmail) {
    let attachments: Attachment[] = []
    try {
      attachments = await fetchAttachments(gmail, email.id)
    } catch (err) {
      console.error('fetchAttachments failed for', email.id, err)
    }

    for (const att of attachments) {
      try {
        const isIdentity = /passport|visa|\bid\b/i.test(att.filename)
        const isImage    = att.mimeType === 'image/jpeg' || att.mimeType === 'image/png'

        if (isImage && isIdentity) {
          await uploadIdentityDoc(email.id, att).catch(err =>
            console.error('Identity doc upload failed:', err),
          )
          continue
        }

        const content = await extractTextFromAttachment(att)
        if (!content) continue

        if (content.kind === 'pdf') {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: content.base64 },
          } as any)
        } else if (content.kind === 'image') {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: content.mimeType, data: content.base64 },
          })
        } else {
          blocks.push({
            type: 'text',
            text: `[Attachment: ${att.filename}]\n${content.text}`,
          })
        }
      } catch (err) {
        console.error(`Attachment processing failed [${att.filename}]:`, err)
      }
    }
  }

  blocks.push({
    type: 'text',
    text: 'Extract all structured data from the above email and attachments. Return ONLY valid JSON as specified.',
  })

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: blocks }],
  })

  const raw = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  return JSON.parse(raw.replace(/```json|```/g, '').trim())
}

// ----------------------------------------------------------------
// Step 3: write all extracted data to Supabase
// ----------------------------------------------------------------

async function writeExtracted(
  parsed: Record<string, any>,
  emailId: string,
  inboxAddress: string,
): Promise<number> {
  let tablesWritten    = 0
  let bookingId:       string | null = null
  let primaryClientId: string | null = null
  let primaryPropId:   string | null = null

  // ---- bookings ----
  if (parsed.bookings?.length) {
    for (const b of parsed.bookings) {
      try {
        const [clientId, propertyId, bookedBy] = await Promise.all([
          b.client_name ? resolveClient(b.client_name).catch(() => null) : Promise.resolve(null),
          b.hotel_name  ? resolveProperty(b.hotel_name, b.city ?? null, b.country ?? null, b.chain ?? null).catch(() => null) : Promise.resolve(null),
          resolveBookedBy(inboxAddress),
        ])
        if (!primaryClientId) primaryClientId = clientId
        if (!primaryPropId)   primaryPropId   = propertyId

        const orParts: string[] = []
        if (b.hotel_ref)   orParts.push(`hotel_ref.eq.${b.hotel_ref}`)
        if (b.amadeus_ref) orParts.push(`amadeus_ref.eq.${b.amadeus_ref}`)

        let existingId: string | null = null
        if (orParts.length > 0) {
          const { data } = await supabase.from('bookings').select('id').or(orParts.join(',')).maybeSingle()
          existingId = data?.id ?? null
        }

        const payload = {
          email_id:              emailId,
          client_id:             clientId,
          client_name:           b.client_name           ?? null,
          property_id:           propertyId,
          hotel_name:            b.hotel_name            ?? null,
          city:                  b.city                  ?? null,
          country:               b.country               ?? null,
          chain:                 b.chain                 ?? null,
          booked_by:             bookedBy,
          booked_by_name:        inboxAddress            || null,
          check_in:              b.check_in              ?? null,
          check_out:             b.check_out             ?? null,
          num_rooms:             b.num_rooms             ?? null,
          num_adults:            b.num_adults            ?? null,
          total_cost:            b.total_cost            ?? null,
          currency:              b.currency              ?? null,
          commission_rate:       b.commission_rate       ?? null,
          commission_expected:   b.commission_expected   ?? null,
          commission_channel:    b.commission_channel    ?? null,
          hotel_ref:             b.hotel_ref             ?? null,
          amadeus_ref:           b.amadeus_ref           ?? null,
          lhw_ref:               b.lhw_ref               ?? null,
          onyx_ref:              b.onyx_ref              ?? null,
          booking_source:        b.booking_source        ?? null,
          status:                b.status                ?? null,
          cancellation_deadline: b.cancellation_deadline ?? null,
          cancellation_policy:   b.cancellation_policy   ?? null,
          special_occasion:      b.special_occasion      ?? null,
          vip_flag:              b.vip_flag              ?? false,
          group_name:            b.group_name            ?? null,
          notes:                 b.notes                 ?? null,
          misc:                  b.misc                  ?? null,
        }

        if (existingId) {
          await supabase.from('bookings').update(payload).eq('id', existingId)
          if (!bookingId) bookingId = existingId
        } else {
          const { data, error } = await supabase.from('bookings').insert(payload).select('id').single()
          if (error) throw new Error(`bookings insert: ${error.message}`)
          if (!bookingId) bookingId = data?.id ?? null

          // Auto-create pending commission if commission data present and none explicitly extracted
          if (data?.id && !parsed.commissions?.length && (b.commission_rate || b.commission_expected)) {
            await supabase.from('commissions').insert({
              booking_id:      data.id,
              amount_expected: b.commission_expected ?? null,
              currency:        b.currency            ?? null,
              channel:         b.commission_channel  ?? null,
              status:          'pending',
            }).catch(err => console.error('Auto-commission insert failed:', err))
          }
        }
      } catch (err) {
        console.error('Booking write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- commissions ----
  if (parsed.commissions?.length) {
    for (const c of parsed.commissions) {
      try {
        await supabase.from('commissions').insert({
          booking_id:      bookingId,
          amount_expected: c.amount_expected ?? null,
          currency:        c.currency        ?? null,
          channel:         c.channel         ?? null,
          status:          c.status          ?? 'pending',
          date_received:   c.date_received   ?? null,
          bank_ref:        c.bank_ref         ?? null,
          notes:           c.notes           ?? null,
          misc:            c.misc            ?? null,
        })
      } catch (err) {
        console.error('Commission write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- clients ----
  if (parsed.clients?.length) {
    for (const c of parsed.clients) {
      if (!c.full_name) continue
      try {
        const { data: existing } = await supabase
          .from('clients').select('id').ilike('full_name', c.full_name).maybeSingle()
        if (existing) {
          await supabase.from('clients').update({ ...c, misc: c.misc ?? null }).eq('id', existing.id)
          if (!primaryClientId) primaryClientId = existing.id
        } else {
          const { data } = await supabase.from('clients')
            .insert({ ...c, misc: c.misc ?? null }).select('id').single()
          if (!primaryClientId) primaryClientId = data?.id ?? null
        }
      } catch (err) {
        console.error('Client write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- client_preferences ----
  if (parsed.client_preferences?.length) {
    for (const p of parsed.client_preferences) {
      if (!p.client_name) continue
      try {
        const clientId = await resolveClient(p.client_name).catch(() => null)
        if (!clientId) continue
        await supabase.from('client_preferences').insert({
          client_id:       clientId,
          category:        p.category        ?? null,
          preference:      p.preference      ?? null,
          preference_type: p.preference_type ?? null,
          notes:           p.notes           ?? null,
        })
      } catch (err) {
        console.error('Client preference write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- client_health_notes ----
  if (parsed.client_health_notes?.length) {
    for (const h of parsed.client_health_notes) {
      if (!h.client_name) continue
      try {
        const clientId = await resolveClient(h.client_name).catch(() => null)
        if (!clientId) continue
        await supabase.from('client_health_notes').insert({
          client_id:            clientId,
          condition:            h.condition            ?? null,
          details:              h.details              ?? null,
          dietary_restrictions: h.dietary_restrictions ?? [],
          mobility_notes:       h.mobility_notes       ?? null,
        })
      } catch (err) {
        console.error('Health notes write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- property_contacts ----
  if (parsed.property_contacts?.length) {
    for (const pc of parsed.property_contacts) {
      try {
        const propertyId = pc.property
          ? await resolveProperty(pc.property, null, null, null).catch(() => null)
          : null
        const payload = {
          property_id: propertyId,
          property:    pc.property   ?? null,
          name:        pc.name       ?? null,
          title:       pc.title      ?? null,
          email:       pc.email      ?? null,
          phone:       pc.phone      ?? null,
          department:  pc.department ?? null,
        }
        if (pc.email) {
          await supabase.from('property_contacts').upsert(payload, { onConflict: 'email' })
        } else {
          await supabase.from('property_contacts').insert(payload)
        }
      } catch (err) {
        console.error('Property contact write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- properties ----
  if (parsed.properties?.length) {
    for (const p of parsed.properties) {
      if (!p.name) continue
      try {
        const { data: existing } = await supabase
          .from('properties').select('id').ilike('name', p.name).maybeSingle()
        if (existing) {
          await supabase.from('properties').update(p).eq('id', existing.id)
        } else {
          await supabase.from('properties').insert(p)
        }
      } catch (err) {
        console.error('Property write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- pre_stay_tasks ----
  if (parsed.pre_stay_tasks?.length) {
    for (const t of parsed.pre_stay_tasks) {
      try {
        await supabase.from('pre_stay_tasks').insert({
          booking_id:  bookingId,
          task_type:   t.task_type   ?? null,
          description: t.description ?? null,
          due_date:    t.due_date     ?? null,
        })
      } catch (err) {
        console.error('Pre-stay task write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- air_bookings ----
  if (parsed.air_bookings?.length) {
    for (const a of parsed.air_bookings) {
      try {
        const orParts: string[] = []
        if (a.pnr)           orParts.push(`pnr.eq.${a.pnr}`)
        if (a.ticket_number) orParts.push(`ticket_number.eq.${a.ticket_number}`)

        let existingId: string | null = null
        if (orParts.length > 0) {
          const { data } = await supabase.from('air_bookings').select('id').or(orParts.join(',')).maybeSingle()
          existingId = data?.id ?? null
        }

        const payload = {
          booking_id:         bookingId,
          passenger_name:     a.passenger_name    ?? null,
          airline:            a.airline           ?? null,
          flight_number:      a.flight_number     ?? null,
          origin:             a.origin            ?? null,
          destination:        a.destination       ?? null,
          departure_datetime: a.departure_datetime ?? null,
          cabin_class:        a.cabin_class       ?? null,
          pnr:                a.pnr               ?? null,
          ticket_number:      a.ticket_number     ?? null,
          fare_inr:           a.fare_inr          ?? null,
          total_inr:          a.total_inr         ?? null,
          consolidator:       a.consolidator      ?? null,
          client_type:        a.client_type       ?? null,
          corporate_account:  a.corporate_account ?? null,
        }

        if (existingId) {
          await supabase.from('air_bookings').update(payload).eq('id', existingId)
        } else {
          await supabase.from('air_bookings').insert(payload)
        }
      } catch (err) {
        console.error('Air booking write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- airport_vip_services ----
  if (parsed.airport_vip_services?.length) {
    for (const s of parsed.airport_vip_services) {
      try {
        await supabase.from('airport_vip_services').insert({
          booking_id:   bookingId,
          airport:      s.airport      ?? null,
          airport_name: s.airport_name ?? null,
          service_type: s.service_type ?? null,
          service_date: s.service_date ?? null,
          flight_number: s.flight_number ?? null,
          pax_names:    s.pax_names    ?? [],
          provider:     s.provider     ?? null,
          status:       s.status       ?? null,
          cost:         s.cost         ?? null,
          currency:     s.currency     ?? null,
        })
      } catch (err) {
        console.error('Airport VIP service write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- enquiries (always insert — one thread may have multiple) ----
  if (parsed.enquiries?.length) {
    for (const e of parsed.enquiries) {
      try {
        await supabase.from('enquiries').insert({
          email_id:        emailId,
          client_name:     e.client_name     ?? null,
          property_name:   e.property_name   ?? null,
          destination:     e.destination     ?? null,
          check_in:        e.check_in        ?? null,
          check_out:       e.check_out       ?? null,
          num_rooms:       e.num_rooms       ?? null,
          num_adults:      e.num_adults      ?? null,
          quoted_rate:     e.quoted_rate     ?? null,
          quoted_currency: e.quoted_currency ?? null,
          notes:           e.notes           ?? null,
          misc:            e.misc            ?? null,
        })
      } catch (err) {
        console.error('Enquiry write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- visa_tracking ----
  if (parsed.visa_tracking?.length) {
    for (const v of parsed.visa_tracking) {
      if (!v.client_name) continue
      try {
        const clientId = await resolveClient(v.client_name).catch(() => null)
        await supabase.from('visa_tracking').insert({
          client_id:           clientId,
          client_name:         v.client_name         ?? null,
          destination_country: v.destination_country ?? null,
          nationality:         v.nationality         ?? null,
          visa_required:       v.visa_required        ?? null,
          visa_type:           v.visa_type            ?? null,
          visa_status:         v.visa_status          ?? null,
          application_date:    v.application_date     ?? null,
          expected_date:       v.expected_date        ?? null,
          notes:               v.notes               ?? null,
        })
      } catch (err) {
        console.error('Visa tracking write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- email_threads: link this email to every extracted record ----
  await supabase.from('email_threads').insert({
    email_id:    emailId,
    booking_id:  bookingId,
    client_id:   primaryClientId,
    property_id: primaryPropId,
  }).catch(() => {}) // table may not exist yet

  if (parsed.misc) {
    console.log(`[misc] ${emailId}:`, parsed.misc)
  }

  return tablesWritten
}

// ----------------------------------------------------------------
// Mark processed
// ----------------------------------------------------------------

async function markExtracted(emailId: string): Promise<void> {
  const { error } = await supabase
    .from('inbox_emails')
    .update({ booking_extracted: true })
    .eq('id', emailId)
  if (error) console.error('markExtracted failed:', error.message)
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

export interface ExtractionResult {
  processed: number
  tables_written: number
  errors: number
  timestamp: string
}

/**
 * Process a single email: gather content, call Sonnet, write to all tables.
 * Returns the number of tables written.
 */
export async function processEmail(
  email: {
    id: string
    subject: string
    from_email: string
    to_addresses: string[]
    email_date: string
    snippet: string
    body: string | null
    inbox_address: string
  },
  gmail: any | null,
): Promise<number> {
  const parsed = await extractFromEmail(
    {
      id:            email.id,
      subject:       email.subject,
      from:          email.from_email,
      to:            email.to_addresses ?? [],
      date:          email.email_date,
      snippet:       email.snippet,
      body:          email.body,
      inbox_address: email.inbox_address,
    },
    gmail,
  )
  if (!parsed) return 0
  return writeExtracted(parsed, email.id, email.inbox_address)
}

/**
 * Batch runner: processes up to 10 unextracted emails with a 2-second delay
 * between calls to avoid Anthropic rate limits.
 */
export async function runExtraction(): Promise<ExtractionResult> {
  const { data: emails, error: fetchError } = await supabase
    .from('inbox_emails')
    .select('id, subject, from_email, to_addresses, email_date, snippet, body, inbox_address')
    .eq('booking_extracted', false)
    .limit(10)

  if (fetchError) throw new Error(fetchError.message)

  let processed     = 0
  let tablesWritten = 0
  let errors        = 0

  for (let i = 0; i < (emails ?? []).length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000))

    const email = emails![i]
    try {
      const { data: user } = await supabase
        .from('inbox_users')
        .select('access_token, refresh_token')
        .eq('email', email.inbox_address)
        .maybeSingle()

      const gmail = user?.access_token
        ? getGmailClient(user.access_token, user.refresh_token)
        : null

      if (!gmail) {
        console.warn(`No Gmail tokens for ${email.inbox_address} — extracting from text only`)
      }

      const written = await processEmail(email, gmail)
      tablesWritten += written
      processed++
    } catch (err: any) {
      console.error('processEmail failed for', email.id, err)
      errors++
    } finally {
      await markExtracted(email.id)
    }
  }

  return { processed, tables_written: tablesWritten, errors, timestamp: new Date().toISOString() }
}
