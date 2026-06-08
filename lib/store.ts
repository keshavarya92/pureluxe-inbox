import { supabase } from './supabase'
import type { ClassifiedEmail, EmailCategory, InboxStats } from '@/types'

// Transient state — fine to keep in-memory (no need to survive restarts)
let syncInProgress = false
let lastSync: Date | null = null

function toRow(e: ClassifiedEmail, inboxAddress = ''): Record<string, unknown> {
  return {
    id: e.id,
    thread_id: e.threadId,
    inbox_address: inboxAddress,
    subject: e.subject,
    from_email: e.from,
    from_name: e.fromName,
    to_addresses: e.to,
    cc_addresses: e.cc,
    email_date: e.date,
    snippet: e.snippet,
    body: e.body ?? null,
    unread: e.unread,
    category: e.category,
    tags: e.tags,
    summary: e.summary,
    action_required: e.actionRequired,
    action_priority: e.actionPriority,
    action_description: e.actionDescription ?? null,
    unanswered_hours: e.unansweredHours ?? null,
    booking: e.booking ?? null,
    finance: e.finance ?? null,
    supplier_contact: e.supplierContact ?? null,
  }
}

function fromRow(r: Record<string, any>): ClassifiedEmail {
  return {
    id: r.id,
    threadId: r.thread_id,
    subject: r.subject,
    from: r.from_email,
    fromName: r.from_name,
    to: r.to_addresses ?? [],
    cc: r.cc_addresses ?? [],
    date: r.email_date,
    snippet: r.snippet,
    body: r.body ?? undefined,
    unread: r.unread,
    category: r.category,
    tags: r.tags ?? [],
    summary: r.summary,
    actionRequired: r.action_required,
    actionPriority: r.action_priority,
    actionDescription: r.action_description ?? undefined,
    unansweredHours: r.unanswered_hours ?? undefined,
    booking: r.booking ?? undefined,
    finance: r.finance ?? undefined,
    supplierContact: r.supplier_contact ?? undefined,
  }
}

export const store = {
  // --- Write ---

  async set(email: ClassifiedEmail, inboxAddress = ''): Promise<void> {
    const { error } = await supabase
      .from('inbox_emails')
      .upsert(toRow(email, inboxAddress), { onConflict: 'id' })
    if (error) throw new Error(error.message)
  },

  async setMany(emails: ClassifiedEmail[], inboxAddress = ''): Promise<void> {
    if (emails.length === 0) return
    const { error } = await supabase
      .from('inbox_emails')
      .upsert(emails.map(e => toRow(e, inboxAddress)), { onConflict: 'id' })
    if (error) throw new Error(error.message)
    lastSync = new Date()
  },

  // --- Read ---

  async get(id: string): Promise<ClassifiedEmail | undefined> {
    const { data, error } = await supabase
      .from('inbox_emails')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data ? fromRow(data) : undefined
  },

  // Returns the subset of `ids` that already exist in the DB — used to skip re-classification
  async getExistingIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const { data, error } = await supabase.from('inbox_emails').select('id').in('id', ids)
    if (error) throw new Error(error.message)
    return new Set((data ?? []).map((r: { id: string }) => r.id))
  },

  async getByCategory(category: string, inboxAddress?: string): Promise<ClassifiedEmail[]> {
    let q = supabase.from('inbox_emails').select('*').order('email_date', { ascending: false })

    if (inboxAddress) q = q.eq('inbox_address', inboxAddress)

    if (category === 'action') {
      q = q.eq('action_required', true)
    } else if (category !== 'all') {
      q = q.eq('category', category)
    }

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data ?? []).map(fromRow)
  },

  async getStats(inboxAddress?: string): Promise<InboxStats> {
    let q = supabase
      .from('inbox_emails')
      .select('category, unread, action_required, action_priority')
    if (inboxAddress) q = q.eq('inbox_address', inboxAddress)
    const { data, error } = await q
    if (error) throw new Error(error.message)

    const all = data ?? []
    const byCategory: Record<string, number> = {
      booking: 0, client: 0, supplier: 0, finance: 0,
      ops: 0, pre_stay: 0, dispute: 0, noise: 0,
    }
    for (const r of all) {
      if (r.category in byCategory) byCategory[r.category]++
    }

    return {
      total: all.length,
      unread: all.filter(r => r.unread).length,
      actionRequired: all.filter(r => r.action_required).length,
      bookings: byCategory.booking,
      urgent: all.filter(r => r.action_priority === 'urgent').length,
      byCategory: byCategory as Record<EmailCategory, number>,
    }
  },

  async size(): Promise<number> {
    const { count, error } = await supabase
      .from('inbox_emails')
      .select('id', { count: 'exact', head: true })
    if (error) throw new Error(error.message)
    return count ?? 0
  },

  // --- Sync state (in-memory) ---

  isSyncing: () => syncInProgress,
  setSyncInProgress: (val: boolean) => { syncInProgress = val },
  getLastSync: () => lastSync,
  setLastSync: (date: Date) => { lastSync = date },
}
