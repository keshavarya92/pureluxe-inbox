import Anthropic from '@anthropic-ai/sdk'
import type { RawEmail } from './gmail'
import type { ClassifiedEmail } from '@/types'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
})

const CLASSIFICATION_SYSTEM = `You are an email intelligence system for PureLuxe, a luxury travel agency based in Mumbai (a division of KFT Corporation). 

Your job is to classify and extract structured data from emails.

KFT email addresses: keshav@kft.travel, sanjay@kft.travel, tours@kft.travel, holidays@kft.travel, info@kft.travel

CATEGORIES:
- booking: Hotel confirmations, options, rate quotes, flight tickets, transfer bookings, wellness programme confirmations, restaurant reservations
- client: Emails from or about clients, client requests, client updates
- supplier: Emails from hotels, airlines, DMCs, wellness resorts, ground handlers, consortiums (LHW, Serandipians, TravellerMade, THRS, Heavens Portfolio)
- finance: Invoices, payment confirmations, payment links, credit card alerts, commission statements, cancellation invoices
- pre_stay: Arrival time requests, wellness questionnaires, room preference requests, transfer details, pre-stay coordination
- ops: Internal team emails, admin, industry events, ILTM, webinars, trade shows
- dispute: Cancellation disputes, overbooking issues, complaint threads, refund requests
- noise: Newsletters, marketing, promotions, social media, personal finance alerts (SIP, IPO, mutual funds), irrelevant spam, airline baggage notifications (baggage tracker, checked-in baggage, baggage allowance alerts from Air India or any airline)

ACTION PRIORITY:
- urgent: Needs response within 4 hours (option expiring, client complaint, live trip issue)
- high: Needs response within 24 hours (booking confirmation pending, payment due, pre-stay coordination for trip within 7 days)
- normal: Needs response within 48 hours
- low: FYI, no urgent response needed
- none: No action required (newsletters, auto-confirmations, noise)

Respond ONLY with valid JSON. No markdown, no explanation, no backticks.`

const CLASSIFICATION_PROMPT = (email: RawEmail) => `Classify this email and extract all relevant data.

FROM: ${email.fromName} <${email.from}>
TO: ${email.to.join(', ')}
CC: ${email.cc.join(', ')}
DATE: ${email.date}
SUBJECT: ${email.subject}
BODY:
${email.body || email.snippet}

Return this exact JSON structure (include all fields, use null for unknown):
{
  "category": "booking|client|supplier|finance|pre_stay|ops|dispute|noise",
  "tags": ["array", "of", "relevant", "categories"],
  "summary": "One sentence max 15 words describing what this email needs or is about",
  "actionRequired": true|false,
  "actionPriority": "urgent|high|normal|low|none",
  "actionDescription": "What specifically needs to be done, or null",
  "booking": {
    "clientName": "Full name or null",
    "property": "Hotel/resort name or null",
    "checkIn": "YYYY-MM-DD or null",
    "checkOut": "YYYY-MM-DD or null",
    "nights": number|null,
    "rooms": number|null,
    "guests": number|null,
    "roomType": "Room type or null",
    "confirmationNumber": "Conf number or null",
    "gdsRef": "GDS booking ref or null",
    "totalAmount": number|null,
    "currency": "THB|JPY|USD|EUR|GBP|INR or null",
    "netAmount": number|null,
    "commissionRate": number|null,
    "commissionAmount": number|null,
    "status": "enquiry|quote|option|confirmed|cancelled|completed|null",
    "cancellationDeadline": "YYYY-MM-DD or null",
    "cancellationPolicy": "Policy text or null",
    "paymentStatus": "unpaid|deposit|part_paid|fully_paid|null",
    "supplier": "Supplier name or null",
    "supplierEmail": "Supplier email or null",
    "programme": "Programme name for wellness bookings or null"
  },
  "finance": {
    "amount": number|null,
    "currency": "string or null",
    "type": "invoice|payment|cancellation|refund|deposit|null",
    "reference": "Invoice/ref number or null",
    "dueDate": "YYYY-MM-DD or null"
  },
  "supplierContact": {
    "name": "Contact name or null",
    "email": "Contact email or null",
    "property": "Property name or null",
    "consortium": "LHW|Serandipians|TravellerMade|THRS|Independent or null"
  }
}

If category is not "booking", set booking fields to null.
If category is not "finance", set finance fields to null.
If not a supplier email, set supplierContact fields to null.`

export async function classifyEmail(email: RawEmail): Promise<ClassifiedEmail> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // Haiku for classification - fast and cheap
      max_tokens: 1000,
      system: CLASSIFICATION_SYSTEM,
      messages: [{ role: 'user', content: CLASSIFICATION_PROMPT(email) }],
    })

    const contentBlocks = Array.isArray((response as any)?.content) ? (response as any).content : []
    const text = contentBlocks
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')

    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    // Basic validation / defaults to avoid runtime shape errors
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid model output')
    if (!Array.isArray(parsed.tags)) parsed.tags = []
    parsed.tags = parsed.tags.map((t: any) => String(t))
    parsed.category = parsed.category || 'ops'
    parsed.actionRequired = typeof parsed.actionRequired === 'boolean' ? parsed.actionRequired : false
    parsed.actionPriority = parsed.actionPriority || 'none'

    return {
      id: email.id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      fromName: email.fromName,
      to: email.to,
      cc: email.cc,
      date: email.date,
      snippet: email.snippet,
      unread: email.unread,
      ...parsed,
      // Clean up null booking/finance if not relevant
      booking: parsed.category === 'booking' ? parsed.booking : undefined,
      finance: parsed.category === 'finance' ? parsed.finance : undefined,
      supplierContact: ['supplier', 'booking', 'pre_stay'].includes(parsed.category)
        ? parsed.supplierContact
        : undefined,
    }
  } catch (err) {
    console.error('Classification error for email:', email.id, err)
    // Fallback classification
    return {
      id: email.id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      fromName: email.fromName,
      to: email.to,
      cc: email.cc,
      date: email.date,
      snippet: email.snippet,
      unread: email.unread,
      category: 'ops',
      tags: ['ops'],
      summary: email.snippet.slice(0, 100),
      actionRequired: false,
      actionPriority: 'none',
    }
  }
}

export async function classifyBatch(emails: RawEmail[]): Promise<ClassifiedEmail[]> {
  // Process in parallel with concurrency limit of 5
  const concurrency = 5
  const results: ClassifiedEmail[] = []

  for (let i = 0; i < emails.length; i += concurrency) {
    const batch = emails.slice(i, i + concurrency)
    const classified = await Promise.all(batch.map(classifyEmail))
    results.push(...classified)
  }

  return results
}

// Deeper extraction using Sonnet for booking emails
const EXTRACTION_SYSTEM = `You are a booking data extraction system for PureLuxe, a luxury travel agency.
Extract ALL structured data from this booking-related email thread with maximum accuracy.
Respond ONLY with valid JSON. No markdown, no explanation.`

export async function deepExtractBooking(email: RawEmail): Promise<Partial<ClassifiedEmail>> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', // Sonnet for deep extraction
      max_tokens: 1500,
      system: EXTRACTION_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Extract all booking and financial data from this email:

FROM: ${email.fromName} <${email.from}>
SUBJECT: ${email.subject}
DATE: ${email.date}
BODY:
${email.body}

Return comprehensive JSON with every field you can extract. Be precise with amounts, dates, and reference numbers.`,
        },
      ],
    })

    const contentBlocks = Array.isArray((response as any)?.content) ? (response as any).content : []
    const text = contentBlocks
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')

    const cleaned = text.replace(/```json|```/g, '').trim()
    return JSON.parse(cleaned)
  } catch (err) {
    console.error('Deep extraction error for email:', email.id, err)
    return {}
  }
}
