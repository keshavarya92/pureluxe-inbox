-- ================================================================
-- 012_trip_builder_rename_trips.sql
-- Fixes a schema collision discovered during end-to-end testing:
-- migration 010's `CREATE TABLE IF NOT EXISTS trips` silently no-op'd
-- against a pre-existing, unrelated `trips` table (columns: id, name,
-- primary_client_id, group_name, start_date, end_date, destination,
-- status, owner, notes, misc, created_at, updated_at — not created by
-- any tracked migration, 0 rows, no application code references it).
-- Every FK meant for Trip Builder's trips table has actually been
-- pointing at that legacy table ever since, and Trip Builder's trips
-- table itself was missing `title`/`created_by`.
--
-- Fix: give Trip Builder its own table, trip_builder_trips, and
-- repoint every dependent FK at it. The legacy `trips` table is left
-- completely untouched — its origin isn't confirmed, so it isn't
-- this migration's place to alter or drop it.
--
-- Every Trip Builder table involved was confirmed empty (0 rows) at
-- the time this was written, so this is pure schema surgery — no data
-- migration needed. The verification block at the end aborts loudly
-- (rather than leaving a silent double-FK) if any of the guessed
-- default constraint names below turn out to be wrong.
-- Apply in Supabase SQL editor. Idempotent (safe to re-run).
-- ================================================================

CREATE TABLE IF NOT EXISTS trip_builder_trips (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_client_id  uuid        REFERENCES clients(id),
  status             text        NOT NULL DEFAULT 'building'
                        CHECK (status IN ('building','quoted','confirmed','itinerary_sent')),
  title              text,
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_builder_trips_primary_client_id
  ON trip_builder_trips(primary_client_id);

GRANT ALL ON trip_builder_trips TO service_role;

-- ----------------------------------------------------------------
-- Repoint FKs. Names below are Postgres's default auto-generated
-- names for inline `REFERENCES trips(id)` constraints declared in
-- migrations 010/011 (<table>_<column>_fkey) — verified below.
-- ----------------------------------------------------------------

ALTER TABLE trip_clients DROP CONSTRAINT IF EXISTS trip_clients_trip_id_fkey;
ALTER TABLE trip_clients ADD CONSTRAINT trip_clients_trip_id_fkey
  FOREIGN KEY (trip_id) REFERENCES trip_builder_trips(id) ON DELETE CASCADE;

ALTER TABLE trip_legs DROP CONSTRAINT IF EXISTS trip_legs_trip_id_fkey;
ALTER TABLE trip_legs ADD CONSTRAINT trip_legs_trip_id_fkey
  FOREIGN KEY (trip_id) REFERENCES trip_builder_trips(id) ON DELETE CASCADE;

ALTER TABLE trip_itinerary_days DROP CONSTRAINT IF EXISTS trip_itinerary_days_trip_id_fkey;
ALTER TABLE trip_itinerary_days ADD CONSTRAINT trip_itinerary_days_trip_id_fkey
  FOREIGN KEY (trip_id) REFERENCES trip_builder_trips(id) ON DELETE CASCADE;

ALTER TABLE trip_line_items DROP CONSTRAINT IF EXISTS trip_line_items_trip_id_fkey;
ALTER TABLE trip_line_items ADD CONSTRAINT trip_line_items_trip_id_fkey
  FOREIGN KEY (trip_id) REFERENCES trip_builder_trips(id) ON DELETE CASCADE;

ALTER TABLE trip_line_item_drafts DROP CONSTRAINT IF EXISTS trip_line_item_drafts_trip_id_fkey;
ALTER TABLE trip_line_item_drafts ADD CONSTRAINT trip_line_item_drafts_trip_id_fkey
  FOREIGN KEY (trip_id) REFERENCES trip_builder_trips(id) ON DELETE CASCADE;

ALTER TABLE trip_documents DROP CONSTRAINT IF EXISTS trip_documents_trip_id_fkey;
ALTER TABLE trip_documents ADD CONSTRAINT trip_documents_trip_id_fkey
  FOREIGN KEY (trip_id) REFERENCES trip_builder_trips(id) ON DELETE CASCADE;

ALTER TABLE trip_chat_messages DROP CONSTRAINT IF EXISTS trip_chat_messages_trip_id_fkey;
ALTER TABLE trip_chat_messages ADD CONSTRAINT trip_chat_messages_trip_id_fkey
  FOREIGN KEY (trip_id) REFERENCES trip_builder_trips(id) ON DELETE CASCADE;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_booking_trip_id_fkey;
ALTER TABLE bookings ADD CONSTRAINT bookings_booking_trip_id_fkey
  FOREIGN KEY (booking_trip_id) REFERENCES trip_builder_trips(id);

-- ----------------------------------------------------------------
-- Verification — abort loudly if a guessed constraint name above was
-- wrong and a stale FK to the legacy `trips` table survived on one of
-- THESE SPECIFIC COLUMNS (which would silently double-constrain the
-- column instead of failing). Scoped to (table, column) pairs, not
-- just table name — bookings also has an unrelated, pre-existing FK
-- (bookings_trip_id_fkey, on bookings.trip_id, the old ad-hoc
-- Trips-view grouping column) that legitimately references the
-- legacy trips table and must NOT be touched or flagged here.
-- ----------------------------------------------------------------

DO $$
DECLARE
  bad RECORD;
BEGIN
  FOR bad IN
    SELECT rel.relname AS table_name, att.attname AS column_name, con.conname
    FROM pg_constraint con
    JOIN pg_class rel     ON rel.oid = con.conrelid
    JOIN pg_class frel    ON frel.oid = con.confrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND frel.relname = 'trips'
      AND (rel.relname, att.attname) IN (
        ('trip_clients', 'trip_id'),
        ('trip_legs', 'trip_id'),
        ('trip_itinerary_days', 'trip_id'),
        ('trip_line_items', 'trip_id'),
        ('trip_line_item_drafts', 'trip_id'),
        ('trip_documents', 'trip_id'),
        ('trip_chat_messages', 'trip_id'),
        ('bookings', 'booking_trip_id')
      )
  LOOP
    RAISE EXCEPTION 'Constraint % on %.% still references the legacy trips table — a guessed constraint name above was wrong; drop % manually and re-run', bad.conname, bad.table_name, bad.column_name, bad.conname;
  END LOOP;
END $$;
