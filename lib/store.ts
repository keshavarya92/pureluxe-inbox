import type { ClassifiedEmail, InboxStats } from '@/types'

// In-memory store - will be replaced with Supabase in Phase 2
// Uses a Map for O(1) lookups by email ID

class EmailStore {
  private emails: Map<string, ClassifiedEmail> = new Map()
  private lastSync: Date | null = null
  private syncInProgress: boolean = false

  set(email: ClassifiedEmail) {
    this.emails.set(email.id, email)
  }

  setMany(emails: ClassifiedEmail[]) {
    for (const email of emails) {
      this.emails.set(email.id, email)
    }
    this.lastSync = new Date()
  }

  get(id: string): ClassifiedEmail | undefined {
    return this.emails.get(id)
  }

  getAll(): ClassifiedEmail[] {
    return Array.from(this.emails.values()).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    )
  }

  getByCategory(category: string): ClassifiedEmail[] {
    if (category === 'all') return this.getAll()
    if (category === 'action') return this.getAll().filter(e => e.actionRequired)
    return this.getAll().filter(e => e.category === category)
  }

  getStats(): InboxStats {
    const all = this.getAll()
    const byCategory: any = {
      booking: 0, client: 0, supplier: 0, finance: 0,
      ops: 0, pre_stay: 0, dispute: 0, noise: 0,
    }

    for (const email of all) {
      if (byCategory[email.category] !== undefined) {
        byCategory[email.category]++
      }
    }

    return {
      total: all.length,
      unread: all.filter(e => e.unread).length,
      actionRequired: all.filter(e => e.actionRequired).length,
      bookings: all.filter(e => e.category === 'booking').length,
      urgent: all.filter(e => e.actionPriority === 'urgent').length,
      byCategory,
    }
  }

  setLastSync(date: Date) {
    this.lastSync = date
  }

  getLastSync(): Date | null {
    return this.lastSync
  }

  setSyncInProgress(val: boolean) {
    this.syncInProgress = val
  }

  isSyncing(): boolean {
    return this.syncInProgress
  }

  size(): number {
    return this.emails.size
  }

  clear() {
    this.emails.clear()
  }
}

// Singleton — persists across requests in the same Node.js process
const globalStore = global as any
if (!globalStore._emailStore) {
  globalStore._emailStore = new EmailStore()
}

export const store: EmailStore = globalStore._emailStore
