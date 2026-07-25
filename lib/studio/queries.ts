import { supabase } from '@/lib/supabase'
import type { Booking, Client, QueueBooking, ClientRecord, QueueClient, MissingField, RelationshipContact, Family, FamilyMember, FamilyWithMembers, FamilyMemberRole, ClientProfile } from './types'
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
    | 'client_id'
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
    const [duplicate_warning, relationship_via] = await Promise.all([
      findSimilarClient(client),
      findRelationshipContact(client.id),
    ])

    let missing_required = computeClientMissingFields(client)
    if (relationship_via) {
      missing_required = missing_required.filter(f => f.field !== 'phone')
    }

    const { count } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
    const booking_count = count ?? 0

    return {
      ...client,
      missing_required,
      booking_count,
      duplicate_warning,
      relationship_via,
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

// Find a linked client who can be reached on this client's behalf
// (e.g. a child's record linked to their mother's contact details).
// Checks both relationship directions; returns the first linked client
// that actually has a phone or email.
async function findRelationshipContact(clientId: string): Promise<RelationshipContact | null> {
  const { data: links } = await supabase
    .from('client_relationships')
    .select('primary_client_id, related_client_id, relationship_type')
    .or(`primary_client_id.eq.${clientId},related_client_id.eq.${clientId}`)

  if (!links?.length) return null

  for (const link of links) {
    const otherId = link.primary_client_id === clientId ? link.related_client_id : link.primary_client_id
    if (!otherId) continue

    const { data: other } = await supabase
      .from('clients')
      .select('id, full_name, phone, email')
      .eq('id', otherId)
      .maybeSingle()

    if (other && (other.phone || other.email)) {
      return {
        client_id: other.id,
        client_name: other.full_name,
        relationship_type: link.relationship_type ?? 'related',
      }
    }
  }

  return null
}

// Link a client to a contactable relative/associate so the reviewer can
// approve them without fabricating contact details (e.g. a child linked
// to their mother). contactClientId must already have a phone or email.
export async function linkClientRelationship(
  dependentClientId: string,
  contactClientId: string,
  relationshipType: string,
  notes?: string | null,
): Promise<void> {
  const { error } = await supabase.from('client_relationships').insert({
    primary_client_id: contactClientId,
    related_client_id: dependentClientId,
    relationship_type:  relationshipType,
    notes:               notes ?? null,
  })

  if (error) throw new Error(`linkClientRelationship: ${error.message}`)
}

// Simple name search for the relationship-link picker.
export async function searchClients(
  query: string,
  excludeId?: string,
): Promise<Array<Pick<ClientRecord, 'id' | 'full_name' | 'phone' | 'email'>>> {
  if (!query.trim()) return []

  let q = supabase
    .from('clients')
    .select('id, full_name, phone, email')
    .ilike('full_name', `%${query}%`)
    .limit(8)
  if (excludeId) q = q.neq('id', excludeId)

  const { data, error } = await q
  if (error) throw new Error(`searchClients: ${error.message}`)
  return data ?? []
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

// ----------------------------------------------------------------
// Trips queries
// ----------------------------------------------------------------

export async function getActiveTrips(): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .lte('check_in', today)
    .gte('check_out', today)
    .order('check_in', { ascending: true })

  if (error) throw new Error(`getActiveTrips: ${error.message}`)
  return (data ?? []) as Booking[]
}

export async function getUpcomingTrips(): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .gt('check_in', today)
    .order('check_in', { ascending: true })

  if (error) throw new Error(`getUpcomingTrips: ${error.message}`)
  return (data ?? []) as Booking[]
}

export async function getPastTrips(): Promise<Booking[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .in('status', ['confirmed', 'checked_out'])
    .lt('check_out', today)
    .order('check_out', { ascending: false })
    .limit(100)

  if (error) throw new Error(`getPastTrips: ${error.message}`)
  return (data ?? []) as Booking[]
}

export async function getBookingById(id: string): Promise<Booking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', id)
    .single()

  if (error) return null
  return data as Booking
}

export async function markBookingSuperseded(
  oldBookingId: string,
  newBookingId: string,
  reviewedBy: string,
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      status: 'superseded',
      amended_from: newBookingId,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', oldBookingId)

  if (error) throw new Error(`markBookingSuperseded: ${error.message}`)
}

// ----------------------------------------------------------------
// Clients tab queries
// ----------------------------------------------------------------

export async function searchClientDirectory(
  query: string,
  sort: 'name_asc' | 'name_desc' | 'last_booking' | 'spend_desc' | 'date_added' = 'name_asc',
  filter: 'all' | 'vip' | 'vvip' | 'has_family' | 'no_contact' = 'all',
): Promise<ClientRecord[]> {
  let q = supabase
    .from('clients')
    .select('*')
    .eq('active', true)

  if (query.trim()) {
    q = q.or(`full_name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`)
  }

  if (filter === 'vip')    q = q.eq('vip_level', 'vip')
  if (filter === 'vvip')   q = q.eq('vip_level', 'vvip')
  if (filter === 'no_contact') q = q.is('email', null).is('phone', null)

  if (sort === 'name_asc')  q = q.order('full_name', { ascending: true })
  if (sort === 'name_desc') q = q.order('full_name', { ascending: false })
  if (sort === 'date_added') q = q.order('created_at', { ascending: false })
  // last_booking and spend_desc handled client-side after join

  const { data, error } = await q.limit(100)
  if (error) throw new Error(`searchClientDirectory: ${error.message}`)
  return (data ?? []) as ClientRecord[]
}

export async function getClientProfile(id: string): Promise<ClientProfile | null> {
  // 1. Client record
  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !client) return null

  // 2. Bookings
  const { data: bookings } = await supabase
    .from('bookings')
    .select('*')
    .eq('client_id', id)
    .order('check_in', { ascending: false })

  const clientBookings = (bookings ?? []) as Booking[]

  // 3. Total spend
  const total_spend_usd = clientBookings.reduce((sum, b) => sum + (b.total_cost_usd ?? 0), 0)

  // 4. Family membership
  const { data: membership } = await supabase
    .from('family_members')
    .select('*, family:families(*)')
    .eq('client_id', id)
    .single()

  let family: FamilyWithMembers | null = null
  let family_role: FamilyMemberRole | null = null

  if (membership?.family) {
    family_role = membership.role as FamilyMemberRole

    // Get all family members
    const { data: allMembers } = await supabase
      .from('family_members')
      .select('*, client:clients(*)')
      .eq('family_id', membership.family_id)

    // Family spend
    const memberIds = (allMembers ?? []).map((m: any) => m.client_id)
    const { data: familyBookings } = await supabase
      .from('bookings')
      .select('total_cost_usd')
      .in('client_id', memberIds)

    const familySpend = (familyBookings ?? []).reduce((sum: number, b: any) => sum + (b.total_cost_usd ?? 0), 0)

    family = {
      ...membership.family,
      members: (allMembers ?? []) as FamilyMember[],
      total_spend_usd: familySpend,
      booking_count: familyBookings?.length ?? 0,
    }
  }

  // 5. Similar clients for merge suggestion
  const { data: similar } = await supabase
    .rpc('find_similar_clients', {
      input_name: client.normalized_name ?? client.full_name,
      threshold: 0.65,
    })

  const similar_clients = ((similar ?? []) as Array<{ id: string; sim: number }>)
    .filter(r => r.id !== id)
    .slice(0, 3)
    .map(r => ({
      id: r.id,
      full_name: '',
      similarity_score: r.sim,
    }))

  // 6. Family suggestions — same surname
  const surname = client.last_name ?? client.full_name.split(' ').pop() ?? ''
  const { data: surnameMatches } = await supabase
    .from('clients')
    .select('id, full_name')
    .neq('id', id)
    .ilike('full_name', `%${surname}%`)
    .eq('active', true)
    .limit(5)

  const family_suggestions = (surnameMatches ?? [])
    .filter((c: any) => !family?.members.some(m => m.client_id === c.id))
    .map((c: any) => ({
      client_id: c.id,
      full_name: c.full_name,
      reason: 'same_surname' as const,
    }))

  return {
    ...client,
    family,
    family_role,
    bookings: clientBookings,
    total_spend_usd,
    booking_count: clientBookings.length,
    similar_clients,
    family_suggestions,
  }
}

// ----------------------------------------------------------------
// Family queries
// ----------------------------------------------------------------

export async function createFamily(
  familyName: string,
  createdBy: string,
): Promise<Family> {
  const { data, error } = await supabase
    .from('families')
    .insert({ family_name: familyName, created_by: createdBy })
    .select()
    .single()

  if (error) throw new Error(`createFamily: ${error.message}`)
  return data as Family
}

export async function addFamilyMember(
  familyId: string,
  clientId: string,
  role: FamilyMemberRole,
  isPrimary: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('family_members')
    .upsert({
      family_id: familyId,
      client_id: clientId,
      role,
      is_primary: isPrimary,
    }, { onConflict: 'family_id,client_id' })

  if (error) throw new Error(`addFamilyMember: ${error.message}`)
}

export async function removeFamilyMember(
  familyId: string,
  clientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('family_members')
    .delete()
    .eq('family_id', familyId)
    .eq('client_id', clientId)

  if (error) throw new Error(`removeFamilyMember: ${error.message}`)
}

export async function searchFamilies(query: string): Promise<Family[]> {
  const { data, error } = await supabase
    .from('families')
    .select('*')
    .ilike('family_name', `%${query}%`)
    .order('family_name')
    .limit(10)

  if (error) return []
  return (data ?? []) as Family[]
}

export async function mergeClients(
  winnerId: string,
  loserId: string,
  reviewedBy: string,
): Promise<void> {
  // 1. Re-link bookings
  await supabase.from('bookings').update({ client_id: winnerId }).eq('client_id', loserId)

  // 2. Re-link family memberships
  await supabase.from('family_members').update({ client_id: winnerId }).eq('client_id', loserId)

  // 3. Re-link family booking members
  await supabase.from('family_booking_members').update({ client_id: winnerId }).eq('client_id', loserId)

  // 4. Mark loser as inactive
  const { error } = await supabase
    .from('clients')
    .update({
      active: false,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', loserId)

  if (error) throw new Error(`mergeClients: ${error.message}`)
}

export async function updateClientRecord(
  id: string,
  fields: Partial<Pick<ClientRecord,
    | 'full_name' | 'title' | 'first_name' | 'last_name'
    | 'email' | 'phone' | 'whatsapp'
    | 'nationality' | 'city_of_residence'
    | 'vip_level' | 'company'
    | 'general_notes' | 'internal_notes'
  >>,
): Promise<void> {
  const { error } = await supabase
    .from('clients')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new Error(`updateClientRecord: ${error.message}`)
}

// ----------------------------------------------------------------
// Bookings tab queries
// ----------------------------------------------------------------

export type BookingSort =
  | 'check_in_asc'
  | 'check_in_desc'
  | 'client_name_asc'
  | 'client_name_desc'
  | 'hotel_name_asc'
  | 'hotel_name_desc'
  | 'created_at_desc'
  | 'total_cost_desc'
  | 'total_cost_asc'

export type BookingStatusFilter =
  | 'all'
  | 'confirmed'
  | 'pending_review'
  | 'checked_out'
  | 'cancelled'
  | 'superseded'

export interface BookingsSearchParams {
  query?: string
  status?: BookingStatusFilter
  sort?: BookingSort
  booked_by?: string
  check_in_from?: string
  check_in_to?: string
  page?: number
  page_size?: number
}

export interface BookingsSearchResult {
  bookings: Booking[]
  total: number
  page: number
  page_size: number
}

export async function searchBookings(params: BookingsSearchParams): Promise<BookingsSearchResult> {
  const {
    query = '',
    status = 'all',
    sort = 'check_in_desc',
    check_in_from,
    check_in_to,
    page = 1,
    page_size = 50,
  } = params

  let q = supabase
    .from('bookings')
    .select('*', { count: 'exact' })

  // Status filter
  if (status !== 'all') {
    q = q.eq('status', status)
  } else {
    // Default: exclude rejected
    q = q.neq('status', 'rejected')
  }

  // Text search
  if (query.trim()) {
    q = q.or(
      `client_name.ilike.%${query}%,hotel_name.ilike.%${query}%,amadeus_ref.ilike.%${query}%,hotel_ref.ilike.%${query}%,city.ilike.%${query}%`
    )
  }

  // Date range
  if (check_in_from) q = q.gte('check_in', check_in_from)
  if (check_in_to)   q = q.lte('check_in', check_in_to)

  // Sort
  const sortMap: Record<BookingSort, { col: string; asc: boolean }> = {
    check_in_asc:     { col: 'check_in',     asc: true  },
    check_in_desc:    { col: 'check_in',     asc: false },
    client_name_asc:  { col: 'client_name',  asc: true  },
    client_name_desc: { col: 'client_name',  asc: false },
    hotel_name_asc:   { col: 'hotel_name',   asc: true  },
    hotel_name_desc:  { col: 'hotel_name',   asc: false },
    created_at_desc:  { col: 'created_at',   asc: false },
    total_cost_desc:  { col: 'total_cost',   asc: false },
    total_cost_asc:   { col: 'total_cost',   asc: true  },
  }
  const { col, asc } = sortMap[sort]
  q = q.order(col, { ascending: asc, nullsFirst: false })

  // Pagination
  const from = (page - 1) * page_size
  q = q.range(from, from + page_size - 1)

  const { data, error, count } = await q
  if (error) throw new Error(`searchBookings: ${error.message}`)

  return {
    bookings: (data ?? []) as Booking[],
    total: count ?? 0,
    page,
    page_size,
  }
}

// Flip confirmed bookings to checked_out once their check-out date has passed.
// Called daily by the cron; safe to re-run (only touches status='confirmed' rows).
export async function transitionExpiredBookings(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'checked_out', updated_at: new Date().toISOString() })
    .eq('status', 'confirmed')
    .lt('check_out', today)
    .select('id')

  if (error) throw new Error(`transitionExpiredBookings: ${error.message}`)
  return data?.length ?? 0
}

export async function getBookingWithClient(id: string): Promise<(Booking & { client: ClientRecord | null }) | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select(`*, client:clients!client_id(*)`)
    .eq('id', id)
    .single()

  if (error) return null
  return data as Booking & { client: ClientRecord | null }
}

export async function updateBookingFull(
  id: string,
  fields: Partial<Pick<Booking,
    | 'client_name' | 'client_id'
    | 'hotel_name' | 'city' | 'country' | 'chain'
    | 'check_in' | 'check_out'
    | 'num_rooms' | 'num_adults' | 'num_children'
    | 'total_cost' | 'currency' | 'total_cost_usd'
    | 'amadeus_ref' | 'hotel_ref' | 'lhw_ref' | 'ottila_ref' | 'onyx_ref'
    | 'booking_source' | 'booking_channel'
    | 'status'
    | 'cancellation_deadline' | 'cancellation_policy' | 'cancellation_date' | 'cancellation_reason'
    | 'commission_rate' | 'commission_expected' | 'commission_channel' | 'commissionable'
    | 'vip_flag' | 'vvip_flag' | 'special_occasion'
    | 'is_group_booking' | 'group_name'
    | 'notes' | 'internal_notes'
  >>,
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new Error(`updateBookingFull: ${error.message}`)
}

export async function mergeBookings(
  winnerId: string,
  loserId: string,
  reviewedBy: string,
): Promise<void> {
  // Mark loser as rejected, link to winner via amended_from
  const { error } = await supabase
    .from('bookings')
    .update({
      status: 'rejected',
      amended_from: winnerId,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', loserId)

  if (error) throw new Error(`mergeBookings: ${error.message}`)
}

export async function getDistinctBookedBy(): Promise<string[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('booked_by_name')
    .neq('booked_by_name', null)
    .order('booked_by_name')

  if (error) return []
  const names = [...new Set((data ?? []).map((r: any) => r.booked_by_name).filter(Boolean))]
  return names as string[]
}
