import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Regression test for: batch-submit dropped `body`/`email_date` when calling
// writeExtracted, which silently disabled the pending_review queue gate for
// every booking processed through the Anthropic Batches pipeline.
//
// This drives the real route handler with mocked Supabase/Anthropic clients
// and asserts writeExtracted receives the email's body and email_date.
// ---------------------------------------------------------------------------

const {
  writeExtractedMock,
  markExtractedMock,
  fromMock,
  TEST_EMAIL,
  EXTRACTED_JSON,
} = vi.hoisted(() => {
  const TEST_EMAIL = {
    id:            'email-1',
    inbox_address: 'keshav@kft.travel',
    tags:          [] as string[],
    thread_id:     'thread-abc',
    body:          'Booking confirmed for our stay in July',
    email_date:    '2026-07-05',
  }

  const EXTRACTED_JSON = {
    bookings: [{
      action:     'create',
      check_in:   '2026-08-01',
      check_out:  '2026-08-05',
      hotel_name: 'Test Hotel',
      hotel_ref:  'HR-1',
    }],
  }

  // Minimal fake for Supabase's fluent query builder: every chain method
  // returns itself, and awaiting the chain at any point resolves `result`.
  function makeChain(result: unknown) {
    const chain: any = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'is', 'not', 'order', 'update', 'limit']) {
      chain[m] = () => chain
    }
    chain.maybeSingle = () => Promise.resolve(result)
    chain.single       = () => Promise.resolve(result)
    chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject)
    return chain
  }

  let inboxEmailsCallCount = 0
  const fromMock = vi.fn((table: string) => {
    if (table === 'extraction_batches') {
      return makeChain({ data: [{ id: 'batch-row-1', batch_id: 'msgbatch_test123' }] })
    }
    if (table === 'inbox_emails') {
      inboxEmailsCallCount++
      // 1st call: emailRows lookup for the completed batch's results.
      // 2nd call: Step 2's "unextracted emails" fetch — return none so the
      // route exits before submitting a new batch (out of scope here).
      return inboxEmailsCallCount === 1
        ? makeChain({ data: [TEST_EMAIL] })
        : makeChain({ data: [] })
    }
    return makeChain({ data: [] })
  })

  return {
    writeExtractedMock: vi.fn().mockResolvedValue(1),
    markExtractedMock:  vi.fn().mockResolvedValue(undefined),
    fromMock,
    TEST_EMAIL,
    EXTRACTED_JSON,
  }
})

vi.mock('@/lib/supabase', () => ({ supabase: { from: fromMock } }))

vi.mock('@/lib/extract', () => ({
  writeExtracted:           writeExtractedMock,
  markExtracted:            markExtractedMock,
  isStage1Noise:            vi.fn(() => false),
  isOfferNoticePlaceholder: vi.fn(() => ({ isOffer: false })),
  writeOfferNoticeEnquiry:  vi.fn(),
  getSystemPrompt:          vi.fn(() => 'system prompt'),
  classifyEmailTier:        vi.fn(() => 2),
}))

vi.mock('@/lib/gmail', () => ({ getGmailClient: vi.fn() }))
vi.mock('@/lib/attachments', () => ({ fetchAttachments: vi.fn(), extractTextFromAttachment: vi.fn() }))
vi.mock('@/lib/tags', () => ({
  extractTags:        vi.fn(() => []),
  sectionsForTags:    vi.fn(() => null),
  requiresExtraction: vi.fn(() => false),
}))
vi.mock('@/lib/config/gdsWhitelist', () => ({ matchGdsWhitelist: vi.fn(() => ({ matched: false })) }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    beta: {
      messages: {
        batches: {
          retrieve: vi.fn().mockResolvedValue({ processing_status: 'ended' }),
          results:  vi.fn().mockResolvedValue([{
            custom_id: TEST_EMAIL.id,
            result: {
              type: 'succeeded',
              message: { content: [{ type: 'text', text: JSON.stringify(EXTRACTED_JSON) }] },
            },
          }]),
          create: vi.fn().mockResolvedValue({ id: 'msgbatch_new' }),
        },
      },
    },
  })),
}))

process.env.CRON_SECRET = 'test-secret'

describe('batch-submit cron route', () => {
  it('passes the email body and email_date through to writeExtracted', async () => {
    const { GET } = await import('../app/api/cron/batch-submit/route')

    const req = {
      headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) },
    } as any

    await GET(req)

    expect(writeExtractedMock).toHaveBeenCalledTimes(1)
    const [parsed, emailId, inboxAddress, threadId, activeSections, body, emailDate] =
      writeExtractedMock.mock.calls[0]

    expect(parsed).toEqual(EXTRACTED_JSON)
    expect(emailId).toBe(TEST_EMAIL.id)
    expect(inboxAddress).toBe(TEST_EMAIL.inbox_address)
    expect(threadId).toBe(TEST_EMAIL.thread_id)
    expect(activeSections).toBeUndefined()
    // The actual regression: these two used to be silently dropped, which
    // forced isPendingReview to false for every batch-processed booking.
    expect(body).toBe(TEST_EMAIL.body)
    expect(emailDate).toBe(TEST_EMAIL.email_date)

    expect(markExtractedMock).toHaveBeenCalledWith(TEST_EMAIL.id)
  })
})
