import { supabase } from '@/lib/supabase'
import type { Booking, Client, QueueBooking, ClientRecord, QueueClient, MissingField } from './types'
import { computeQueueEnrichment } from './trip-grouping'

// ----------------------------------------------------------------
// Queue — bookings
// ----------------------------------------------------------------

// Fetch all pending_review bookings created on or after the cutoff.
// Joins client data where client_id is set.
export async function getPendingBookings(): Promise<QueueBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      *,
      client:clients!client_id (
        id, full_name, email, phone, normalized_name,
        reviewed_by, reviewed_at, created_at
      )
    `)
    .eq('status', 'pending_review')
    .gte('created_at', '2026-06-27T00:00:00.000Z')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`getPendingBookings: ${error.message}`)

  const bookings = (data ?? []) as Array<Booking & { client: Client | null }>

  // Enrich with warnings and suggestions
  return computeQueueEnrichment(bookings)
}

// Count pending_review bookings — used for sidebar badge
export async function getPendingBookingCount(): Promise<number> {
  const { count, error } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending_review')
    .gte('created_at', '2026-06-27T00:00:00.000Z')

  if (error) return 0
  return count ?? 0
}

// ----------------------------------------------------------------
// Queue — actions
// ----------------------------------------------------------------

// Approve a booking — sets status to confirmed + records reviewer
export async function approveBooking(
  id: string,
  reviewedBy: string,
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      status: 'confirmed',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) throw new Error(`approveBooking: ${error.message}`)
}

// Reject a booking — soft delete, sets status to rejected
export async function rejectBooking(id: string): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      status: 'rejected',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) throw new Error(`rejectBooking: ${error.message}`)
}

// Update specific fields on a pending booking (inline edit)
export async function updateBookingFields(
  id: string,
  fields: Partial<Pick<Booking,
    | 'client_name'
    | 'hotel_name'
    | 'city'
    | 'country'
    | 'check_in'
    | 'check_out'
    | 'total_cost'
    | 'currency'
    | 'amadeus_ref'
    | 'hotel_ref'
    | 'lhw_ref'
    | 'ottila_ref'
    | 'onyx_ref'
    | 'cancellation_deadline'
    | 'cancellation_policy'
    | 'booking_source'
    | 'num_rooms'
    | 'num_adults'
    | 'commission_rate'
    | 'special_occasion'
    | 'vip_flag'
    | 'notes'
  >>,
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new Error(`updateBookingFields: ${error.message}`)
}

// Assign a trip_id to a booking (accepts grouping suggestion)
export async function assignTripId(
  bookingId: string,
  tripId: string,
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      trip_id: tripId,
      suggested_trip_id: null,
      trip_suggestion_dismissed: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)

  if (error) throw new Error(`assignTripId: ${error.message}`)
}

// Dismiss trip grouping suggestion without accepting
export async function dismissTripSuggestion(bookingId: string): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      trip_suggestion_dismissed: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)

  if (error) throw new Error(`dismissTripSuggestion: ${error.message}`)
}

// ----------------------------------------------------------------
// Queue — clients
// ----------------------------------------------------------------

export async function getPendingClients(): Promise<QueueClient[]> {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .is('reviewed_at', null)
    .gte('created_at', '2026-06-27T00:00:00.000Z')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`getPendingClients: ${error.message}`)

  const clients = (data ?? []) as ClientRecord[]

  return Promise.all(clients.map(async (client) => {
    const missing_required = computeClientMissingFields(client)

    const { count } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
    const booking_count = count ?? 0

    const duplicate_warning = await findSimilarClient(client)

    return {
      ...client,
      missing_required,
      booking_count,
      duplicate_warning,
    }
  }))
}

export async function getPendingClientCount(): Promise<number> {
  const { count, error } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .is('reviewed_at', null)
    .gte('created_at', '2026-06-27T00:00:00.000Z')

  if (error) return 0
  return count ?? 0
}

function computeClientMissingFields(client: ClientRecord): MissingField[] {
  const missing: MissingField[] = []
  if (!client.full_name) missing.push({ field: 'full_name', label: 'Full name', required: true })
  if (!client.phone && !client.email) {
    missing.push({ field: 'phone', label: 'Phone or email', required: true })
  }
  return missing
}

async function findSimilarClient(
  client: ClientRecord,
): Promise<import('./types').ClientDuplicateWarning | null> {
  if (!client.normalized_name) return null

  try {
    const { data, error } = await supabase.rpc('find_similar_clients', {
      input_name: client.normalized_name,
      threshold: 0.65,
    })
    if (error || !data?.length) return null

    const similar = (data as Array<{ id: string; sim: number }>)
      .filter(r => r.id !== client.id)

    if (!similar.length) return null

    const top = similar[0]

    const { data: similarRow } = await supabase
      .from('clients')
      .select('full_name')
      .eq('id', top.id)
      .single()

    if (!similarRow) return null

    return {
      message: `Similar client already exists`,
      similar_client_id: top.id,
      similar_client_name: similarRow.full_name,
      similarity_score: top.sim,
    }
  } catch {
    return null
  }
}

export async function approveClient(id: string, reviewedBy: string): Promise<void> {
  const { error } = await supabase
    .from('clients')
    .update({
      active: true,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) throw new Error(`approveClient: ${error.message}`)
}

export async function rejectClient(id: string, reviewedBy: string): Promise<void> {
  const { error } = await supabase
    .from('clients')
    .update({
      active: false,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) throw new Error(`rejectClient: ${error.message}`)
}

export async function updateClientFields(
  id: string,
  fields: Partial<Pick<ClientRecord,
    | 'full_name'
    | 'email'
    | 'phone'
    | 'whatsapp'
    | 'nationality'
    | 'city_of_residence'
    | 'vip_level'
    | 'general_notes'
  >>,
): Promise<void> {
  const { error } = await supabase
    .from('clients')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new Error(`updateClientFields: ${error.message}`)
}

// ----------------------------------------------------------------
// Home dashboard queries
// ----------------------------------------------------------------

export async function getTodayCheckins(): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('check_in', today)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: true })

  if (error) return []
  return (data ?? []) as Booking[]
}

export async function getTodayCheckouts(): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('check_out', today)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: true })

  if (error) return []
  return (data ?? []) as Booking[]
}

export async function getCancellationDeadlines(daysAhead = 7): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const future = new Date()
  future.setDate(future.getDate() + daysAhead)
  const futureStr = future.toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .gte('cancellation_deadline', today)
    .lte('cancellation_deadline', futureStr)
    .order('cancellation_deadline', { ascending: true })

  if (error) return []
  return (data ?? []) as Booking[]
}

export async function getPaymentsDue(): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const future = new Date()
  future.setDate(future.getDate() + 7)
  const futureStr = future.toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .gte('check_in', today)
    .lte('check_in', futureStr)
    .or('notes.ilike.%payment link%,notes.ilike.%deposit%,notes.ilike.%payit%,misc.ilike.%payment%')
    .order('check_in', { ascending: true })

  if (error) return []
  return (data ?? []) as Booking[]
}

export async function getUpcomingCheckins(daysAhead = 7): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const future = new Date()
  future.setDate(future.getDate() + daysAhead)
  const futureStr = future.toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .gt('check_in', today)
    .lte('check_in', futureStr)
    .order('check_in', { ascending: true })

  if (error) return []
  return (data ?? []) as Booking[]
}
