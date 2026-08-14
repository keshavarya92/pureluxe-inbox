-- ================================================================
-- 020_trip_line_items_rate_detail.sql
-- Rate-card detail fields requested after reviewing the client demo's
-- Rates sidebar: room size/features and payment policy (inclusions and
-- cancellation_policy already existed but weren't being surfaced), plus
-- loyalty-points eligibility (typically GDS-eligible, wholesale/OTA not
-- — derived from the rate source, see lib/client/tools.ts).
-- Generic additions, same as migration 019's breakdown/property_name —
-- nullable, unused by the existing paste-extraction/approval path.
-- ================================================================

ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS room_size                   text;
ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS room_features               jsonb;
ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS payment_policy              text;
ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS loyalty_hotel_eligible      boolean;
ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS loyalty_pureluxe_eligible   boolean;
