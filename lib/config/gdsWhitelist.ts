/**
 * GDS sender whitelist.
 *
 * Emails from these senders bypass the tag-based routing and are always
 * processed through the full structured extraction pipeline.
 *
 * TODO: Before relying on these patterns in production, verify the actual
 * from_email values stored by Gmail by running in Supabase:
 *
 *   -- KFT / Amadeus relay:
 *   SELECT id, from_email, from_name, has_confirmation_attachment
 *   FROM inbox_emails WHERE from_email ILIKE '%kft.travel%' LIMIT 10;
 *
 *   -- LHW:
 *   SELECT id, from_email, from_name
 *   FROM inbox_emails WHERE from_email ILIKE '%lhw.com%' LIMIT 10;
 *
 * Gmail exposes the envelope From header (e.g. "info@kft.travel"), not the
 * relay domain ("doc.mail.amadeus.com"), so from_email matching against
 * kft.travel is likely correct — but confirm before go-live.
 */

export interface GdsEntry {
  /** Exact from_email to match (case-insensitive). */
  senderEmail: string
  /** Human-readable source label written to inbox_emails.category. */
  source: 'amadeus' | 'lhw' | string
  /**
   * When true, the sender alone is ambiguous (e.g. KFT sends both internal
   * mail and Amadeus itineraries from the same address). Also require
   * has_confirmation_attachment = true before treating as GDS.
   * When false (e.g. LHW reservations), sender match is sufficient.
   */
  requireAttachmentMatch: boolean
}

export const gdsWhitelist: GdsEntry[] = [
  {
    senderEmail:            'info@kft.travel',
    source:                 'amadeus',
    requireAttachmentMatch: true,
    // Gmail stores the sender as info@kft.travel; the Amadeus relay domain
    // (doc.mail.amadeus.com) appears only in envelope/Received headers which
    // are not captured in inbox_emails.from_email. We use
    // has_confirmation_attachment = true as the attachment proxy check
    // (itinerary.pdf filename matching is not feasible at batch-submit time
    // without downloading attachments).
  },
  {
    senderEmail:            'reservations.singapore@lhw.com',
    source:                 'lhw',
    requireAttachmentMatch: false,
  },
]

export interface GdsMatch {
  matched: boolean
  source?: string
}

/**
 * Check whether from_email matches a GDS whitelist entry, respecting the
 * attachment requirement for ambiguous senders.
 *
 * When requireAttachmentMatch = true and hasConfirmationAttachment = false,
 * returns { matched: false } so the caller falls through to normal tag flow.
 */
export function matchGdsWhitelist(
  fromEmail: string,
  hasConfirmationAttachment: boolean,
): GdsMatch {
  const from = fromEmail.toLowerCase().trim()
  for (const entry of gdsWhitelist) {
    if (from !== entry.senderEmail.toLowerCase()) continue
    if (entry.requireAttachmentMatch && !hasConfirmationAttachment) {
      return { matched: false }
    }
    return { matched: true, source: entry.source }
  }
  return { matched: false }
}
