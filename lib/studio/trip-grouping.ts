import type { Booking, Client, QueueBooking, DuplicateWarning, TripSuggestion, MissingField, TripGroup } from './types'

// Required fields for a booking to be approvable
const REQUIRED_FIELDS: Array<{ field: keyof Booking; label: string }> = [
  { field: 'hotel_name',  label: 'Hotel name' },
  { field: 'check_in',   label: 'Check-in date' },
  { field: 'check_out',  label: 'Check-out date' },
]

// Optional but flagged fields
const OPTIONAL_FIELDS: Array<{ field: keyof Booking; label: string }> = [
  { field: 'total_cost',            label: 'Total cost' },
  { field: 'cancellation_deadline', label: 'Cancellation deadline' },
  { field: 'currency',              label: 'Currency' },
]

// Returns true if the booking has at least one reference number
export function hasBookingRef(booking: Booking): boolean {
  return !!(
    booking.amadeus_ref ||
    booking.hotel_ref ||
    booking.lhw_ref ||
    booking.ottila_ref ||
    booking.onyx_ref
  )
}

// Compute missing fields for a booking
function computeMissingFields(booking: Booking): {
  missing_required: MissingField[]
  missing_optional: MissingField[]
} {
  const missing_required: MissingField[] = []
  const missing_optional: MissingField[] = []

  // Check required scalar fields
  for (const { field, label } of REQUIRED_FIELDS) {
    if (!booking[field]) {
      missing_required.push({ field, label, required: true })
    }
  }

  // Must have client_id linked
  if (!booking.client_id) {
    missing_required.push({ field: 'client_id', label: 'Client', required: true })
  }

  // Must have at least one ref
  if (!hasBookingRef(booking)) {
    missing_required.push({ field: 'amadeus_ref', label: 'Booking reference', required: true })
  }

  // Optional fields
  for (const { field, label } of OPTIONAL_FIELDS) {
    if (!booking[field]) {
      missing_optional.push({ field, label, required: false })
    }
  }

  return { missing_required, missing_optional }
}

// Detect duplicate warnings across all pending bookings
function computeDuplicateWarning(
  booking: Booking & { client: Client | null },
  allBookings: Array<Booking & { client: Client | null }>,
): DuplicateWarning | null {
  // Check same hotel_ref on another booking
  if (booking.hotel_ref) {
    const dup = allBookings.find(b =>
      b.id !== booking.id &&
      b.hotel_ref === booking.hotel_ref
    )
    if (dup) {
      return {
        type: 'same_ref',
        message: `Same hotel ref (${booking.hotel_ref}) exists on another booking`,
        related_booking_id: dup.id,
        related_booking_hotel: dup.hotel_name ?? undefined,
        related_booking_dates: dup.check_in && dup.check_out
          ? `${dup.check_in} – ${dup.check_out}`
          : undefined,
      }
    }
  }

  // Check same amadeus_ref on another booking
  if (booking.amadeus_ref) {
    const dup = allBookings.find(b =>
      b.id !== booking.id &&
      b.amadeus_ref === booking.amadeus_ref &&
      b.hotel_name === booking.hotel_name
    )
    if (dup) {
      return {
        type: 'same_ref',
        message: `Same PNR (${booking.amadeus_ref}) and hotel on another booking`,
        related_booking_id: dup.id,
        related_booking_hotel: dup.hotel_name ?? undefined,
        related_booking_dates: dup.check_in && dup.check_out
          ? `${dup.check_in} – ${dup.check_out}`
          : undefined,
      }
    }
  }

  // Check client name variants
  if (booking.client?.normalized_name) {
    const variants = allBookings.filter(b =>
      b.id !== booking.id &&
      b.client?.normalized_name === booking.client?.normalized_name
    )
    if (variants.length > 0) {
      return {
        type: 'client_variants',
        message: `${variants.length + 1} records found with similar client name`,
        variant_count: variants.length + 1,
      }
    }
  }

  return null
}

// Detect trip grouping suggestions
function computeTripSuggestion(
  booking: Booking,
  allBookings: Array<Booking & { client: Client | null }>,
): TripSuggestion | null {
  if (!booking.client_id) return null
  if (booking.trip_suggestion_dismissed) return null

  // Same PNR — different hotel, same client
  if (booking.amadeus_ref) {
    const samePnr = allBookings.filter(b =>
      b.id !== booking.id &&
      b.client_id === booking.client_id &&
      b.amadeus_ref === booking.amadeus_ref &&
      b.hotel_name !== booking.hotel_name
    )
    if (samePnr.length > 0) {
      const tripId = booking.suggested_trip_id ?? crypto.randomUUID()
      const hotels = [booking.hotel_name, ...samePnr.map(b => b.hotel_name)]
        .filter(Boolean)
        .join(' → ')
      return {
        suggested_trip_id: tripId,
        reason: 'same_pnr',
        trip_label: hotels,
        related_booking_ids: [booking.id, ...samePnr.map(b => b.id)],
      }
    }
  }

  // Same group_name
  if (booking.group_name) {
    const sameGroup = allBookings.filter(b =>
      b.id !== booking.id &&
      b.group_name === booking.group_name
    )
    if (sameGroup.length > 0) {
      const tripId = booking.suggested_trip_id ?? crypto.randomUUID()
      return {
        suggested_trip_id: tripId,
        reason: 'same_group_name',
        trip_label: booking.group_name,
        related_booking_ids: [booking.id, ...sameGroup.map(b => b.id)],
      }
    }
  }

  // Consecutive dates — same client, check_in within 1 day of another booking's check_out
  if (booking.check_in && booking.client_id) {
    const checkIn = new Date(booking.check_in)
    const consecutive = allBookings.find(b => {
      if (b.id === booking.id || b.client_id !== booking.client_id || !b.check_out) return false
      const checkOut = new Date(b.check_out)
      const diffDays = Math.abs(checkIn.getTime() - checkOut.getTime()) / (1000 * 60 * 60 * 24)
      return diffDays <= 1
    })
    if (consecutive) {
      const tripId = booking.suggested_trip_id ?? crypto.randomUUID()
      const hotels = [consecutive.hotel_name, booking.hotel_name]
        .filter(Boolean)
        .join(' → ')
      return {
        suggested_trip_id: tripId,
        reason: 'consecutive_dates',
        trip_label: hotels,
        related_booking_ids: [consecutive.id, booking.id],
      }
    }
  }

  return null
}

// Main enrichment function — takes raw bookings, returns QueueBookings
export function computeQueueEnrichment(
  bookings: Array<Booking & { client: Client | null }>,
): QueueBooking[] {
  return bookings.map(booking => {
    const { missing_required, missing_optional } = computeMissingFields(booking)
    const duplicate_warning = computeDuplicateWarning(booking, bookings)
    const trip_suggestion = computeTripSuggestion(booking, bookings)

    return {
      ...booking,
      missing_required,
      missing_optional,
      duplicate_warning,
      trip_suggestion,
    }
  })
}

// ----------------------------------------------------------------
// Trip grouping for Trips view
// ----------------------------------------------------------------

// Group confirmed bookings into TripGroup objects.
// Grouping priority:
// 1. Same trip_id (explicit)
// 2. Same group_name (explicit group)
// 3. Same client_name + consecutive dates (check_in within 1 day of another leg's check_out)
// 4. Ungrouped — each booking is its own trip

export function groupBookingsIntoTrips(bookings: Booking[]): TripGroup[] {
  const used = new Set<string>()
  const groups: TripGroup[] = []

  // Sort by client_name then check_in
  const sorted = [...bookings].sort((a, b) => {
    const nameCompare = (a.client_name ?? '').localeCompare(b.client_name ?? '')
    if (nameCompare !== 0) return nameCompare
    return (a.check_in ?? '').localeCompare(b.check_in ?? '')
  })

  for (const booking of sorted) {
    if (used.has(booking.id)) continue

    // Find all legs that belong with this booking
    const legs: Booking[] = [booking]
    used.add(booking.id)

    for (const other of sorted) {
      if (used.has(other.id)) continue

      const belongs =
        // Same trip_id
        (booking.trip_id && other.trip_id && booking.trip_id === other.trip_id) ||
        // Same group_name
        (booking.group_name && other.group_name && booking.group_name === other.group_name) ||
        // Same client_name + consecutive dates
        (
          booking.client_name &&
          other.client_name &&
          booking.client_name.toLowerCase().trim() === other.client_name.toLowerCase().trim() &&
          isConsecutive(legs, other)
        )

      if (belongs) {
        legs.push(other)
        used.add(other.id)
      }
    }

    // Sort legs by check_in
    legs.sort((a, b) => (a.check_in ?? '').localeCompare(b.check_in ?? ''))

    groups.push(buildTripGroup(legs))
  }

  // Sort groups by earliest check_in
  return groups.sort((a, b) => a.earliest_check_in.localeCompare(b.earliest_check_in))
}

function isConsecutive(existingLegs: Booking[], candidate: Booking): boolean {
  if (!candidate.check_in) return false
  return existingLegs.some(leg => {
    if (!leg.check_out) return false
    const legOut  = new Date(leg.check_out)
    const candIn  = new Date(candidate.check_in!)
    const diffMs  = Math.abs(candIn.getTime() - legOut.getTime())
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    return diffDays <= 1
  })
}

function buildTripGroup(legs: Booking[]): TripGroup {
  const earliest = legs[0].check_in ?? ''
  const latest   = legs[legs.length - 1].check_out ?? ''
  const cities   = [...new Set(legs.map(l => l.city).filter(Boolean) as string[])]

  const mostUrgent = legs
    .map(l => l.cancellation_deadline)
    .filter(Boolean)
    .sort()[0] ?? null

  return {
    key: legs.map(l => l.id).join('-'),
    display_name:      legs[0].group_name ?? legs[0].client_name ?? 'Unknown',
    client_name:       legs[0].client_name ?? '',
    group_name:        legs[0].group_name ?? null,
    legs,
    earliest_check_in: earliest,
    latest_check_out:  latest,
    total_nights:      legs.reduce((sum, l) => sum + (l.nights ?? 0), 0),
    cities,
    vip_flag:          legs.some(l => l.vip_flag),
    vvip_flag:         legs.some(l => l.vvip_flag),
    special_occasion:  legs.find(l => l.special_occasion)?.special_occasion ?? null,
    is_group_booking:  legs.some(l => l.is_group_booking),
    is_multi_leg:      legs.length > 1,
    most_urgent_deadline: mostUrgent,
  }
}
