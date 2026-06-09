// Schema-aware AI extraction agent.
// A single Sonnet call per email extracts all structured data across all tables.
// Rules-based logic, JSONB mapping, category filtering, and phrase detection are gone.

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getGmailClient } from './gmail'
import { fetchAttachments, extractTextFromAttachment, type Attachment } from './attachments'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
})

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
  try {
    await supabase.from('client_documents').insert({
      email_id:     emailId,
      filename:     att.filename,
      mime_type:    att.mimeType,
      storage_path: path,
    })
  } catch { /* table may not exist yet */ }
}

// ----------------------------------------------------------------
// Schema description (read once, cached for the process lifetime)
// ----------------------------------------------------------------

let _schemaCache: string | null = null

function getSchemaDescription(): string {
  if (_schemaCache) return _schemaCache
  try {
    _schemaCache = fs.readFileSync(
      path.join(process.cwd(), 'supabase', 'schema.sql'),
      'utf-8',
    )
  } catch {
    _schemaCache = '(schema file not found)'
  }
  return _schemaCache
}

// ----------------------------------------------------------------
// Extraction system prompt (built once, cached)
// ----------------------------------------------------------------

let _systemPromptCache: string | null = null

function getSystemPrompt(): string {
  if (_systemPromptCache) return _systemPromptCache

  _systemPromptCache = `You are the AI operations backbone for PureLuxe International (KFT Corporation, Mumbai) — a luxury travel agency managing high-value hotel bookings, client relationships, air travel, and supplier networks across the globe.

Your job: read every incoming email and extract ALL structured data, mapping it precisely to our Supabase tables. You have full access to our live database schema below. Use it to understand each table's columns, data types, and relationships before extracting.

DATABASE SCHEMA:
${getSchemaDescription()}

EXTRACTION RULES:
1. Read the email body and every attachment carefully. Extract everything relevant.
2. For each extracted record, set the correct "action":
   - "create" (default) — a new record that doesn't yet exist in our system
   - "update" — an existing record is being changed (room type, dates, rate revision, name correction, etc.)
   - "cancel" — an existing booking, flight, or service is being cancelled
3. For "update" and "cancel" actions, add a "match_on" object with the minimal fields needed to uniquely identify the existing record, e.g. {"hotel_ref": "HRC-20481"} or {"pnr": "XYZABC"} or {"amadeus_ref": "7ABCDE"}. For "create" actions, "match_on" may be omitted or left as {}.
4. Extract only what is explicitly stated in the email. Never invent, guess, or infer beyond what is written.
5. Use YYYY-MM-DD for all dates. Use null for any field not present.

Return ONLY valid JSON with this exact structure. Use null for tables where the email contains no relevant data:
{
  "bookings":             [{ "action": "create|update|cancel", "match_on": {}, ...fields }] or null,
  "commissions":          [{ "action": "create|update|cancel", "match_on": {}, ...fields }] or null,
  "clients":              [{ "action": "create|update",        "match_on": {}, ...fields }] or null,
  "client_preferences":   [{ "action": "create|update",        "match_on": {}, ...fields }] or null,
  "client_health_notes":  [{ "action": "create|update",        "match_on": {}, ...fields }] or null,
  "property_contacts":    [{ "action": "create|update",        "match_on": {}, ...fields }] or null,
  "properties":           [{ "action": "create|update",        "match_on": {}, ...fields }] or null,
  "pre_stay_tasks":       [{ "action": "create|update|cancel", "match_on": {}, ...fields }] or null,
  "air_bookings":         [{ "action": "create|update|cancel", "match_on": {}, ...fields }] or null,
  "airport_vip_services": [{ "action": "create|update|cancel", "match_on": {}, ...fields }] or null,
  "enquiries":            [{ "action": "create|update",        "match_on": {}, ...fields }] or null,
  "visa_tracking":        [{ "action": "create|update",        "match_on": {}, ...fields }] or null,
  "misc": "free-text dump for anything that doesn't map to the tables above"
}`

  return _systemPromptCache
}

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

  const callSonnet = () => client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: getSystemPrompt(),
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ] as any,
    messages: [{ role: 'user', content: blocks }],
  })

  let response: Awaited<ReturnType<typeof callSonnet>>
  try {
    response = await callSonnet()
  } catch (err: any) {
    if (err?.status === 429) {
      const retryAfter = parseInt(err?.headers?.['retry-after'] ?? '60', 10)
      console.warn(`Sonnet 429 — waiting ${retryAfter}s before retry`)
      await new Promise(r => setTimeout(r, retryAfter * 1000))
      response = await callSonnet()
    } else {
      throw err
    }
  }

  const usage = response.usage as any
  console.log('[cache]', JSON.stringify({
    input:         usage.input_tokens,
    output:        usage.output_tokens,
    cache_created: usage.cache_creation_input_tokens ?? 0,
    cache_read:    usage.cache_read_input_tokens     ?? 0,
  }))

  const raw = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  return JSON.parse(raw.replace(/```json|```/g, '').trim())
}

// ----------------------------------------------------------------
// Step 3: write all extracted data to Supabase
// ----------------------------------------------------------------

function stripMeta(obj: Record<string, any>): Record<string, any> {
  const { action: _a, match_on: _m, ...rest } = obj
  return rest
}

async function writeExtracted(
  parsed: Record<string, any>,
  emailId: string,
  inboxAddress: string,
): Promise<number> {
  console.log(`[extract] ${emailId} parsed:`, JSON.stringify(parsed, null, 2))

  let tablesWritten    = 0
  let bookingId:       string | null = null
  let primaryClientId: string | null = null
  let primaryPropId:   string | null = null

  // ---- bookings ----
  if (parsed.bookings?.length) {
    for (const b of parsed.bookings) {
      const action  = (b.action ?? 'create') as string
      const matchOn: Record<string, any> = b.match_on ?? {}
      const fields  = stripMeta(b)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            await supabase.from('bookings').update({ status: 'cancelled' }).match(matchOn)
          }
          continue
        }

        if (action === 'update') {
          if (!Object.keys(matchOn).length) continue
          const [clientId, propertyId] = await Promise.all([
            fields.client_name ? resolveClient(fields.client_name).catch(() => null) : Promise.resolve(null),
            fields.hotel_name  ? resolveProperty(fields.hotel_name, fields.city ?? null, fields.country ?? null, fields.chain ?? null).catch(() => null) : Promise.resolve(null),
          ])
          const updatePayload: Record<string, unknown> = { ...fields }
          if (clientId   !== null) updatePayload.client_id   = clientId
          if (propertyId !== null) updatePayload.property_id = propertyId
          await supabase.from('bookings').update(updatePayload).match(matchOn)
          continue
        }

        // action === 'create'
        const [clientId, propertyId, bookedBy] = await Promise.all([
          fields.client_name ? resolveClient(fields.client_name).catch(() => null) : Promise.resolve(null),
          fields.hotel_name  ? resolveProperty(fields.hotel_name, fields.city ?? null, fields.country ?? null, fields.chain ?? null).catch(() => null) : Promise.resolve(null),
          resolveBookedBy(inboxAddress),
        ])
        if (!primaryClientId) primaryClientId = clientId
        if (!primaryPropId)   primaryPropId   = propertyId

        const orParts: string[] = []
        if (fields.hotel_ref)   orParts.push(`hotel_ref.eq.${fields.hotel_ref}`)
        if (fields.amadeus_ref) orParts.push(`amadeus_ref.eq.${fields.amadeus_ref}`)

        let existingId: string | null = null
        if (orParts.length > 0) {
          const { data } = await supabase.from('bookings').select('id').or(orParts.join(',')).maybeSingle()
          existingId = data?.id ?? null
        }

        const payload = {
          email_id:              emailId,
          client_id:             clientId,
          client_name:           fields.client_name           ?? null,
          property_id:           propertyId,
          hotel_name:            fields.hotel_name            ?? null,
          city:                  fields.city                  ?? null,
          country:               fields.country               ?? null,
          chain:                 fields.chain                 ?? null,
          booked_by:             bookedBy,
          booked_by_name:        inboxAddress                 || null,
          check_in:              fields.check_in              ?? null,
          check_out:             fields.check_out             ?? null,
          num_rooms:             fields.num_rooms             ?? null,
          num_adults:            fields.num_adults            ?? null,
          total_cost:            fields.total_cost            ?? null,
          currency:              fields.currency              ?? null,
          commission_rate:       fields.commission_rate       ?? null,
          commission_expected:   fields.commission_expected   ?? null,
          commission_channel:    fields.commission_channel    ?? null,
          hotel_ref:             fields.hotel_ref             ?? null,
          amadeus_ref:           fields.amadeus_ref           ?? null,
          lhw_ref:               fields.lhw_ref               ?? null,
          onyx_ref:              fields.onyx_ref              ?? null,
          booking_source:        fields.booking_source        ?? null,
          status:                fields.status                ?? null,
          cancellation_deadline: fields.cancellation_deadline ?? null,
          cancellation_policy:   fields.cancellation_policy   ?? null,
          special_occasion:      fields.special_occasion      ?? null,
          vip_flag:              fields.vip_flag              ?? false,
          group_name:            fields.group_name            ?? null,
          notes:                 fields.notes                 ?? null,
          misc:                  fields.misc                  ?? null,
        }

        if (existingId) {
          await supabase.from('bookings').update(payload).eq('id', existingId)
          if (!bookingId) bookingId = existingId
        } else {
          const { data, error } = await supabase.from('bookings').insert(payload).select('id').single()
          if (error) throw new Error(`bookings insert: ${error.message}`)
          if (!bookingId) bookingId = data?.id ?? null

          if (data?.id && !parsed.commissions?.length && (fields.commission_rate || fields.commission_expected)) {
            try {
              await supabase.from('commissions').insert({
                booking_id:      data.id,
                amount_expected: fields.commission_expected ?? null,
                currency:        fields.currency            ?? null,
                channel:         fields.commission_channel  ?? null,
                status:          'pending',
              })
            } catch (err) {
              console.error('Auto-commission insert failed:', err)
            }
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
      const action  = (c.action ?? 'create') as string
      const matchOn: Record<string, any> = c.match_on ?? {}
      const fields  = stripMeta(c)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            await supabase.from('commissions').update({ status: 'disputed' }).match(matchOn)
          }
          continue
        }

        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('commissions').update(fields).match(matchOn)
          }
          continue
        }

        await supabase.from('commissions').insert({
          booking_id:      bookingId,
          amount_expected: fields.amount_expected ?? null,
          currency:        fields.currency        ?? null,
          channel:         fields.channel         ?? null,
          status:          fields.status          ?? 'pending',
          date_received:   fields.date_received   ?? null,
          bank_ref:        fields.bank_ref         ?? null,
          notes:           fields.notes           ?? null,
          misc:            fields.misc            ?? null,
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
      const action  = (c.action ?? 'create') as string
      const matchOn: Record<string, any> = c.match_on ?? {}
      const fields  = stripMeta(c)

      if (!fields.full_name && action === 'create') continue

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('clients').update(fields).match(matchOn)
          }
          continue
        }

        // create — deduplicate by full_name
        const { data: existing } = await supabase
          .from('clients').select('id').ilike('full_name', fields.full_name).maybeSingle()
        if (existing) {
          await supabase.from('clients').update({ ...fields, misc: fields.misc ?? null }).eq('id', existing.id)
          if (!primaryClientId) primaryClientId = existing.id
        } else {
          const { data } = await supabase.from('clients')
            .insert({ ...fields, misc: fields.misc ?? null }).select('id').single()
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
      const action  = (p.action ?? 'create') as string
      const matchOn: Record<string, any> = p.match_on ?? {}
      const fields  = stripMeta(p)

      if (!fields.client_name) continue
      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('client_preferences').update(fields).match(matchOn)
          }
          continue
        }

        const clientId = await resolveClient(fields.client_name).catch(() => null)
        if (!clientId) continue
        await supabase.from('client_preferences').insert({
          client_id:       clientId,
          category:        fields.category        ?? null,
          preference:      fields.preference      ?? null,
          preference_type: fields.preference_type ?? null,
          notes:           fields.notes           ?? null,
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
      const action  = (h.action ?? 'create') as string
      const matchOn: Record<string, any> = h.match_on ?? {}
      const fields  = stripMeta(h)

      if (!fields.client_name) continue
      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('client_health_notes').update(fields).match(matchOn)
          }
          continue
        }

        const clientId = await resolveClient(fields.client_name).catch(() => null)
        if (!clientId) continue
        await supabase.from('client_health_notes').insert({
          client_id:            clientId,
          condition:            fields.condition            ?? null,
          details:              fields.details              ?? null,
          dietary_restrictions: fields.dietary_restrictions ?? [],
          mobility_notes:       fields.mobility_notes       ?? null,
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
      const action  = (pc.action ?? 'create') as string
      const matchOn: Record<string, any> = pc.match_on ?? {}
      const fields  = stripMeta(pc)

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('property_contacts').update(fields).match(matchOn)
          }
          continue
        }

        const propertyId = fields.property
          ? await resolveProperty(fields.property, null, null, null).catch(() => null)
          : null
        const payload = {
          property_id: propertyId,
          property:    fields.property   ?? null,
          name:        fields.name       ?? null,
          title:       fields.title      ?? null,
          email:       fields.email      ?? null,
          phone:       fields.phone      ?? null,
          department:  fields.department ?? null,
        }
        if (fields.email) {
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
      const action  = (p.action ?? 'create') as string
      const matchOn: Record<string, any> = p.match_on ?? {}
      const fields  = stripMeta(p)

      if (!fields.name && action === 'create') continue
      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('properties').update(fields).match(matchOn)
          }
          continue
        }

        const { data: existing } = await supabase
          .from('properties').select('id').ilike('name', fields.name).maybeSingle()
        if (existing) {
          await supabase.from('properties').update(fields).eq('id', existing.id)
        } else {
          await supabase.from('properties').insert(fields)
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
      const action  = (t.action ?? 'create') as string
      const matchOn: Record<string, any> = t.match_on ?? {}
      const fields  = stripMeta(t)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            await supabase.from('pre_stay_tasks').update({ status: 'cancelled' }).match(matchOn)
          }
          continue
        }

        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('pre_stay_tasks').update(fields).match(matchOn)
          }
          continue
        }

        await supabase.from('pre_stay_tasks').insert({
          booking_id:  bookingId,
          task_type:   fields.task_type   ?? null,
          description: fields.description ?? null,
          due_date:    fields.due_date     ?? null,
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
      const action  = (a.action ?? 'create') as string
      const matchOn: Record<string, any> = a.match_on ?? {}
      const fields  = stripMeta(a)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            await supabase.from('air_bookings').update({ status: 'cancelled' }).match(matchOn)
          }
          continue
        }

        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('air_bookings').update(fields).match(matchOn)
          }
          continue
        }

        // create — deduplicate by PNR or ticket number
        const orParts: string[] = []
        if (fields.pnr)           orParts.push(`pnr.eq.${fields.pnr}`)
        if (fields.ticket_number) orParts.push(`ticket_number.eq.${fields.ticket_number}`)

        let existingId: string | null = null
        if (orParts.length > 0) {
          const { data } = await supabase.from('air_bookings').select('id').or(orParts.join(',')).maybeSingle()
          existingId = data?.id ?? null
        }

        const payload = {
          booking_id:         bookingId,
          passenger_name:     fields.passenger_name    ?? null,
          airline:            fields.airline           ?? null,
          flight_number:      fields.flight_number     ?? null,
          origin:             fields.origin            ?? null,
          destination:        fields.destination       ?? null,
          departure_datetime: fields.departure_datetime ?? null,
          cabin_class:        fields.cabin_class       ?? null,
          pnr:                fields.pnr               ?? null,
          ticket_number:      fields.ticket_number     ?? null,
          fare_inr:           fields.fare_inr          ?? null,
          total_inr:          fields.total_inr         ?? null,
          consolidator:       fields.consolidator      ?? null,
          client_type:        fields.client_type       ?? null,
          corporate_account:  fields.corporate_account ?? null,
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
      const action  = (s.action ?? 'create') as string
      const matchOn: Record<string, any> = s.match_on ?? {}
      const fields  = stripMeta(s)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            await supabase.from('airport_vip_services').update({ status: 'cancelled' }).match(matchOn)
          }
          continue
        }

        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('airport_vip_services').update(fields).match(matchOn)
          }
          continue
        }

        await supabase.from('airport_vip_services').insert({
          booking_id:    bookingId,
          airport:       fields.airport      ?? null,
          airport_name:  fields.airport_name ?? null,
          service_type:  fields.service_type ?? null,
          service_date:  fields.service_date ?? null,
          flight_number: fields.flight_number ?? null,
          pax_names:     fields.pax_names    ?? [],
          provider:      fields.provider     ?? null,
          status:        fields.status       ?? null,
          cost:          fields.cost         ?? null,
          currency:      fields.currency     ?? null,
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
      const action  = (e.action ?? 'create') as string
      const matchOn: Record<string, any> = e.match_on ?? {}
      const fields  = stripMeta(e)

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('enquiries').update(fields).match(matchOn)
          }
          continue
        }

        await supabase.from('enquiries').insert({
          email_id:        emailId,
          client_name:     fields.client_name     ?? null,
          property_name:   fields.property_name   ?? null,
          destination:     fields.destination     ?? null,
          check_in:        fields.check_in        ?? null,
          check_out:       fields.check_out       ?? null,
          num_rooms:       fields.num_rooms       ?? null,
          num_adults:      fields.num_adults      ?? null,
          quoted_rate:     fields.quoted_rate     ?? null,
          quoted_currency: fields.quoted_currency ?? null,
          notes:           fields.notes           ?? null,
          misc:            fields.misc            ?? null,
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
      const action  = (v.action ?? 'create') as string
      const matchOn: Record<string, any> = v.match_on ?? {}
      const fields  = stripMeta(v)

      if (!fields.client_name && action === 'create') continue
      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            await supabase.from('visa_tracking').update(fields).match(matchOn)
          }
          continue
        }

        const clientId = await resolveClient(fields.client_name).catch(() => null)
        await supabase.from('visa_tracking').insert({
          client_id:           clientId,
          client_name:         fields.client_name         ?? null,
          destination_country: fields.destination_country ?? null,
          nationality:         fields.nationality         ?? null,
          visa_required:       fields.visa_required        ?? null,
          visa_type:           fields.visa_type            ?? null,
          visa_status:         fields.visa_status          ?? null,
          application_date:    fields.application_date     ?? null,
          expected_date:       fields.expected_date        ?? null,
          notes:               fields.notes               ?? null,
        })
      } catch (err) {
        console.error('Visa tracking write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- email_threads: link this email to every extracted record ----
  try {
    await supabase.from('email_threads').insert({
      email_id:    emailId,
      booking_id:  bookingId,
      client_id:   primaryClientId,
      property_id: primaryPropId,
    })
  } catch { /* table may not exist yet */ }

  if (parsed.misc) {
    console.log(`[misc] ${emailId}:`, parsed.misc)
  }

  return tablesWritten
}

// ----------------------------------------------------------------
// Stage 1: free hard filter — no API call
// ----------------------------------------------------------------

const NOISE_SENDER_FRAGMENTS = [
  'noreply', 'no-reply', 'donotreply', 'newsletter', 'marketing',
  'notifications', 'updates@', 'alerts@',
]

const NOISE_DOMAINS = [
  '@klm-mail.com', '@nexusdmc.com', '@tourishdmc.com', '@collezioneem.com',
  '@travellermade.com', '@ethiopianairlines.com', '@aviareps.com',
]

const NOISE_SUBJECT_PHRASES = [
  'unsubscribe', 'newsletter', 'vote for', 'last chance to vote',
  'promotional', 'special offer', 'fixed departures', 'b2b packages',
]

function isStage1Noise(fromEmail: string, subject: string): boolean {
  const from = fromEmail.toLowerCase()
  const sub  = subject.toLowerCase()
  return (
    NOISE_SENDER_FRAGMENTS.some(f => from.includes(f)) ||
    NOISE_DOMAINS.some(d => from.endsWith(d)) ||
    NOISE_SUBJECT_PHRASES.some(p => sub.includes(p))
  )
}

// ----------------------------------------------------------------
// Stage 2: Haiku noise gate — cheap single-token answer
// ----------------------------------------------------------------

async function isStage2Noise(subject: string, snippet: string): Promise<boolean> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    messages: [{
      role: 'user',
      content:
        `Is this email clearly a newsletter, marketing promotion, trade circular, ` +
        `automated notification, or social media digest with no actionable travel ` +
        `business content? Reply with only YES or NO. When in doubt, reply NO.\n\n` +
        `Subject: ${subject}\nSnippet: ${snippet}`,
    }],
  })
  const answer = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim()
    .toUpperCase()
  return answer.startsWith('YES')
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
 * Process a single email through two noise filters then Sonnet extraction.
 * Stage 1: free hard filter on sender/subject patterns.
 * Stage 2: Haiku single-token noise gate on subject + snippet.
 * Stage 3: full Sonnet extraction.
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
  // Stage 1 — free hard filter
  if (isStage1Noise(email.from_email, email.subject)) {
    console.log(`[filter] stage1_skip ${email.id}`)
    await markExtracted(email.id)
    return 0
  }

  // Stage 2 — Haiku noise gate
  const noise = await isStage2Noise(email.subject, email.snippet).catch(() => false)
  if (noise) {
    console.log(`[filter] haiku_skip ${email.id}`)
    await markExtracted(email.id)
    return 0
  }

  console.log(`[filter] sonnet_process ${email.id}`)

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
 * Batch runner: fetches up to 5 unextracted emails and runs them through
 * stage-1 hard filter → stage-2 Haiku gate → stage-3 Sonnet extraction.
 */
export async function runExtraction(): Promise<ExtractionResult> {
  const { data: emails, error } = await supabase
    .from('inbox_emails')
    .select('id, subject, from_email, to_addresses, email_date, snippet, body, inbox_address')
    .eq('booking_extracted', false)
    .limit(5)

  if (error) throw new Error(error.message)

  let processed     = 0
  let tablesWritten = 0
  let errors        = 0

  for (let i = 0; i < (emails ?? []).length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000))

    const email = emails![i]
    let skipMark = false
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
      if (err?.status === 429) {
        console.warn(`Persistent 429 for ${email.id} — leaving unextracted for next run`)
        skipMark = true
      }
    } finally {
      if (!skipMark) await markExtracted(email.id)
    }
  }

  return { processed, tables_written: tablesWritten, errors, timestamp: new Date().toISOString() }
}
