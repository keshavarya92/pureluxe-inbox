// Schema-aware AI extraction agent.
// A single Sonnet call per email extracts all structured data across all tables.
// Rules-based logic, JSONB mapping, category filtering, and phrase detection are gone.

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getGmailClient } from './gmail'
import { fetchAttachments, extractTextFromAttachment, type Attachment } from './attachments'
import { resolveClient, resolveBooking, type ClientInput, type BookingInput } from './resolvers'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

// ----------------------------------------------------------------
// KFT team exclusion lists — used by guest name extractor
// ----------------------------------------------------------------

const KFT_TEAM_EMAILS = [
  'keshav@kft.travel', 'sanjay@kft.travel', 'shilpa@kft.travel',
  'sonali@kft.travel', 'operations@kft.travel', 'holidays@kft.travel',
  'tours@kft.travel', 'international@kft.travel', 'bindu@kft.travel',
  'vacations@kft.travel', 'atul@kft.travel',
]

const KFT_TEAM_NAMES = [
  'keshav', 'sanjay', 'shilpa', 'sonali', 'shreya', 'priya',
  'suchita', 'ria', 'shraddha', 'sudarshan', 'atul', 'bindu',
  'sonali shah', 'shreya agarwal', 'ria shah', 'suchita jain',
]

// Hotel staff patterns to exclude — generic roles
const STAFF_ROLE_PATTERNS = [
  /\b(manager|director|coordinator|concierge|reservations|sales|front\s*desk|receptionist)\b/i,
]

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
})

// ----------------------------------------------------------------
// Relationship resolution
// ----------------------------------------------------------------

// resolveClient and resolveBooking are imported from lib/resolvers.ts.
// These helpers map raw LLM output fields to the typed resolver interfaces.

function buildClientInput(fields: Record<string, any>): ClientInput {
  return {
    full_name:         String(fields.full_name ?? ''),
    email:             fields.email             ?? null,
    phone:             fields.phone             ?? null,
    whatsapp:          fields.whatsapp          ?? null,
    title:             fields.title             ?? null,
    first_name:        fields.first_name        ?? null,
    last_name:         fields.last_name         ?? null,
    nationality:       fields.nationality       ?? null,
    city_of_residence: fields.city_of_residence ?? null,
    vip_level:         fields.vip_level         ?? null,
    company:           fields.company           ?? null,
    loyalty_programs:  Array.isArray(fields.loyalty_programs) ? fields.loyalty_programs : null,
    birthday:          fields.birthday          ?? null,
    anniversary:       fields.anniversary       ?? null,
    general_notes:     fields.general_notes     ?? null,
    internal_notes:    fields.internal_notes    ?? null,
    misc:              fields.misc              ?? null,
  }
}

function buildBookingInput(
  fields:       Record<string, any>,
  clientId:     string,
  propId:       string | null,
  emailId:      string,
  inboxAddress: string,
  bookedBy:     string | null,
  threadId:     string,
): BookingInput {
  return {
    client_id:             clientId,
    check_in:              fields.check_in  ?? '',
    check_out:             fields.check_out ?? '',
    property_id:           propId,
    hotel_ref:             fields.hotel_ref   ?? null,
    amadeus_ref:           fields.amadeus_ref ?? null,
    lhw_ref:               fields.lhw_ref     ?? null,
    ottila_ref:            fields.ottila_ref  ?? null,
    onyx_ref:              fields.onyx_ref    ?? null,
    email_id:              emailId,
    source_thread_id:      threadId || null,
    client_name:           fields.client_name           ?? null,
    hotel_name:            fields.hotel_name            ?? null,
    city:                  fields.city                  ?? null,
    country:               fields.country               ?? null,
    chain:                 fields.chain                 ?? null,
    booked_by:             bookedBy,
    booked_by_name:        inboxAddress                 || null,
    num_rooms:             fields.num_rooms             ?? null,
    num_adults:            fields.num_adults            ?? null,
    total_cost:            fields.total_cost            ?? null,
    currency:              fields.currency              ?? null,
    commission_rate:       fields.commission_rate       ?? null,
    commission_expected:   fields.commission_expected   ?? null,
    commission_channel:    fields.commission_channel    ?? null,
    commissionable:        fields.commissionable        ?? null,
    booking_source:        fields.booking_source        ?? null,
    booking_channel:       fields.booking_channel       ?? null,
    status:                fields.status                ?? null,
    cancellation_deadline: fields.cancellation_deadline ?? null,
    cancellation_policy:   fields.cancellation_policy   ?? null,
    special_occasion:      fields.special_occasion      ?? null,
    vip_flag:              fields.vip_flag              ?? false,
    group_name:            fields.group_name            ?? null,
    notes:                 fields.notes                 ?? null,
    misc:                  fields.misc                  ?? null,
  }
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

export function getSystemPrompt(): string {
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
// Tiered processing classifier
// ----------------------------------------------------------------

const TIER3_SENDER_KEYWORDS = ['reservations', 'res.', 'confirmation', 'booking']

const HIGH_VALUE_ATTACHMENT_KEYWORDS = [
  'confirmation', 'voucher', 'booking', 'passport', 'visa',
  'invoice', 'contract', 'agreement', 'itinerary',
]

// Walk a Gmail message payload tree and collect all attachment filenames.
// Works on the response from messages.get({ format: 'full' }) — no separate
// attachment downloads needed since large attachments are referenced by attachmentId.
// Walk a Gmail message payload tree and collect attachment filenames (no attachment data downloaded).
export function collectPartFilenames(payload: any): string[] {
  const names: string[] = []
  if (payload?.filename?.length) names.push(payload.filename.toLowerCase())
  for (const child of payload?.parts ?? []) names.push(...collectPartFilenames(child))
  return names
}

// Returns 2 (text-only) or 3 (full attachment processing).
// Tier 1 is handled upstream by the Stage 1/2 noise filters before this is called.
export function classifyEmailTier(fromEmail: string, attachmentFilenames: string[]): 2 | 3 {
  const from = fromEmail.toLowerCase()
  if (TIER3_SENDER_KEYWORDS.some(k => from.includes(k))) return 3
  if (attachmentFilenames.some(fn => HIGH_VALUE_ATTACHMENT_KEYWORDS.some(kw => fn.includes(kw)))) return 3
  return 2
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

  // Fetch attachment filenames for tier classification (lightweight — no attachment data yet)
  let attachmentFilenames: string[] = []
  if (gmail) {
    try {
      const meta = await gmail.users.messages.get({ userId: 'me', id: email.id, format: 'full' })
      attachmentFilenames = collectPartFilenames(meta.data.payload ?? {})
    } catch { /* ignore — default to tier 2 */ }
  }

  const tier = classifyEmailTier(email.from, attachmentFilenames)
  console.log(`[tier] ${tier === 3 ? '3_with_attachments' : '2_text_only'} ${email.id}`)

  if (tier === 3 && gmail) {
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
    max_tokens: 8192,
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

/**
 * Returns true if a section should run.
 * activeSections = undefined → all sections run (GDS / untagged-but-processed paths).
 * activeSections = Set        → only named sections run (tag-filtered path).
 */
function sec(name: string, activeSections: Set<string> | undefined): boolean {
  return activeSections === undefined || activeSections.has(name)
}

// ----------------------------------------------------------------
// Guest name extractor — finds additional traveller names in the
// email body and resolves them as client records.
// ----------------------------------------------------------------

async function extractAndResolveGuests(
  emailBody: string,
  leadClientId: string,
): Promise<string[]> {
  const guestIds = new Set<string>()

  const patterns = [
    // "Mr/Mrs/Ms/Dr/Prof Firstname Lastname [Lastname2]" — single line only
    /\b(?:Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.?|Prof\.?)[^\S\n]+([A-Z][a-z]+(?:[^\S\n]+[A-Z][a-z]+){1,3})/g,
    // "Firstname Lastname & Firstname Lastname" — both names must be on the same line
    /\b([A-Z][a-z]+(?:[^\S\n]+[A-Z][a-z]+){1,2})[^\S\n]*&[^\S\n]*([A-Z][a-z]+(?:[^\S\n]+[A-Z][a-z]+){1,2})/g,
  ]

  const candidateNames: string[] = []
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    pattern.lastIndex = 0
    while ((match = pattern.exec(emailBody)) !== null) {
      for (let i = 1; i < match.length; i++) {
        if (match[i]) candidateNames.push(match[i].trim())
      }
    }
  }

  const uniqueNames = [...new Set(candidateNames)]

  for (const name of uniqueNames) {
    const nameLower = name.toLowerCase()

    // Skip KFT team members
    if (KFT_TEAM_NAMES.some(n => nameLower.includes(n))) continue

    // Skip single-word names
    if (name.split(/\s+/).length < 2) continue

    // Skip hotel staff role names
    if (STAFF_ROLE_PATTERNS.some(p => p.test(name))) continue

    try {
      const clientId = await resolveClient({ full_name: name })
      if (clientId !== leadClientId) guestIds.add(clientId)
    } catch (err) {
      console.warn(`[extract] guest resolve failed for "${name}":`, err)
    }
  }

  return [...guestIds]
}

export async function writeExtracted(
  parsed:          Record<string, any>,
  emailId:         string,
  inboxAddress:    string,
  threadId:        string,
  activeSections?: Set<string>,
  emailBody?:      string | null,
  emailDate?:      string | null,
): Promise<number> {
  if (!threadId) {
    console.error(`[extract] writeExtracted called without threadId for email ${emailId} — bookings will lack source_thread_id, dedup constraint inactive`)
  }
  console.log(`[extract] ${emailId} parsed:`, JSON.stringify(parsed, null, 2))

  // Bookings from today onward enter the queue as pending_review.
  // Legacy data (pre-cutoff) and existing confirmed records are untouched.
  const QUEUE_CUTOFF = new Date('2026-06-27')
  const isPendingReview = emailDate
    ? new Date(emailDate) >= QUEUE_CUTOFF
    : false

  let tablesWritten = 0
  let primaryPropId: string | null = null

  // ---- Pre-flight: resolve primary client (must complete before any section write) ----
  // Resolvers run regardless of activeSections — client_id / booking_id are foreign keys
  // needed even when only a subset of sections is active.
  let primaryClientId: string | null = null
  const firstClientRec     = parsed.clients?.find((c: any) => (c.action ?? 'create') !== 'cancel') as Record<string, any> | undefined
  const firstCreateBooking = parsed.bookings?.find((b: any) => (b.action ?? 'create') === 'create') as Record<string, any> | undefined
  {
    const bSrc = firstCreateBooking ? stripMeta(firstCreateBooking) : null
    const clientSrc: Record<string, any> | null = firstClientRec
      ? stripMeta(firstClientRec)
      : bSrc?.client_name
        ? { full_name: bSrc.client_name }
        : null
    if (clientSrc?.full_name) {
      try {
        primaryClientId = await resolveClient(buildClientInput(clientSrc))
      } catch (err) {
        console.error(`[extract] resolveClient failed ${emailId}:`, err)
        return 0
      }
    }
  }

  // ---- Pre-flight: resolve primary booking (after client, before booking-dependent sections) ----
  let bookingId: string | null = null
  if (firstCreateBooking && primaryClientId) {
    const bFields = stripMeta(firstCreateBooking)
    if (bFields.check_in && bFields.check_out) {
      const bHasRef = !!(bFields.hotel_ref || bFields.amadeus_ref || bFields.lhw_ref || bFields.ottila_ref || bFields.onyx_ref)
      if (!bHasRef) {
        console.log(`[extract] booking has no ref — routed to enquiries instead of bookings`)
        const destination = [bFields.city, bFields.country].filter(Boolean).join(', ') || null
        const prefEnqPayload = {
          client_id:       primaryClientId,
          client_name:     bFields.client_name   ?? null,
          property_name:   bFields.hotel_name    ?? null,
          destination,
          check_in:        bFields.check_in      ?? null,
          check_out:       bFields.check_out     ?? null,
          num_rooms:       bFields.num_rooms     ?? null,
          num_adults:      bFields.num_adults    ?? null,
          quoted_rate:     bFields.total_cost    ?? null,
          quoted_currency: bFields.currency      ?? null,
          notes:           bFields.notes         ?? null,
          misc:            bFields.misc          ?? null,
        }
        const { error: prefEnqErr } = await supabase.from('enquiries').insert(prefEnqPayload)
        if (prefEnqErr) console.error('[write] enquiries (routed from booking, no ref) insert error:', prefEnqErr.message, JSON.stringify(prefEnqPayload))
      } else {
        const propId = bFields.hotel_name
          ? await resolveProperty(bFields.hotel_name, bFields.city ?? null, bFields.country ?? null, bFields.chain ?? null).catch(() => null)
          : null
        primaryPropId = propId
        const bookedBy = await resolveBookedBy(inboxAddress)
        try {
          const primaryBookingInput = buildBookingInput(bFields, primaryClientId, propId, emailId, inboxAddress, bookedBy, threadId)
          const resolved = await resolveBooking(primaryBookingInput, isPendingReview)
          bookingId = resolved.bookingId
          console.log(`[extract] resolved client_id=${primaryClientId} booking_id=${bookingId} action=${resolved.action}`)
          if (resolved.action === 'inserted' && !parsed.commissions?.length
              && (bFields.commission_rate || bFields.commission_expected)) {
            try {
              const { error: autoCommPreflightErr } = await supabase.from('commissions').insert({
                booking_id:      bookingId,
                amount_expected: bFields.commission_expected ?? null,
                currency:        bFields.currency           ?? null,
                channel:         bFields.commission_channel ?? null,
                status:          'pending',
              })
              if (autoCommPreflightErr) console.error('[write] commissions auto-insert (pre-flight) error:', autoCommPreflightErr.message)
              else console.log(`[write] commissions auto-insert booking_id=${bookingId}`)
            } catch (e) {
              console.error('Auto-commission (pre-flight) failed:', e)
            }
          }
        } catch (err) {
          console.error(`[extract] resolveBooking failed ${emailId}:`, err)
          return 0
        }
      }
    }
  }

  // ---- guest name extraction (non-blocking) ----
  if (bookingId && primaryClientId && emailBody) {
    try {
      const guestIds = await extractAndResolveGuests(emailBody, primaryClientId)
      if (guestIds.length > 0) {
        const { data: existing } = await supabase
          .from('bookings')
          .select('additional_guest_ids')
          .eq('id', bookingId)
          .single()
        const currentIds: string[] = existing?.additional_guest_ids ?? []
        const merged = [...new Set([...currentIds, ...guestIds])]
        if (merged.length > currentIds.length) {
          const { error: guestUpdateErr } = await supabase
            .from('bookings')
            .update({ additional_guest_ids: merged })
            .eq('id', bookingId)
          if (guestUpdateErr) console.error('[extract] additional_guest_ids update error:', guestUpdateErr.message)
          else console.log(`[extract] booking ${bookingId} — added ${merged.length - currentIds.length} guest(s): ${guestIds.join(', ')}`)
        }
      }
    } catch (err) {
      console.warn(`[extract] guest extraction failed for booking ${bookingId}:`, err)
    }
  }

  // ---- bookings ----
  if (sec('bookings', activeSections) && parsed.bookings?.length) {
    for (const b of parsed.bookings) {
      const action  = (b.action ?? 'create') as string
      const matchOn: Record<string, any> = b.match_on ?? {}
      const fields  = stripMeta(b)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            console.log(`[write] bookings cancel`, JSON.stringify(matchOn))
            const { error: cancelErr } = await supabase.from('bookings').update({ status: 'cancelled' }).match(matchOn)
            if (cancelErr) console.error(`[write] bookings cancel error`, cancelErr.message)
            if (!bookingId) {
              const { data: found } = await supabase.from('bookings').select('id').match(matchOn).maybeSingle()
              if (found) bookingId = found.id
              else console.log(`[write] bookings cancel — no matching row for`, JSON.stringify(matchOn))
            }
          }
          continue
        }

        if (action === 'update') {
          if (!Object.keys(matchOn).length) continue
          const [clientId, propertyId] = await Promise.all([
            fields.client_name ? resolveClient({ full_name: fields.client_name }).catch(() => null) : Promise.resolve(null),
            fields.hotel_name  ? resolveProperty(fields.hotel_name, fields.city ?? null, fields.country ?? null, fields.chain ?? null).catch(() => null) : Promise.resolve(null),
          ])
          const updatePayload: Record<string, unknown> = { ...fields }
          // Strip generated/computed columns that cannot be set directly
          delete updatePayload.nights
          if (clientId   !== null) updatePayload.client_id   = clientId
          if (propertyId !== null) updatePayload.property_id = propertyId
          const { error: bookingUpdateErr } = await supabase.from('bookings').update(updatePayload).match(matchOn)
          if (bookingUpdateErr) console.error('[write] bookings update error:', bookingUpdateErr.message, JSON.stringify(matchOn))
          const { data: found } = await supabase.from('bookings').select('id').match(matchOn).maybeSingle()
          if (found) {
            if (!bookingId) bookingId = found.id
            continue
          }
          // Orphaned update — matchOn found no existing row; insert as new booking
          const orphanClientId = clientId ?? primaryClientId
          if (!orphanClientId || !fields.check_in || !fields.check_out) {
            console.warn(`[write] bookings orphaned update — missing client_id or dates, skipping`, JSON.stringify(matchOn))
            continue
          }
          const bookedBy = await resolveBookedBy(inboxAddress)
          const orphanInput = buildBookingInput(fields, orphanClientId, propertyId, emailId, inboxAddress, bookedBy, threadId)
          const orphanResolved = await resolveBooking(orphanInput, isPendingReview)
          if (!bookingId) bookingId = orphanResolved.bookingId
          console.log(`[write] bookings orphaned update → inserted id=${orphanResolved.bookingId}`)
          continue
        }

        // create — resolved by pre-flight resolveBooking for the primary booking.
        // For additional bookings in multi-hotel itineraries, resolve here.
        if (b === firstCreateBooking && bookingId) {
          // Primary booking already resolved in pre-flight; bookingId is captured.
        } else {
          const propId = fields.hotel_name
            ? await resolveProperty(fields.hotel_name, fields.city ?? null, fields.country ?? null, fields.chain ?? null).catch(() => null)
            : null
          if (!primaryPropId) primaryPropId = propId

          let bClientId = primaryClientId
          if (!bClientId && fields.client_name) {
            bClientId = await resolveClient({ full_name: fields.client_name }).catch(() => null)
          }
          if (!bClientId || !fields.check_in || !fields.check_out) {
            console.log(`[write] bookings create — missing client_id or dates, skipping`)
            continue
          }

          const addlHasRef = !!(fields.hotel_ref || fields.amadeus_ref || fields.lhw_ref || fields.ottila_ref || fields.onyx_ref)
          if (!addlHasRef) {
            console.log(`[extract] booking has no ref — routed to enquiries instead of bookings`)
            const destination = [fields.city, fields.country].filter(Boolean).join(', ') || null
            const addlEnqPayload = {
              client_id:       bClientId,
              client_name:     fields.client_name   ?? null,
              property_name:   fields.hotel_name    ?? null,
              destination,
              check_in:        fields.check_in      ?? null,
              check_out:       fields.check_out     ?? null,
              num_rooms:       fields.num_rooms     ?? null,
              num_adults:      fields.num_adults    ?? null,
              quoted_rate:     fields.total_cost    ?? null,
              quoted_currency: fields.currency      ?? null,
              notes:           fields.notes         ?? null,
              misc:            fields.misc          ?? null,
            }
            const { error: addlEnqErr } = await supabase.from('enquiries').insert(addlEnqPayload)
            if (addlEnqErr) console.error('[write] enquiries (routed from additional booking, no ref) insert error:', addlEnqErr.message, JSON.stringify(addlEnqPayload))
            continue
          }

          const bookedBy    = await resolveBookedBy(inboxAddress)
          const addlBookingInput = buildBookingInput(fields, bClientId, propId, emailId, inboxAddress, bookedBy, threadId)
          const addlResolved = await resolveBooking(addlBookingInput, isPendingReview)
          if (!bookingId) bookingId = addlResolved.bookingId
          console.log(`[write] bookings additional booking_id=${addlResolved.bookingId} action=${addlResolved.action}`)

          if (addlResolved.action === 'inserted' && !parsed.commissions?.length
              && (fields.commission_rate || fields.commission_expected)) {
            try {
            const { error: autoCommAddlErr } = await supabase.from('commissions').insert({
              booking_id:      addlResolved.bookingId,
              amount_expected: fields.commission_expected ?? null,
              currency:        fields.currency           ?? null,
              channel:         fields.commission_channel ?? null,
              status:          'pending',
            })
            if (autoCommAddlErr) console.error('[write] commissions auto-insert (additional) error:', autoCommAddlErr.message)
            else console.log(`[write] commissions auto-insert booking_id=${addlResolved.bookingId}`)
          } catch (e) {
            console.error('Auto-commission (additional) failed:', e)
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
  if (sec('commissions', activeSections) && parsed.commissions?.length) {
    for (const c of parsed.commissions) {
      const action  = (c.action ?? 'create') as string
      const matchOn: Record<string, any> = c.match_on ?? {}
      const fields  = stripMeta(c)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            const { error: commCancelErr } = await supabase.from('commissions').update({ status: 'disputed' }).match(matchOn)
            if (commCancelErr) console.error('[write] commissions cancel error:', commCancelErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: commUpdateErr } = await supabase.from('commissions').update(fields).match(matchOn)
            if (commUpdateErr) console.error('[write] commissions update error:', commUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        const commPayload = { booking_id: bookingId, amount_expected: fields.amount_expected ?? null, currency: fields.currency ?? null, channel: fields.channel ?? null, status: fields.status ?? 'pending', date_received: fields.date_received ?? null, bank_ref: fields.bank_ref ?? null, notes: fields.notes ?? null, misc: fields.misc ?? null }
        console.log(`[write] commissions insert`, JSON.stringify(commPayload))
        const { error: commInsertErr } = await supabase.from('commissions').insert(commPayload)
        if (commInsertErr) console.error('[write] commissions insert error:', commInsertErr.message, JSON.stringify(commPayload))
      } catch (err) {
        console.error('Commission write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- clients ----
  if (sec('clients', activeSections) && parsed.clients?.length) {
    for (const c of parsed.clients) {
      const action  = (c.action ?? 'create') as string
      const matchOn: Record<string, any> = c.match_on ?? {}
      const fields  = stripMeta(c)

      if (!fields.full_name && action === 'create') continue

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: clientUpdateErr } = await supabase.from('clients').update(fields).match(matchOn)
            if (clientUpdateErr) console.error('[write] clients update error:', clientUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        // create — resolved by pre-flight resolveClient for the primary client.
        // Secondary clients (rare in PureLuxe emails) are resolved here.
        if (c !== firstClientRec && fields.full_name) {
          const secId = await resolveClient(buildClientInput(fields)).catch((err: any) => {
            console.error(`[extract] resolveClient (secondary) failed:`, err)
            return null
          })
          if (secId) console.log(`[write] clients secondary resolved id=${secId}`)
        }
      } catch (err) {
        console.error('Client write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- client_preferences ----
  if (sec('client_preferences', activeSections) && parsed.client_preferences?.length) {
    for (const p of parsed.client_preferences) {
      const action  = (p.action ?? 'create') as string
      const matchOn: Record<string, any> = p.match_on ?? {}
      const fields  = stripMeta(p)

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: prefUpdateErr } = await supabase.from('client_preferences').update(fields).match(matchOn)
            if (prefUpdateErr) console.error('[write] client_preferences update error:', prefUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        const clientId = primaryClientId
          ?? (fields.client_name ? await resolveClient({ full_name: fields.client_name }).catch(() => null) : null)
        if (!clientId) {
          console.log(`[write] client_preferences skip — no client_id resolved`, JSON.stringify(fields))
          continue
        }
        const prefPayload = { client_id: clientId, category: fields.category ?? null, preference: fields.preference ?? null, preference_type: fields.preference_type ?? null, notes: fields.notes ?? null }
        console.log(`[write] client_preferences insert`, JSON.stringify(prefPayload))
        const { error: prefInsertErr } = await supabase.from('client_preferences').insert(prefPayload)
        if (prefInsertErr) console.error('[write] client_preferences insert error:', prefInsertErr.message, JSON.stringify(prefPayload))
      } catch (err) {
        console.error('Client preference write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- client_health_notes ----
  if (sec('client_health_notes', activeSections) && parsed.client_health_notes?.length) {
    for (const h of parsed.client_health_notes) {
      const action  = (h.action ?? 'create') as string
      const matchOn: Record<string, any> = h.match_on ?? {}
      const fields  = stripMeta(h)

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: healthUpdateErr } = await supabase.from('client_health_notes').update(fields).match(matchOn)
            if (healthUpdateErr) console.error('[write] client_health_notes update error:', healthUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        const clientId = primaryClientId
          ?? (fields.client_name ? await resolveClient({ full_name: fields.client_name }).catch(() => null) : null)
        if (!clientId) {
          console.log(`[write] client_health_notes skip — no client_id resolved`, JSON.stringify(fields))
          continue
        }
        const healthPayload = { client_id: clientId, condition: fields.condition ?? null, details: fields.details ?? null, dietary_restrictions: fields.dietary_restrictions ?? [], mobility_notes: fields.mobility_notes ?? null }
        console.log(`[write] client_health_notes insert`, JSON.stringify(healthPayload))
        const { error: healthInsertErr } = await supabase.from('client_health_notes').insert(healthPayload)
        if (healthInsertErr) console.error('[write] client_health_notes insert error:', healthInsertErr.message, JSON.stringify(healthPayload))
      } catch (err) {
        console.error('Health notes write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- property_contacts ----
  if (sec('property_contacts', activeSections) && parsed.property_contacts?.length) {
    for (const pc of parsed.property_contacts) {
      const action  = (pc.action ?? 'create') as string
      const matchOn: Record<string, any> = pc.match_on ?? {}
      const fields  = stripMeta(pc)

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            console.log(`[write] property_contacts update`, JSON.stringify({ match: matchOn, ...fields }))
            const { error: pcUpdateErr } = await supabase.from('property_contacts').update(fields).match(matchOn)
            if (pcUpdateErr) console.error('[write] property_contacts update error:', pcUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        const propertyId = fields.property
          ? await resolveProperty(fields.property, null, null, null).catch(() => null)
          : null
        if (!propertyId) {
          console.log(`[write] property_contacts skip — could not resolve property_id for "${fields.property ?? '(null)'}"`)
          continue
        }
        const payload = {
          property_id: propertyId,
          name:        fields.name       ?? null,
          title:       fields.title      ?? null,
          email:       fields.email      ?? null,
          phone:       fields.phone      ?? null,
          department:  fields.department ?? null,
        }
        if (fields.email) {
          console.log(`[write] property_contacts upsert`, JSON.stringify(payload))
          const { error: pcUpsertErr } = await supabase.from('property_contacts').upsert(payload, { onConflict: 'email' })
          if (pcUpsertErr) console.error('[write] property_contacts upsert error:', pcUpsertErr.message, JSON.stringify(payload))
        } else {
          console.log(`[write] property_contacts insert`, JSON.stringify(payload))
          const { error: pcInsertErr } = await supabase.from('property_contacts').insert(payload)
          if (pcInsertErr) console.error('[write] property_contacts insert error:', pcInsertErr.message, JSON.stringify(payload))
        }
      } catch (err) {
        console.error('Property contact write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- properties ----
  if (sec('properties', activeSections) && parsed.properties?.length) {
    for (const p of parsed.properties) {
      const action  = (p.action ?? 'create') as string
      const matchOn: Record<string, any> = p.match_on ?? {}
      const fields  = stripMeta(p)

      if (!fields.name && action === 'create') continue
      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: propUpdateErr } = await supabase.from('properties').update(fields).match(matchOn)
            if (propUpdateErr) console.error('[write] properties update error:', propUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        const { data: existing } = await supabase
          .from('properties').select('id').ilike('name', fields.name).maybeSingle()
        if (existing) {
          console.log(`[write] properties update id=${existing.id}`, JSON.stringify(fields))
          const { error: propUpdateByIdErr } = await supabase.from('properties').update(fields).eq('id', existing.id)
          if (propUpdateByIdErr) console.error('[write] properties update error:', propUpdateByIdErr.message, JSON.stringify(fields))
        } else {
          console.log(`[write] properties insert`, JSON.stringify(fields))
          const { error: propInsertErr } = await supabase.from('properties').insert(fields)
          if (propInsertErr) console.error('[write] properties insert error:', propInsertErr.message, JSON.stringify(fields))
        }
      } catch (err) {
        console.error('Property write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- pre_stay_tasks ----
  if (sec('pre_stay_tasks', activeSections) && parsed.pre_stay_tasks?.length) {
    for (const t of parsed.pre_stay_tasks) {
      const action  = (t.action ?? 'create') as string
      const matchOn: Record<string, any> = t.match_on ?? {}
      const fields  = stripMeta(t)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            const { error: taskCancelErr } = await supabase.from('pre_stay_tasks').update({ status: 'cancelled' }).match(matchOn)
            if (taskCancelErr) console.error('[write] pre_stay_tasks cancel error:', taskCancelErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: taskUpdateErr } = await supabase.from('pre_stay_tasks').update(fields).match(matchOn)
            if (taskUpdateErr) console.error('[write] pre_stay_tasks update error:', taskUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        if (!bookingId) {
          console.warn(`[write] pre_stay_tasks skip — no booking_id resolved for this email (booking action was update with no match)`)
          continue
        }
        const taskPayload = { booking_id: bookingId, task_type: fields.task_type ?? null, description: fields.description ?? null, due_date: fields.due_date ?? null }
        console.log(`[write] pre_stay_tasks insert`, JSON.stringify(taskPayload))
        const { error: taskInsertErr } = await supabase.from('pre_stay_tasks').insert(taskPayload)
        if (taskInsertErr) console.error('[write] pre_stay_tasks insert error:', taskInsertErr.message, JSON.stringify(taskPayload))
      } catch (err) {
        console.error('Pre-stay task write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- air_bookings ----
  if (sec('air_bookings', activeSections) && parsed.air_bookings?.length) {
    for (const a of parsed.air_bookings) {
      const action  = (a.action ?? 'create') as string
      const matchOn: Record<string, any> = a.match_on ?? {}
      const fields  = stripMeta(a)

      try {
        if (action === 'cancel') {
          let cq = supabase.from('air_bookings').update({ status: 'cancelled' }) as any
          if (matchOn.ticket_number) {
            cq = cq.eq('ticket_number', matchOn.ticket_number)
          } else if (matchOn.pnr && matchOn.passenger_name) {
            cq = cq.eq('pnr', matchOn.pnr).eq('passenger_name', matchOn.passenger_name)
          } else if (matchOn.pnr) {
            cq = cq.eq('pnr', matchOn.pnr)
          } else {
            console.log(`[write] air_bookings cancel — no usable match_on`, JSON.stringify(matchOn))
            continue
          }
          console.log(`[write] air_bookings cancel`, JSON.stringify(matchOn))
          const { error: airCancelErr } = await cq
          if (airCancelErr) console.error(`[write] air_bookings cancel error`, airCancelErr.message)
          continue
        }

        if (action === 'update') {
          const rawPayload = {
            passenger_name:     fields.passenger_name    ?? undefined,
            airline:            fields.airline           ?? undefined,
            flight_number:      fields.flight_number     ?? undefined,
            origin:             fields.origin            ?? undefined,
            destination:        fields.destination       ?? undefined,
            departure_datetime: fields.departure_datetime ?? undefined,
            cabin_class:        fields.cabin_class       ?? undefined,
            pnr:                fields.pnr               ?? undefined,
            ticket_number:      fields.ticket_number     ?? undefined,
            fare_inr:           fields.fare_inr          ?? undefined,
            total_inr:          fields.total_inr         ?? undefined,
            consolidator:       fields.consolidator      ?? undefined,
            client_type:        fields.client_type       ?? undefined,
            corporate_account:  fields.corporate_account ?? undefined,
            status:             fields.status            ?? undefined,
          }
          const cleanPayload = Object.fromEntries(Object.entries(rawPayload).filter(([, v]) => v !== undefined))
          if (!Object.keys(cleanPayload).length) { continue }

          // Build WHERE using most-specific available match key.
          // ticket_number is unique per passenger; pnr may span multiple rows (all passengers).
          // Never use .maybeSingle() — multiple rows with same PNR are expected.
          let q = supabase.from('air_bookings').update(cleanPayload) as any
          if (matchOn.ticket_number) {
            q = q.eq('ticket_number', matchOn.ticket_number)
          } else if (matchOn.pnr && matchOn.passenger_name) {
            q = q.eq('pnr', matchOn.pnr).eq('passenger_name', matchOn.passenger_name)
          } else if (matchOn.pnr) {
            q = q.eq('pnr', matchOn.pnr)
          } else if (matchOn.amadeus_ref) {
            q = q.eq('amadeus_ref', matchOn.amadeus_ref)
          } else {
            console.log(`[write] air_bookings update — no usable match_on`, JSON.stringify(matchOn))
            continue
          }
          console.log(`[write] air_bookings update`, JSON.stringify({ match: matchOn, ...cleanPayload }))
          const { error: airUpdateErr } = await q
          if (airUpdateErr) console.error('[write] air_bookings update error:', airUpdateErr.message, JSON.stringify({ match: matchOn, ...cleanPayload }))
          continue
        }

        // create — deduplicate by (pnr + passenger_name) composite, then ticket_number.
        // Never use .maybeSingle() on pnr alone — multiple passengers share the same PNR.
        let existingId: string | null = null
        if (fields.pnr && fields.passenger_name) {
          const { data } = await supabase.from('air_bookings').select('id')
            .eq('pnr', fields.pnr)
            .eq('passenger_name', fields.passenger_name)
            .maybeSingle()
          existingId = data?.id ?? null
        } else if (fields.pnr) {
          const { data } = await supabase.from('air_bookings').select('id').eq('pnr', fields.pnr).limit(1)
          existingId = data?.[0]?.id ?? null
        }
        if (!existingId && fields.ticket_number) {
          const { data } = await supabase.from('air_bookings').select('id').eq('ticket_number', fields.ticket_number).maybeSingle()
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
          console.log(`[write] air_bookings update id=${existingId}`, JSON.stringify(payload))
          const { error: airUpdateExistErr } = await supabase.from('air_bookings').update(payload).eq('id', existingId)
          if (airUpdateExistErr) console.error('[write] air_bookings update error:', airUpdateExistErr.message, JSON.stringify(payload))
        } else {
          console.log(`[write] air_bookings insert`, JSON.stringify(payload))
          const { error: airInsertErr } = await supabase.from('air_bookings').insert(payload)
          if (airInsertErr) console.error('[write] air_bookings insert error:', airInsertErr.message, JSON.stringify(payload))
        }
      } catch (err) {
        console.error('Air booking write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- airport_vip_services ----
  if (sec('airport_vip_services', activeSections) && parsed.airport_vip_services?.length) {
    for (const s of parsed.airport_vip_services) {
      const action  = (s.action ?? 'create') as string
      const matchOn: Record<string, any> = s.match_on ?? {}
      const fields  = stripMeta(s)

      try {
        if (action === 'cancel') {
          if (Object.keys(matchOn).length) {
            const { error: vipCancelErr } = await supabase.from('airport_vip_services').update({ status: 'cancelled' }).match(matchOn)
            if (vipCancelErr) console.error('[write] airport_vip_services cancel error:', vipCancelErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: vipUpdateErr } = await supabase.from('airport_vip_services').update(fields).match(matchOn)
            if (vipUpdateErr) console.error('[write] airport_vip_services update error:', vipUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        const vipPayload = { booking_id: bookingId, airport: fields.airport ?? null, airport_name: fields.airport_name ?? null, service_type: fields.service_type ?? null, service_date: fields.service_date ?? null, flight_number: fields.flight_number ?? null, pax_names: fields.pax_names ?? [], provider: fields.provider ?? null, status: fields.status ?? null, cost: fields.cost ?? null, currency: fields.currency ?? null }
        console.log(`[write] airport_vip_services insert`, JSON.stringify(vipPayload))
        const { error: vipInsertErr } = await supabase.from('airport_vip_services').insert(vipPayload)
        if (vipInsertErr) console.error('[write] airport_vip_services insert error:', vipInsertErr.message, JSON.stringify(vipPayload))
      } catch (err) {
        console.error('Airport VIP service write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- enquiries ----
  if (sec('enquiries', activeSections) && parsed.enquiries?.length) {
    for (const e of parsed.enquiries) {
      const action  = (e.action ?? 'create') as string
      const matchOn: Record<string, any> = e.match_on ?? {}
      const fields  = stripMeta(e)

      try {
        if (action === 'update') {
          if (Object.keys(matchOn).length) {
            const { error: enqUpdateErr } = await supabase.from('enquiries').update(fields).match(matchOn)
            if (enqUpdateErr) console.error('[write] enquiries update error:', enqUpdateErr.message, JSON.stringify(matchOn))
          }
          continue
        }

        const enquiryPayload = { client_name: fields.client_name ?? null, property_name: fields.property_name ?? null, destination: fields.destination ?? null, check_in: fields.check_in ?? null, check_out: fields.check_out ?? null, num_rooms: fields.num_rooms ?? null, num_adults: fields.num_adults ?? null, quoted_rate: fields.quoted_rate ?? null, quoted_currency: fields.quoted_currency ?? null, notes: fields.notes ?? null, misc: fields.misc ?? null }
        console.log(`[write] enquiries insert`, JSON.stringify(enquiryPayload))
        const { error: enqInsertErr } = await supabase.from('enquiries').insert(enquiryPayload)
        if (enqInsertErr) console.error('[write] enquiries insert error:', enqInsertErr.message, JSON.stringify(enquiryPayload))
      } catch (err) {
        console.error('Enquiry write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- visa_tracking ----
  if (sec('visa_tracking', activeSections) && parsed.visa_tracking?.length) {
    for (const v of parsed.visa_tracking) {
      const action  = (v.action ?? 'create') as string
      const matchOn: Record<string, any> = v.match_on ?? {}
      const fields  = stripMeta(v)

      try {
        if (action === 'update') {
          if (!Object.keys(matchOn).length) { continue }
          const visaUpdatePayload: Record<string, any> = {}
          const visaCols = ['destination_country', 'nationality', 'visa_required', 'visa_type', 'visa_status', 'application_date', 'expected_date', 'notes']
          for (const col of visaCols) {
            if (fields[col] !== undefined) visaUpdatePayload[col] = fields[col]
          }
          if (!Object.keys(visaUpdatePayload).length) { continue }
          // Resolve client_id from match_on.client_name if present
          const matchClientId = matchOn.client_name
            ? await resolveClient({ full_name: matchOn.client_name }).catch(() => null)
            : null
          let vq = supabase.from('visa_tracking').update(visaUpdatePayload) as any
          if (matchClientId) {
            vq = vq.eq('client_id', matchClientId)
            if (matchOn.destination_country) vq = vq.eq('destination_country', matchOn.destination_country)
          } else if (matchOn.destination_country) {
            vq = vq.eq('destination_country', matchOn.destination_country)
          } else {
            console.log(`[write] visa_tracking update — no usable match_on`, JSON.stringify(matchOn))
            continue
          }
          console.log(`[write] visa_tracking update`, JSON.stringify({ match: matchOn, ...visaUpdatePayload }))
          const { error: visaUpdateErr } = await vq
          if (visaUpdateErr) console.error('[write] visa_tracking update error:', visaUpdateErr.message, JSON.stringify({ match: matchOn, ...visaUpdatePayload }))
          continue
        }

        const clientId = primaryClientId
          ?? (fields.client_name ? await resolveClient({ full_name: fields.client_name }).catch(() => null) : null)
        if (!clientId) {
          console.log(`[write] visa_tracking skip — no client_id resolved`, JSON.stringify(fields))
          continue
        }
        const visaPayload = {
          booking_id:          bookingId,
          client_id:           clientId,
          destination_country: fields.destination_country ?? null,
          nationality:         fields.nationality         ?? null,
          visa_required:       fields.visa_required       ?? null,
          visa_type:           fields.visa_type           ?? null,
          visa_status:         fields.visa_status         ?? null,
          application_date:    fields.application_date    ?? null,
          expected_date:       fields.expected_date       ?? null,
          notes:               fields.notes               ?? null,
        }
        console.log(`[write] visa_tracking insert`, JSON.stringify(visaPayload))
        const { error: visaInsertErr } = await supabase.from('visa_tracking').insert(visaPayload)
        if (visaInsertErr) console.error('[write] visa_tracking insert error:', visaInsertErr.message, JSON.stringify(visaPayload))
      } catch (err) {
        console.error('Visa tracking write failed:', err)
      }
    }
    tablesWritten++
  }

  // ---- email_threads: link this email to every extracted record ----
  try {
    const { error: threadInsertErr } = await supabase.from('email_threads').insert({
      gmail_thread_id: threadId || null,
      booking_id:      bookingId,
      client_id:       primaryClientId,
      property_id:     primaryPropId,
    })
    if (threadInsertErr && !threadInsertErr.message.includes('does not exist')) {
      console.error('[write] email_threads insert error:', threadInsertErr.message)
    }
  } catch { /* table may not exist yet */ }

  if (parsed.misc) {
    console.log(`[misc] ${emailId}:`, parsed.misc)
  }

  return tablesWritten
}

// ----------------------------------------------------------------
// Offer-notice placeholder filter (free — no API call, runs between Stage 1 and Stage 2)
// ----------------------------------------------------------------

interface OfferNoticeResult {
  isOffer:         boolean
  placeholderName: string | null
  optionRef:       string | null
  destination:     string | null
}

// Subject starts with "X Options" — Amadeus offer-notice standard format.
const OFFER_NOTICE_SUBJECT_START_RE = /^([A-Za-z][A-Za-z ]{1,30}?)\s+Options\b/i
// "Offer Notice" or "Amadeus Offer" anywhere in subject or body.
const OFFER_NOTICE_PHRASE_RE        = /offer\s+notice|amadeus\s+offer/i
// "X Options" anywhere in text.
const OFFER_NOTICE_NAME_RE          = /\b([A-Za-z][A-Za-z ]{1,30}?)\s+Options\b/i

function extractAmadeusRef(text: string): string | null {
  // 6-char uppercase alphanumeric option/PNR ref (e.g. "9IIYXY")
  const match = /\b([A-Z0-9]{6})\b/.exec(text.toUpperCase())
  return match?.[1] ?? null
}

export function isOfferNoticePlaceholder(email: {
  subject: string
  body:    string | null
  snippet: string
}): OfferNoticeResult {
  const body     = email.body ?? email.snippet
  const combined = email.subject + ' ' + body

  // Rule 1: subject opens with "X Options" (Amadeus traveler-placeholder format)
  const subjectMatch = OFFER_NOTICE_SUBJECT_START_RE.exec(email.subject.trim())
  if (subjectMatch) {
    const destination = subjectMatch[1].trim()
    return {
      isOffer:         true,
      placeholderName: `${destination} Options`,
      optionRef:       extractAmadeusRef(combined),
      destination,
    }
  }

  // Rule 2: "Offer Notice" / "Amadeus Offer" phrase in subject or body
  if (OFFER_NOTICE_PHRASE_RE.test(email.subject) || OFFER_NOTICE_PHRASE_RE.test(body)) {
    const nameMatch  = OFFER_NOTICE_NAME_RE.exec(body) ?? OFFER_NOTICE_NAME_RE.exec(email.subject)
    const destination = nameMatch?.[1].trim() ?? null
    return {
      isOffer:         true,
      placeholderName: destination ? `${destination} Options` : null,
      optionRef:       extractAmadeusRef(combined),
      destination,
    }
  }

  return { isOffer: false, placeholderName: null, optionRef: null, destination: null }
}

export async function writeOfferNoticeEnquiry(
  emailId: string,
  subject: string,
  result:  OfferNoticeResult,
): Promise<void> {
  // Idempotency: skip the enquiry INSERT if we already have a row for this offer.
  // Primary key: amadeus_option_ref (unique per offer).
  // Fallback key: client_name + destination (when no ref was parseable).
  let alreadyExists = false
  if (result.optionRef) {
    const { data: existing } = await supabase
      .from('enquiries').select('id')
      .eq('amadeus_option_ref', result.optionRef)
      .limit(1)
    if (existing?.length) {
      console.log(`[filter] offer_notice_dup_skip ${emailId} existing_enquiry=${existing[0].id} ref=${result.optionRef}`)
      alreadyExists = true
    }
  } else if (result.placeholderName && result.destination) {
    const { data: existing } = await supabase
      .from('enquiries').select('id')
      .eq('client_name', result.placeholderName)
      .eq('destination', result.destination)
      .limit(1)
    if (existing?.length) {
      console.log(`[filter] offer_notice_dup_skip ${emailId} existing_enquiry=${existing[0].id} name="${result.placeholderName}"`)
      alreadyExists = true
    }
  }

  if (!alreadyExists) {
    await supabase.from('enquiries').insert({
      client_id:          null,
      client_name:        result.placeholderName,
      amadeus_option_ref: result.optionRef,
      destination:        result.destination,
      status:             'sent',
      notes:              `${subject} [auto-routed: offer notice, not extracted]`,
    })
    console.log(`[filter] offer_notice_skip ${emailId} name="${result.placeholderName ?? 'unknown'}" ref=${result.optionRef ?? 'none'}`)
  }

  await supabase.from('inbox_emails').update({
    category:          'offer_notice',
    booking_extracted: true,
  }).eq('id', emailId)
}

// ----------------------------------------------------------------
// Stage 1: free hard filter — no API call
// ----------------------------------------------------------------

const NOISE_SENDER_FRAGMENTS = [
  'noreply', 'no-reply', 'donotreply', 'newsletter', 'marketing',
  'notifications', 'updates@', 'alerts@',
  '@pinterest.com', '@squareup.com', '@survey.', '@feedback.', 'feedback@',
  '@axisbankmail.', '@adidas.',
]

const NOISE_DOMAINS = [
  '@klm-mail.com', '@nexusdmc.com', '@tourishdmc.com', '@collezioneem.com',
  '@travellermade.com', '@ethiopianairlines.com', '@aviareps.com',
  '@naukri.com', '@paisabazaar.com',
]

const NOISE_SUBJECT_PHRASES = [
  'unsubscribe', 'newsletter', 'vote for', 'last chance to vote',
  'promotional', 'special offer', 'fixed departures', 'b2b packages',
  'boarding pass', 'check-in confirmation', 'your flight', 'flight reminder',
  'trip reminder', 'payment completed', 'invoice paid', 'readers choice',
  'new route', 'unwrap the magic', 'last-minute summer', 'summer offers',
  'trade circular', 'fam trip invitation',
]

export function isStage1Noise(fromEmail: string, subject: string): boolean {
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
        `Is this email a newsletter, marketing promotion, automated airline notification, ` +
        `trade circular, payment receipt for a non-hotel service, social media digest, ` +
        `or industry award vote request? These should be skipped. ` +
        `Reply YES to skip, NO to process. When in doubt about newsletters and promotions, reply YES.\n\n` +
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

export async function markExtracted(emailId: string): Promise<void> {
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
    thread_id: string
  },
  gmail: any | null,
): Promise<number> {
  // Stage 1 — free hard filter
  if (isStage1Noise(email.from_email, email.subject)) {
    console.log(`[filter] stage1_skip ${email.id}`)
    await markExtracted(email.id)
    return 0
  }

  // Stage 1b — offer-notice placeholder filter (free — saves Haiku + Sonnet cost)
  const offerResult = isOfferNoticePlaceholder(email)
  if (offerResult.isOffer) {
    await writeOfferNoticeEnquiry(email.id, email.subject, offerResult)
    return 0
  }

  // Stage 2 — Haiku noise gate
  const noise = await isStage2Noise(email.subject, email.snippet).catch(() => false)
  if (noise) {
    console.log(`[filter] haiku_skip ${email.id}`)
    await markExtracted(email.id)
    return 0
  }

  // Belt-and-suspenders: if a booking already has this email_id, extraction already ran
  const { data: existingBookings } = await supabase
    .from('bookings').select('id').eq('email_id', email.id).limit(1)
  if (existingBookings?.length) {
    console.warn(`[extract] belt_and_suspenders_skip ${email.id} — booking already exists for this email_id`)
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
  return writeExtracted(parsed, email.id, email.inbox_address, email.thread_id, undefined, email.body, email.email_date)
}

/**
 * Batch runner: fetches up to 5 unextracted emails and runs them through
 * stage-1 hard filter → stage-2 Haiku gate → stage-3 Sonnet extraction.
 */
export async function runExtraction(): Promise<ExtractionResult> {
  const { data: emails, error } = await supabase
    .from('inbox_emails')
    .select('id, subject, from_email, to_addresses, email_date, snippet, body, inbox_address, thread_id')
    .eq('booking_extracted', false)
    .limit(3)

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
