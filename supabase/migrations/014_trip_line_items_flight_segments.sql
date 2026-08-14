-- ================================================================
-- 014_trip_line_items_flight_segments.sql
-- A multi-leg flight fare (e.g. BLR→NRT→ITM→BLR on three different
-- flight numbers) was being extracted as one squashed free-text
-- "details" paragraph — readable enough as a sentence, but useless as
-- a document layout: the advisor wanted each flight number as its own
-- row in a table, not a run-on sentence to parse.
--
-- segments: structured per-flight-number breakdown for category
-- 'flight' items only — null for every other category, and null (not
-- an empty array) for a flight item quoted as a single undifferentiated
-- fare with nothing to break out. When present, the document renderers
-- show a proper table instead of (or alongside, for anything left over
-- that isn't per-segment, like baggage/date-change notes) the old
-- single "Details" paragraph.
-- ================================================================

ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS segments jsonb;
