import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import { getGmailClient } from '@/lib/gmail'
import {
  writeExtracted,
  isStage1Noise,
  getSystemPrompt,
  markExtracted,
  classifyEmailTier,
} from '@/lib/extract'
import { fetchAttachments, extractTextFromAttachment } from '@/lib/attachments'

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
      for await (const result of stream) {
        results.push(result)
      }

      // Batch-fetch inbox_address for all email IDs in this batch
      const emailIds = results.map((r: any) => r.custom_id)
      const { data: emailRows } = await supabase
        .from('inbox_emails')
        .select('id, inbox_address')
        .in('id', emailIds)
      const addrMap = new Map(emailRows?.map(e => [e.id, e.inbox_address]) ?? [])

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
          await writeExtracted(parsed, emailId, addrMap.get(emailId) ?? '')
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
    .select('id, subject, from_email, to_addresses, email_date, snippet, body, inbox_address')
    .eq('booking_extracted', false)
    .limit(100)

  if (fetchError) throw new Error(fetchError.message)

  if (!emails?.length) {
    return NextResponse.json({
      batch_id: null,
      email_count: 0,
      tier2_count: 0,
      tier3_count: 0,
      previous_results_processed: previousResultsProcessed,
    })
  }

  // Prefetch all inbox user tokens to avoid N individual DB queries
  const { data: users } = await supabase.from('inbox_users').select('email, access_token, refresh_token')
  const userMap = new Map(users?.map(u => [u.email, u]) ?? [])

  const requests: any[] = []
  let tier2Count = 0
  let tier3Count = 0

  for (const email of emails) {
    // Stage 1 hard filter — mark and skip immediately
    if (isStage1Noise(email.from_email, email.subject)) {
      await markExtracted(email.id)
      continue
    }

    const user = userMap.get(email.inbox_address)
    const gmail = user?.access_token
      ? getGmailClient(user.access_token, user.refresh_token)
      : null

    // Classify by from_email only — skip per-email Gmail metadata calls to stay within timeout
    const tier = classifyEmailTier(email.from_email, [])

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
            const isImage = att.mimeType === 'image/jpeg' || att.mimeType === 'image/png'
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
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: [{ type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral', ttl: '1h' } }] as any,
        messages: [{ role: 'user', content: blocks }],
      },
    })
  }

  if (!requests.length) {
    return NextResponse.json({
      batch_id: null,
      email_count: 0,
      tier2_count: tier2Count,
      tier3_count: tier3Count,
      previous_results_processed: previousResultsProcessed,
    })
  }

  const batch = await client.beta.messages.batches.create({ requests })

  await supabase.from('extraction_batches').insert({
    batch_id: batch.id,
    email_count: requests.length,
    status: 'pending',
    results_processed: false,
  })

  return NextResponse.json({
    batch_id: batch.id,
    email_count: requests.length,
    tier2_count: tier2Count,
    tier3_count: tier3Count,
    previous_results_processed: previousResultsProcessed,
  })
}

export const GET = handler
export const POST = handler
