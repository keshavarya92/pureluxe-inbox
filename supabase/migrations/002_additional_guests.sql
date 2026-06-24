-- 002_additional_guests.sql
-- Adds additional_guest_ids to bookings for multi-guest email extraction.
-- Each element is a client UUID resolved from name patterns in the email body.
-- The lead client (client_id) is never duplicated here.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS additional_guest_ids uuid[] NOT NULL DEFAULT '{}';

-- GIN index for efficient containment queries (@> / <@)
CREATE INDEX IF NOT EXISTS bookings_additional_guest_ids_gin
  ON bookings USING gin (additional_guest_ids);
