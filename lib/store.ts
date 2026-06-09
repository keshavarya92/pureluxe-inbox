import { supabase } from './supabase'
import type { RawEmail } from './gmail'
import type { ClassifiedEmail, InboxStats } from '@/types'

let syncInProgress = false
let lastSync: Date | null = null

const ATTACHMENT_PHRASES = /please find attached|kindly find attached|confirmation letter attached|please see attached|booking confirmation attached|voucher attached|find the confirmation|attached herewith|enclosed herewith/i

function parseReceivedAt(dateStr: string): string {
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function hasAttachmentPhrase(e: RawEmail): boolean {
  return ATTACHMENT_PHRASES.test(e.snippet) || ATTACHMENT_PHRASES.test(e.body ?? '')
}

function toRow(e: RawEmail, inboxAddress = ''): Record<string, unknown> {
  return {
    id:            e.id,
    thread_id:     e.threadId,
    inbox_address: inboxAddress,
    received_at:   parseReceivedAt(e.date),
    subject:       e.subject,
    from_email:    e.from,
    from_name:     e.fromName,
    to_addresses:  e.to,
    cc_addresses:  e.cc,
    email_date:    e.date,
    snippet:       e.snippet,
    body:          e.body ?? null,
    unread:        e.unread,
    // Placeholder values — classification pipeline removed; columns kept for legacy data
    category:         'unclassified',
    tags:             [],
    summary:          '',
    action_required:  false,
    action_priority:  'none',
    booking_extracted:           false,
    has_confirmation_attachment: hasAttachmentPhrase(e),
  }
}

function fromRow(r: Record<string, any>): ClassifiedEmail {
  return {
    id:        r.id,
    threadId:  r.thread_id,
    subject:   r.subject,
    from:      r.from_email,
    fromName:  r.from_name,
    to:        r.to_addresses ?? [],
    cc:        r.cc_addresses ?? [],
    date:      r.email_date,
    snippet:   r.snippet,
    body:      r.body ?? undefined,
    unread:    r.unread,
    category:  r.category ?? undefined,
    tags:      r.tags ?? [],
    summary:   r.summary ?? undefined,
    actionRequired:   r.action_required  ?? false,
    actionPriority:   r.action_priority  ?? 'none',
    actionDescription: r.action_description ?? undefined,
    unansweredHours:   r.unanswered_hours ?? undefined,
    booking:        r.booking        ?? undefined,
    finance:        r.finance        ?? undefined,
    supplierContact: r.supplier_contact ?? undefined,
  }
}

export const store = {
  async set(email: RawEmail, inboxAddress = ''): Promise<void> {
    const { error } = await supabase
      .from('inbox_emails')
      .upsert(toRow(email, inboxAddress), { onConflict: 'id' })
    if (error) throw new Error(error.message)
  },

  async setMany(emails: RawEmail[], inboxAddress = ''): Promise<void> {
    if (emails.length === 0) return
    const { error } = await supabase
      .from('inbox_emails')
      .upsert(emails.map(e => toRow(e, inboxAddress)), { onConflict: 'id' })
    if (error) throw new Error(error.message)
    lastSync = new Date()
  },

  async get(id: string): Promise<ClassifiedEmail | undefined> {
    const { data, error } = await supabase
      .from('inbox_emails').select('*').eq('id', id).maybeSingle()
    if (error) throw new Error(error.message)
    return data ? fromRow(data) : undefined
  },

  async getExistingIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const { data, error } = await supabase.from('inbox_emails').select('id').in('id', ids)
    if (error) throw new Error(error.message)
    return new Set((data ?? []).map((r: { id: string }) => r.id))
  },

  async getByCategory(_category: string, inboxAddress?: string): Promise<ClassifiedEmail[]> {
    let q = supabase.from('inbox_emails').select('*').order('email_date', { ascending: false })
    if (inboxAddress) q = q.eq('inbox_address', inboxAddress)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data ?? []).map(fromRow)
  },

  async getStats(inboxAddress?: string): Promise<InboxStats> {
    let q = supabase.from('inbox_emails').select('unread')
    if (inboxAddress) q = q.eq('inbox_address', inboxAddress)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    const all = data ?? []
    return {
      total:  all.length,
      unread: all.filter((r: { unread: boolean }) => r.unread).length,
    }
  },

  async size(): Promise<number> {
    const { count, error } = await supabase
      .from('inbox_emails').select('id', { count: 'exact', head: true })
    if (error) throw new Error(error.message)
    return count ?? 0
  },

  isSyncing:        () => syncInProgress,
  setSyncInProgress: (val: boolean) => { syncInProgress = val },
  getLastSync:      () => lastSync,
  setLastSync:      (date: Date) => { lastSync = date },
}
