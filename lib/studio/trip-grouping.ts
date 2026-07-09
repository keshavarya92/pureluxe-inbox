import type { Booking, Client, QueueBooking, DuplicateWarning, TripSuggestion, MissingField } from './types'

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
