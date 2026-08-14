-- ================================================================
-- 016_rate_routing.sql
-- Config tables backing the 5-path rate routing system's static
-- lookups (paths 1 and 5, plus the additive wholesaler list used by
-- paths 2-4). See lib/trip-builder/rate-routing.ts (resolveRateRouting)
-- for the resolver that reads these — this migration is schema only.
--
-- No `destinations` or `hotels` tables exist in this schema (confirmed
-- against supabase/schema.sql and migrations 010/012): destinations are
-- free text everywhere else in Trip Builder (trip_legs.destination,
-- destination_facts.destination, property_facts.destination), and the
-- property table is `properties`, not `hotels`. This migration follows
-- that existing convention — destination columns are text, matched
-- case-insensitively by the resolver (same ILIKE approach resolveTrip
-- already uses in lib/resolvers.ts), and property_id references
-- properties(id).
--
-- Access: this codebase has no RLS policies enabled anywhere (verified
-- across supabase/schema.sql and all migrations) — every table is
-- plain GRANT ALL ... TO service_role with RLS off. These three tables
-- follow that same actual pattern rather than introducing new-style RLS
-- policies with no precedent here.
-- Apply in Supabase SQL editor. All statements are idempotent.
-- ================================================================

-- ----------------------------------------------------------------
-- 1. offline_trip_types — trip types handled entirely offline
--    (safaris, yachts, etc.) with full consultant handoff and no
--    rate search at all. Path 1.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offline_trip_types (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_type  text        NOT NULL UNIQUE,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------
-- 2. wholesaler_destinations — destinations where a wholesaler
--    should be queried ADDITIVELY alongside GDS/bedbank (not instead
--    of them). Paths 2-4.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wholesaler_destinations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  destination     text        NOT NULL,
  wholesaler_name text        NOT NULL,
  api_source      text        NOT NULL,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wholesaler_destinations_destination
  ON wholesaler_destinations (lower(destination));

CREATE INDEX IF NOT EXISTS idx_wholesaler_destinations_active
  ON wholesaler_destinations (active) WHERE active = true;

-- ----------------------------------------------------------------
-- 3. high_value_routing — destinations or specific properties where
--    wholesale/offline rates must be checked first, skipping
--    GDS/OTA, falling back to GDS/OTA only if wholesale has no
--    availability. Path 5. Scoped to exactly one of destination or
--    property_id, never both and never neither.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS high_value_routing (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  destination      text,
  property_id      uuid        REFERENCES properties(id),
  wholesale_source text        NOT NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_scope_only CHECK (
    (destination IS NOT NULL AND property_id IS NULL) OR
    (destination IS NULL AND property_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_high_value_routing_destination
  ON high_value_routing (lower(destination));

CREATE INDEX IF NOT EXISTS idx_high_value_routing_property_id
  ON high_value_routing (property_id);

-- ----------------------------------------------------------------
-- 4. Grant access to service role (matches every other table in this
--    schema — see header note; no RLS anywhere in this codebase).
-- ----------------------------------------------------------------
GRANT ALL ON offline_trip_types     TO service_role;
GRANT ALL ON wholesaler_destinations TO service_role;
GRANT ALL ON high_value_routing     TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
