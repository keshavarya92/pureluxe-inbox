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

export type EmailStatus = 'unread' | 'read' | 'actioned'

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

  // Classification
  category: EmailCategory
  tags: EmailCategory[]
  summary: string
  actionRequired: boolean
  actionPriority: ActionPriority
  actionDescription?: string
  unansweredHours?: number

  // Extracted booking data (if category === 'booking')
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
    status?: 'enquiry' | 'quote' | 'option' | 'confirmed' | 'cancelled' | 'completed'
    cancellationDeadline?: string
    cancellationPolicy?: string
    paymentStatus?: 'unpaid' | 'deposit' | 'part_paid' | 'fully_paid'
    supplier?: string
    supplierEmail?: string
    programme?: string // for wellness bookings
  }

  // Extracted financial data
  finance?: {
    amount?: number
    currency?: string
    type?: 'invoice' | 'payment' | 'cancellation' | 'refund' | 'deposit'
    reference?: string
    dueDate?: string
  }

  // Supplier info
  supplierContact?: {
    name?: string
    email?: string
    property?: string
    consortium?: string
  }
}

export interface SyncResult {
  total: number
  classified: number
  bookings: number
  actionRequired: number
  errors: number
  timestamp: string
}

export interface InboxStats {
  total: number
  unread: number
  actionRequired: number
  bookings: number
  urgent: number
  byCategory: Record<EmailCategory, number>
}
