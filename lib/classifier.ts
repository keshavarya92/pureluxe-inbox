// Classification pipeline removed.
// Emails are stored as raw and processed entirely by the extraction agent (lib/extract.ts).
// These stubs exist so the /api/classify route compiles without changes.

import type { RawEmail } from './gmail'
import type { ClassifiedEmail } from '@/types'

function rawToClassified(email: RawEmail): ClassifiedEmail {
  return {
    id:            email.id,
    threadId:      email.threadId,
    subject:       email.subject,
    from:          email.from,
    fromName:      email.fromName,
    to:            email.to,
    cc:            email.cc,
    date:          email.date,
    snippet:       email.snippet,
    body:          email.body,
    unread:        email.unread,
    category:      'ops',
    tags:          [],
    summary:       '',
    actionRequired: false,
    actionPriority: 'none',
  }
}

export async function classifyEmail(email: RawEmail): Promise<ClassifiedEmail> {
  return rawToClassified(email)
}

export async function classifyBatch(emails: RawEmail[]): Promise<ClassifiedEmail[]> {
  return emails.map(rawToClassified)
}
