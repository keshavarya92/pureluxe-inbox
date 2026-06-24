import Anthropic from '@anthropic-ai/sdk'
import mammoth from 'mammoth'
import { simpleParser } from 'mailparser'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface Attachment {
  filename: string
  mimeType: string
  data: Buffer
}

export interface EmailContext {
  subject: string
  from: string
  messageId: string
}

// Internal union — determines how Claude receives the content
type AttachmentContent =
  | { kind: 'text';     text: string }
  | { kind: 'pdf';      base64: string }
  | { kind: 'image';    base64: string; mimeType: 'image/jpeg' | 'image/png' }

// ----------------------------------------------------------------
// Step 1: fetchAttachments
// ----------------------------------------------------------------

function collectParts(payload: any): any[] {
  const parts: any[] = []
  // A part is an attachment when it has a non-empty filename and body data
  if (payload.filename?.length && (payload.body?.attachmentId || payload.body?.data)) {
    parts.push(payload)
  }
  for (const child of payload.parts ?? []) {
    parts.push(...collectParts(child))
  }
  return parts
}

function decodeGmailBase64(str: string): Buffer {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export async function fetchAttachments(gmail: any, messageId: string): Promise<Attachment[]> {
  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
  const parts = collectParts(res.data.payload ?? {})

  const attachments: Attachment[] = []

  for (const part of parts) {
    let data: Buffer

    if (part.body?.data) {
      data = decodeGmailBase64(part.body.data)
    } else if (part.body?.attachmentId) {
      const fetched = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: part.body.attachmentId,
      })
      data = decodeGmailBase64(fetched.data.data)
    } else {
      continue
    }

    attachments.push({
      filename: part.filename ?? 'attachment',
      mimeType: part.mimeType ?? 'application/octet-stream',
      data,
    })
  }

  return attachments
}

// ----------------------------------------------------------------
// Step 2: extractTextFromAttachment
// ----------------------------------------------------------------

function stripHtmlTags(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|tr|td|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    .trim()
}

/** Sniff actual image format from magic bytes — Gmail headers can lie. */
function sniffImageMime(data: Buffer): 'image/jpeg' | 'image/png' | null {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  return null
}

export async function extractTextFromAttachment(attachment: Attachment): Promise<AttachmentContent | null> {
  const { mimeType, data, filename } = attachment

  if (mimeType === 'application/pdf') {
    return { kind: 'pdf', base64: data.toString('base64') }
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    const actual = sniffImageMime(data) ?? mimeType
    return { kind: 'image', base64: data.toString('base64'), mimeType: actual }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer: data })
    const text = result.value.trim()
    return text ? { kind: 'text', text } : null
  }

  if (mimeType === 'message/rfc822' || filename.toLowerCase().endsWith('.eml')) {
    const parsed = await simpleParser(data)
    const text = parsed.text?.trim() || (parsed.html ? stripHtmlTags(parsed.html) : '')
    return text ? { kind: 'text', text } : null
  }

  if (mimeType === 'text/html') {
    const text = stripHtmlTags(data.toString('utf-8'))
    return text ? { kind: 'text', text } : null
  }

  if (mimeType.startsWith('text/')) {
    const text = data.toString('utf-8').trim()
    return text ? { kind: 'text', text } : null
  }

  return null
}

// ----------------------------------------------------------------
// Step 3: extractBookingFromAttachment
// ----------------------------------------------------------------

const SYSTEM = `You are a booking data extraction system for PureLuxe, a luxury travel agency based in Mumbai (KFT Corporation).
Extract structured booking data from hotel confirmation documents, vouchers, and booking letters.
Respond ONLY with valid JSON. No markdown, no explanation, no backticks.`

const JSON_SCHEMA = `{
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

export async function extractBookingFromAttachment(
  content: AttachmentContent,
  emailContext: EmailContext,
): Promise<Record<string, unknown> | null> {
  const contextLine = `Email — Subject: ${emailContext.subject} | From: ${emailContext.from}`
  const instruction = `Extract all booking data from this attachment. ${contextLine}\n\nReturn this exact JSON (use null for any field you cannot find):\n${JSON_SCHEMA}`

  let messages: Anthropic.MessageParam[]

  if (content.kind === 'pdf') {
    messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: content.base64 },
        } as any,
        { type: 'text', text: instruction },
      ],
    }]
  } else if (content.kind === 'image') {
    messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: content.mimeType, data: content.base64 },
        },
        { type: 'text', text: instruction },
      ],
    }]
  } else {
    messages = [{
      role: 'user',
      content: `${instruction}\n\nDocument content:\n${content.text}`,
    }]
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM,
    messages,
  })

  const raw = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())

  // If Claude found nothing identifying, treat as empty
  if (!parsed.hotel_name && !parsed.client_name && !parsed.hotel_ref && !parsed.amadeus_ref) {
    return null
  }

  return parsed
}

// ----------------------------------------------------------------
// Public: chain all three steps
// ----------------------------------------------------------------

export async function processEmailAttachments(
  gmail: any,
  messageId: string,
  emailContext: EmailContext,
): Promise<Record<string, unknown> | null> {
  const attachments = await fetchAttachments(gmail, messageId)
  if (attachments.length === 0) return null

  for (const attachment of attachments) {
    try {
      const content = await extractTextFromAttachment(attachment)
      if (!content) continue

      const result = await extractBookingFromAttachment(content, emailContext)
      if (result) return result
    } catch (err) {
      console.error(`Attachment processing failed [${attachment.filename}]:`, err)
    }
  }

  return null
}
