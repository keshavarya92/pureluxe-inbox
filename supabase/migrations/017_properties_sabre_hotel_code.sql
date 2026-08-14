-- ================================================================
-- 017_properties_sabre_hotel_code.sql
-- Adds the Sabre GDS hotel code to properties, so gdsAdapter (see
-- lib/trip-builder/rate-sources.ts / lib/trip-builder/sabre/hotel-search.ts)
-- can call phase 2 (hoteldetails) directly for a known property instead
-- of re-resolving it from a destination search every time. Optional —
-- null means "not yet mapped," in which case the adapter falls back to
-- a destination search + name match against Sabre's phase 1 results.
-- Apply in Supabase SQL editor. Idempotent.
-- ================================================================

ALTER TABLE properties ADD COLUMN IF NOT EXISTS sabre_hotel_code text;

CREATE INDEX IF NOT EXISTS idx_properties_sabre_hotel_code
  ON properties (sabre_hotel_code) WHERE sabre_hotel_code IS NOT NULL;
