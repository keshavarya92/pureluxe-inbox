import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import { getGmailClient } from '@/lib/gmail'
import {
  writeExtracted,
  isStage1Noise,
  isOfferNoticePlaceholder,
  writeOfferNoticeEnquiry,
  getSystemPrompt,
  markExtracted,
  classifyEmailTier,
} from '@/lib/extract'
import { fetchAttachments, extractTextFromAttachment } from '@/lib/attachments'
import { extractTags, sectionsForTags, requiresExtraction } from '@/lib/tags'
import { matchGdsWhitelist } from '@/lib/config/gdsWhitelist'

export const maxDuration = 300

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
})

async function handler(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ---- Step 1: Process previous batch results ----
  let previousResultsProcessed = 0

  const { data: pendingBatches } = await supabase
    .from('extraction_batches')
    .select('id, batch_id')
    .eq('results_processed', false)

  for (const batch of pendingBatches ?? []) {
    try {
      const batchStatus = await client.beta.messages.batches.retrieve(batch.batch_id)
      if (batchStatus.processing_status !== 'ended') continue

      // Collect all results in one pass
      const results: any[] = []
      const stream = await client.beta.messages.batches.results(batch.batch_id)
      for await (const result of stream) results.push(result)

      // Batch-fetch inbox_address AND stored tags for all email IDs in this batch
      const emailIds = results.map((r: any) => r.custom_id)
      const { data: emailRows } = await supabase
        .from('inbox_emails')
        .select('id, inbox_address, tags')
        .in('id', emailIds)
      const addrMap = new Map(emailRows?.map(e => [e.id, e.inbox_address]) ?? [])
      const tagsMap = new Map(emailRows?.map(e => [e.id, (e.tags as string[]) ?? []]) ?? [])

      for (const result of results) {
        const emailId: string = result.custom_id
        const r = result.result
        if (r.type !== 'succeeded') continue

        try {
          const raw: string = r.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())

          // Resolve activeSections from the tags stored during batch submission.
          // tags = []  → GDS email or untagged-but-queued path → all sections run
          // tags = [...] → tag-filtered path → only those sections run
          const storedTags = tagsMap.get(emailId) ?? []
          const activeSections = sectionsForTags(storedTags) ?? undefined

          await writeExtracted(parsed, emailId, addrMap.get(emailId) ?? '', activeSections)
          await markExtracted(emailId)
          previousResultsProcessed++
        } catch (err) {
          console.error(`[batch] writeExtracted failed for ${emailId}:`, err)
          await markExtracted(emailId)
        }
      }

      await supabase
        .from('extraction_batches')
        .update({ status: 'completed', completed_at: new Date().toISOString(), results_processed: true })
        .eq('id', batch.id)

      console.log(`[batch] results processed: ${previousResultsProcessed} emails from ${batch.batch_id}`)
    } catch (err) {
      console.error(`[batch] failed to process batch ${batch.batch_id}:`, err)
    }
  }

  // ---- Step 2: Submit new batch ----
  const { data: emails, error: fetchError } = await supabase
    .from('inbox_emails')
    .select('id, subject, from_email, to_addresses, email_date, snippet, body, inbox_address, thread_id, has_confirmation_attachment')
    .eq('booking_extracted', false)
    .limit(100)

  if (fetchError) throw new Error(fetchError.message)

  if (!emails?.length) {
    return NextResponse.json({
      batch_id: null,
      email_count: 0,
      offer_notice_count: 0,
      gds_count: 0,
      unclassified_count: 0,
      plx_op_count: 0,
      tier2_count: 0,
      tier3_count: 0,
      previous_results_processed: previousResultsProcessed,
    })
  }

  // Pre-fetch thread tags for all thread_ids in this batch (avoids N queries).
  // We look up any prior email in the same thread that already has non-empty tags.
  const allThreadIds = [...new Set(emails.map(e => e.thread_id).filter(Boolean))]
  let threadTagsMap = new Map<string, string[]>()
  if (allThreadIds.length) {
    const { data: threadRows } = await supabase
      .from('inbox_emails')
      .select('thread_id, tags')
      .in('thread_id', allThreadIds)
      .neq('booking_extracted', false) // only already-processed rows have settled tags
      .not('tags', 'eq', '{}')
      .order('synced_at', { ascending: false })
    // Keep the most-recent tags per thread_id
    for (const row of threadRows ?? []) {
      if (row.thread_id && !threadTagsMap.has(row.thread_id) && row.tags?.length) {
        threadTagsMap.set(row.thread_id, row.tags)
      }
    }
  }

  // Prefetch all inbox user tokens
  const { data: users } = await supabase.from('inbox_users').select('email, access_token, refresh_token')
  const userMap = new Map(users?.map(u => [u.email, u]) ?? [])

  const requests: any[] = []
  let offerNoticeCount  = 0
  let gdsCount          = 0
  let unclassifiedCount = 0
  let plxOpCount        = 0
  let tier2Count        = 0
  let tier3Count        = 0

  for (const email of emails) {
    // ---- Stage 1: hard noise filter ----
    if (isStage1Noise(email.from_email, email.subject)) {
      await markExtracted(email.id)
      continue
    }

    // ---- Stage 1b: offer-notice placeholder filter ----
    const offerResult = isOfferNoticePlaceholder(email)
    if (offerResult.isOffer) {
      offerNoticeCount++
      await writeOfferNoticeEnquiry(email.id, email.subject, offerResult)
      continue
    }

    // ---- Stage 2: GDS whitelist check ----
    // Whitelisted senders bypass tag routing entirely — queue for full extraction.
    const gdsMatch = matchGdsWhitelist(
      email.from_email,
      email.has_confirmation_attachment ?? false,
    )
    if (gdsMatch.matched) {
      gdsCount++
      const ownTags = extractTags(email.subject)
      await supabase.from('inbox_emails').update({
        tags:     ownTags,
        category: `gds_${gdsMatch.source ?? 'unknown'}`,
      }).eq('id', email.id)
      // Fall through to tier classification + batch request (activeSections = undefined)
    } else {
      // ---- Stage 3: tag extraction and routing ----
      const ownTags       = extractTags(email.subject)
      const inheritedTags = (!ownTags.length && email.thread_id)
        ? (threadTagsMap.get(email.thread_id) ?? [])
        : []
      const effectiveTags = ownTags.length ? ownTags : inheritedTags

      if (effectiveTags.length === 0) {
        // No tags, no thread inheritance → unclassified, skip extraction
        unclassifiedCount++
        console.log(`[tags] unclassified_skip ${email.id}`)
        await supabase.from('inbox_emails').update({
          tags:              [],
          category:          'unclassified',
          booking_extracted: true,
        }).eq('id', email.id)
        continue
      }

      if (!requiresExtraction(effectiveTags)) {
        // PLX-OP only → log stub, skip extraction
        plxOpCount++
        console.log(`[tags] plx_op_skip ${email.id}`)
        await supabase.from('inbox_emails').update({
          tags:              ownTags,
          category:          'PLX-OP',
          booking_extracted: true,
        }).eq('id', email.id)
        continue
      }

      // Store own tags + category (first effective tag) on the email row.
      // Inherited tags are used for routing only — not persisted in tags[].
      const category = effectiveTags[0]
      const logInherited = inheritedTags.length ? ` (inherited from thread ${email.thread_id})` : ''
      console.log(`[tags] tagged ${email.id} tags=${JSON.stringify(effectiveTags)}${logInherited}`)
      await supabase.from('inbox_emails').update({
        tags:     ownTags,
        category,
      }).eq('id', email.id)
    }

    // ---- Build batch request ----
    const user   = userMap.get(email.inbox_address)
    const gmail  = user?.access_token
      ? getGmailClient(user.access_token, user.refresh_token)
      : null
    const tier   = classifyEmailTier(email.from_email, [])

    const blocks: any[] = [{
      type: 'text',
      text: `FROM: ${email.from_email}\nTO: ${(email.to_addresses ?? []).join(', ')}\nDATE: ${email.email_date}\nSUBJECT: ${email.subject}\n\n${email.body || email.snippet}`,
    }]

    if (tier === 3 && gmail) {
      try {
        const attachments = await fetchAttachments(gmail, email.id)
        for (const att of attachments) {
          try {
            const isIdentity = /passport|visa|\bid\b/i.test(att.filename)
            const isImage    = att.mimeType === 'image/jpeg' || att.mimeType === 'image/png'
            if (isImage && isIdentity) continue
            const content = await extractTextFromAttachment(att)
            if (!content) continue
            if (content.kind === 'pdf') {
              blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: content.base64 } } as any)
            } else if (content.kind === 'image') {
              blocks.push({ type: 'image', source: { type: 'base64', media_type: content.mimeType, data: content.base64 } })
            } else {
              blocks.push({ type: 'text', text: `[Attachment: ${att.filename}]\n${content.text}` })
            }
          } catch { /* skip bad attachment */ }
        }
        tier3Count++
      } catch {
        tier2Count++
      }
    } else {
      tier2Count++
    }

    blocks.push({ type: 'text', text: 'Extract all structured data from the above email and attachments. Return ONLY valid JSON as specified.' })

    requests.push({
      custom_id: email.id,
      params: {
        model:      'claude-sonnet-4-6',
        max_tokens: 8192,
        system:     [{ type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral', ttl: '1h' } }] as any,
        messages:   [{ role: 'user', content: blocks }],
      },
    })
  }

  if (!requests.length) {
    return NextResponse.json({
      batch_id: null,
      email_count: 0,
      offer_notice_count: offerNoticeCount,
      gds_count: gdsCount,
      unclassified_count: unclassifiedCount,
      plx_op_count: plxOpCount,
      tier2_count: tier2Count,
      tier3_count: tier3Count,
      previous_results_processed: previousResultsProcessed,
    })
  }

  const batch = await client.beta.messages.batches.create({ requests })

  await supabase.from('extraction_batches').insert({
    batch_id:          batch.id,
    email_count:       requests.length,
    status:            'pending',
    results_processed: false,
  })

  return NextResponse.json({
    batch_id:                   batch.id,
    email_count:                requests.length,
    offer_notice_count:         offerNoticeCount,
    gds_count:                  gdsCount,
    unclassified_count:         unclassifiedCount,
    plx_op_count:               plxOpCount,
    tier2_count:                tier2Count,
    tier3_count:                tier3Count,
    previous_results_processed: previousResultsProcessed,
  })
}

export const GET  = handler
export const POST = handler
