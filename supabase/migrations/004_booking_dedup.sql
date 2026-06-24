-- Phase 2: thread-scoped booking dedup + conflict flag table

-- Partial unique index: one booking per (thread, client, check_in, check_out).
-- Only applies to rows where both source_thread_id and client_id are non-null.
-- Legacy rows (no thread_id) and manual entries are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_thread_client_stay_dedup
  ON bookings (source_thread_id, client_id, check_in, check_out)
  WHERE source_thread_id IS NOT NULL AND client_id IS NOT NULL;

-- Queryable log of same-thread / same-dates / different-client_id conflicts.
-- Written by resolveBooking when a new booking is inserted into a thread that
-- already contains another booking for the same stay with a different client_id.
-- These are potential false splits from resolveClient name ambiguity; review
-- each row before merging clients.
CREATE TABLE IF NOT EXISTS booking_conflict_flags (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id        text        NOT NULL,
  new_booking_id   uuid,
  new_client_id    uuid,
  conflicting_ids  uuid[],
  check_in         date,
  check_out        date,
  reason           text        NOT NULL,
  reviewed         boolean     NOT NULL DEFAULT false,
  reviewed_at      timestamptz,
  resolution       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Allow the extraction pipeline (service_role) to read and write conflict flags
GRANT SELECT, INSERT, UPDATE ON booking_conflict_flags TO service_role;
