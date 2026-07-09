// Studio-specific types — do not conflict with types/index.ts

export type BookingStatus =
  | 'pending_review'
  | 'confirmed'
  | 'checked_out'
  | 'cancelled'
  | 'rejected'
  | 'enquiry'
  | 'pending'

// Raw booking row from Supabase — matches bookings table exactly
export interface Booking {
  id: string
  client_id: string | null
  client_name: string | null
  num_rooms: number | null
  num_adults: number | null
  num_children: number | null
  property_id: string | null
  hotel_name: string | null
  city: string | null
  country: string | null
  chain: string | null
  booked_by: string | null
  booked_by_name: string | null
  booking_source: string | null
  booking_channel: string | null
  amadeus_ref: string | null
  lhw_ref: string | null
  hotel_ref: string | null
  ottila_ref: string | null
  onyx_ref: string | null
  check_in: string | null
  check_out: string | null
  nights: number | null
  total_cost: number | null
  currency: string | null
  total_cost_usd: number | null
  commission_rate: number | null
  commission_expected: number | null
  commission_channel: string | null
  commissionable: boolean | null
  commission_negotiated: boolean | null
  status: BookingStatus
  cancellation_date: string | null
  cancellation_reason: string | null
  vip_flag: boolean
  vvip_flag: boolean
  special_occasion: string | null
  notes: string | null
  internal_notes: string | null
  is_group_booking: boolean
  group_name: string | null
  cancellation_deadline: string | null
  cancellation_policy: string | null
  email_id: string | null
  misc: string | null
  source_thread_id: string | null
  trip_id: string | null
  suggested_trip_id: string | null
  trip_suggestion_dismissed: boolean
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
}

// Client row — minimal shape needed for queue
export interface Client {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  normalized_name: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  active: boolean | null
}

// A booking in the queue — enriched with computed warnings
export interface QueueBooking extends Booking {
  // Linked client (if resolved)
  client?: Client | null
  // Missing required fields
  missing_required: MissingField[]
  // Missing optional but important fields
  missing_optional: MissingField[]
  // Duplicate warning if detected
  duplicate_warning: DuplicateWarning | null
  // Trip grouping suggestion if detected
  trip_suggestion: TripSuggestion | null
}

export interface MissingField {
  field: string
  label: string
  required: boolean
}

export interface DuplicateWarning {
  type: 'same_ref' | 'same_client_dates' | 'client_variants'
  message: string
  related_booking_id?: string
  related_booking_hotel?: string
  related_booking_dates?: string
  variant_count?: number
}

export interface TripSuggestion {
  suggested_trip_id: string
  reason: 'same_pnr' | 'consecutive_dates' | 'same_group_name'
  trip_label: string
  related_booking_ids: string[]
}

// Studio user from session
export interface StudioUser {
  email: string
  name: string
}

// Client row — full shape matching the clients table
export interface ClientRecord {
  id: string
  full_name: string
  title: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  whatsapp: string | null
  nationality: string | null
  city_of_residence: string | null
  vip_level: string | null
  company: string | null
  general_notes: string | null
  internal_notes: string | null
  active: boolean | null
  normalized_name: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
  misc: string | null
}

// A client in the queue — enriched with computed warnings
export interface QueueClient extends ClientRecord {
  missing_required: MissingField[]
  duplicate_warning: ClientDuplicateWarning | null
  booking_count: number
}

export interface ClientDuplicateWarning {
  message: string
  similar_client_id: string
  similar_client_name: string
  similarity_score: number
}
