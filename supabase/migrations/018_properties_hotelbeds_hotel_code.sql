-- ================================================================
-- 018_properties_hotelbeds_hotel_code.sql
-- Adds the Hotelbeds bedbank hotel code to properties, so hotelbedsAdapter
-- (see lib/trip-builder/rate-sources.ts / lib/trip-builder/hotelbeds/
-- hotel-search.ts) can call the Availability API for a known property.
-- Mirrors 017_properties_sabre_hotel_code.sql exactly, one column per
-- external hotel-code system. Optional — null means "not yet mapped," in
-- which case hotelbedsAdapter throws a clear per-call error rather than
-- guessing; there is no destination-level Hotelbeds search wired yet
-- (would need a separate Hotelbeds destination-code lookup, out of scope
-- for this session).
-- Apply in Supabase SQL editor. Idempotent.
-- ================================================================

ALTER TABLE properties ADD COLUMN IF NOT EXISTS hotelbeds_hotel_code text;

CREATE INDEX IF NOT EXISTS idx_properties_hotelbeds_hotel_code
  ON properties (hotelbeds_hotel_code) WHERE hotelbeds_hotel_code IS NOT NULL;
