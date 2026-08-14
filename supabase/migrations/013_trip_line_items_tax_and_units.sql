-- ================================================================
-- 013_trip_line_items_tax_and_units.sql
-- Two additive columns on trip_line_items, driven by a real gap found
-- in production: a rate quoted "per room, per night, plus 17.7% tax"
-- was extracted as just the pre-tax per-night rate, so every subtotal
-- (and the trip investment summary) silently excluded tax. Separately,
-- a rate quoted "per room" with multiple rooms needed had no way to
-- reflect the room count without corrupting the night count.
--
-- tax_percentage: when a supplier states rates exclude a specific tax/
-- service percentage, this captures it WITHOUT changing rate_per_unit
-- — the displayed per-unit rate always stays exactly as quoted; only
-- the computed subtotal (rate_per_unit × quantity × unit_count, then
-- x(1 + tax_percentage/100)) reflects the true total. Null when the
-- source states the rate is already tax-inclusive/net.
--
-- unit_count: a multiplier independent of quantity (which stays
-- nights/persons, matching the stay length) — e.g. 4 rooms x 3 nights
-- each, not "12 nights". Defaults to 1 (no separate rooms/units).
-- ================================================================

ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS tax_percentage numeric;
ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS unit_count numeric NOT NULL DEFAULT 1;
