-- ================================================================
-- 010_trip_builder.sql
-- Trip Builder Session 1: core schema. Itinerary content and rates
-- are two independent tracks per trip_leg — neither table gates the
-- other; see trip_documents for the per-document-type generation gate.
-- Apply in Supabase SQL editor. All statements are idempotent.
-- ================================================================

-- ----------------------------------------------------------------
-- 1. trips — parent record for a multi-leg trip being built.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_client_id  uuid        REFERENCES clients(id),
  status             text        NOT NULL DEFAULT 'building'
                        CHECK (status IN ('building','quoted','confirmed','itinerary_sent')),
  title              text,
  created_by         text        NOT NULL, -- team member email
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trips_primary_client_id ON trips(primary_client_id);

-- ----------------------------------------------------------------
-- 2. trip_clients — travelers on the trip (families/multi-pax via
--    the existing families schema; this just links clients in).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_clients (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  client_id  uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role       text        NOT NULL DEFAULT 'companion'
                CHECK (role IN ('primary','companion')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_clients_trip_id   ON trip_clients(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_clients_client_id ON trip_clients(client_id);

-- ----------------------------------------------------------------
-- 3. trip_legs — one row per destination stop, in sequence.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_legs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sequence_order    integer     NOT NULL,
  destination       text        NOT NULL,
  check_in          date,
  check_out         date,
  itinerary_status  text        NOT NULL DEFAULT 'not_started'
                        CHECK (itinerary_status IN ('not_started','drafted','confirmed')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_legs_trip_id_sequence
  ON trip_legs(trip_id, sequence_order);

-- ----------------------------------------------------------------
-- 4. trip_itinerary_days — day-by-day content, mirrors the
--    pureluxe-itinerary JSON shape. source/verified carry the
--    provenance flag (kb vs llm_general) shown in the chat UI.
--    updated_at drives the trip_documents staleness check.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_itinerary_days (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  leg_id     uuid        NOT NULL REFERENCES trip_legs(id) ON DELETE CASCADE,
  day_num    integer     NOT NULL,
  date       date,
  title      text,
  items      jsonb       NOT NULL DEFAULT '[]'::jsonb, -- [{type: 'confirmed'|'hotel'|'dining'|'alt'|'casual'|'note', text}] — enforced by the save_itinerary_day tool schema (lib/trip-builder/tools.ts), not a DB constraint
  source     text        NOT NULL CHECK (source IN ('kb','llm_general','manual')),
  verified   boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_itinerary_days_trip_id ON trip_itinerary_days(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_itinerary_days_leg_id  ON trip_itinerary_days(leg_id);

-- ----------------------------------------------------------------
-- 5. trip_line_items — generalized rate line item (accommodation,
--    activity, transfer, or flight). leg_id nullable: flights and
--    some transfers span legs rather than belonging to one.
--    updated_at drives the trip_documents staleness check.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_line_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id             uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  leg_id              uuid        REFERENCES trip_legs(id) ON DELETE CASCADE,
  category            text        NOT NULL
                          CHECK (category IN ('accommodation','activity','transfer','flight')),
  title               text        NOT NULL,
  subtitle            text,
  details             text,
  unit                text        CHECK (unit IN ('night','person','flat')),
  quantity            numeric,
  rate_per_unit       numeric,
  currency            text,
  inclusions          jsonb       NOT NULL DEFAULT '[]'::jsonb, -- array of strings
  cancellation_policy text,
  status              text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','confirmed')),
  selected            boolean     NOT NULL DEFAULT false, -- true when chosen among multiple options in the same category+leg
  source              text        NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual','offline_kb','api')), -- api is phase 2
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_line_items_trip_id         ON trip_line_items(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_line_items_leg_id          ON trip_line_items(leg_id);
CREATE INDEX IF NOT EXISTS idx_trip_line_items_trip_id_category ON trip_line_items(trip_id, category);

-- ----------------------------------------------------------------
-- 6. trip_line_item_drafts — rate capture staging (paste/upload)
--    before it's approved onto a trip_line_items row.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_line_item_drafts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  leg_id         uuid        REFERENCES trip_legs(id) ON DELETE CASCADE,
  raw_input      text        NOT NULL,
  extracted_json jsonb,
  status         text        NOT NULL DEFAULT 'pending_review'
                     CHECK (status IN ('pending_review','approved','rejected')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_line_item_drafts_trip_id_status
  ON trip_line_item_drafts(trip_id, status);

-- ----------------------------------------------------------------
-- 7. trip_documents — generated documents, tracked for staleness.
--    Staleness is computed on read (source_updated_at compared
--    against max(updated_at) across the trip's itinerary days and
--    line items) — no trigger-maintained flag by design.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_documents (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id            uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  type               text        NOT NULL CHECK (type IN ('itinerary','rate_sheet')),
  file_path          text        NOT NULL,
  generated_at       timestamptz NOT NULL DEFAULT now(),
  source_updated_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trip_documents_trip_id_type ON trip_documents(trip_id, type);

-- ----------------------------------------------------------------
-- 8. destination_facts / property_facts — KB tables. Trainer Chat's
--    KB (client_documents, knowledge_chunks — see 008_trainer_chat.sql)
--    covers client-scoped narrative facts, not destination/property
--    facts, so these are new here.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS destination_facts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  destination  text        NOT NULL,
  dining_recs  text,
  activities   text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_destination_facts_destination ON destination_facts(destination);

CREATE TABLE IF NOT EXISTS property_facts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_name  text        NOT NULL,
  destination    text,
  dining_recs    text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_facts_property_name ON property_facts(property_name);

-- ----------------------------------------------------------------
-- 9. Booking linkage — booking_trip_id, NOT bookings.trip_id.
--    bookings.trip_id/suggested_trip_id already exist (added ad hoc,
--    outside migrations) as a bare grouping UUID for the unrelated
--    Trips-view queue feature (lib/studio/trip-grouping.ts) — they
--    are not a foreign key to anything. Reusing that column here
--    would conflate the two features under one name and break under
--    an FK constraint, so Trip Builder gets its own column.
-- ----------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_trip_id uuid REFERENCES trips(id);

CREATE INDEX IF NOT EXISTS idx_bookings_booking_trip_id ON bookings(booking_trip_id);

-- ----------------------------------------------------------------
-- 10. Grant access to service role
-- ----------------------------------------------------------------
GRANT ALL ON trips                    TO service_role;
GRANT ALL ON trip_clients             TO service_role;
GRANT ALL ON trip_legs                TO service_role;
GRANT ALL ON trip_itinerary_days      TO service_role;
GRANT ALL ON trip_line_items          TO service_role;
GRANT ALL ON trip_line_item_drafts    TO service_role;
GRANT ALL ON trip_documents           TO service_role;
GRANT ALL ON destination_facts        TO service_role;
GRANT ALL ON property_facts           TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
