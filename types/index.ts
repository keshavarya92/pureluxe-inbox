export type EmailCategory =
  | 'booking'
  | 'enquiry'
  | 'client'
  | 'supplier'
  | 'finance'
  | 'ops'
  | 'pre_stay'
  | 'dispute'
  | 'noise'

export type ActionPriority = 'urgent' | 'high' | 'normal' | 'low' | 'none'

export interface ClassifiedEmail {
  id: string
  threadId: string
  subject: string
  from: string
  fromName: string
  to: string[]
  cc: string[]
  date: string
  snippet: string
  body?: string
  unread: boolean

  // Classification — present on legacy emails, absent on newly synced ones
  category?: EmailCategory
  tags?: string[]
  summary?: string
  actionRequired?: boolean
  actionPriority?: ActionPriority
  actionDescription?: string
  unansweredHours?: number

  // Legacy JSONB extraction fields (present on older emails)
  booking?: {
    clientName?: string
    property?: string
    checkIn?: string
    checkOut?: string
    nights?: number
    rooms?: number
    guests?: number
    roomType?: string
    confirmationNumber?: string
    gdsRef?: string
    totalAmount?: number
    currency?: string
    netAmount?: number
    commissionRate?: number
    commissionAmount?: number
    status?: string
    cancellationDeadline?: string
    cancellationPolicy?: string
    paymentStatus?: string
    supplier?: string
    supplierEmail?: string
    programme?: string
  }
  finance?: {
    amount?: number
    currency?: string
    type?: string
    reference?: string
    dueDate?: string
  }
  supplierContact?: {
    name?: string
    email?: string
    property?: string
    consortium?: string
  }
}

export interface SyncResult {
  total: number
  stored: number
  errors: number
  timestamp: string
}

export interface InboxStats {
  total: number
  unread: number
}
