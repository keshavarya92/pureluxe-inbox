-- ================================================================
-- 015_trip_itinerary_days_advisor_manual.sql
-- trip_itinerary_days.source's third value was 'manual', reachable only
-- via the save_itinerary_day tool's verbatim_from_advisor opt-in — every
-- other unlabeled save (no preceding request_suggestion call) silently
-- fell back to 'llm_general', an AI-provenance bucket, even when the
-- content was actually manual/edited advisor input. Renamed to
-- 'advisor_manual' and promoted to the default for "no request_suggestion
-- preceded this save" (see save_itinerary_day in lib/trip-builder/tools.ts)
-- so manual entries stop landing in one of the two AI buckets.
-- ================================================================

UPDATE trip_itinerary_days SET source = 'advisor_manual' WHERE source = 'manual';

ALTER TABLE trip_itinerary_days DROP CONSTRAINT IF EXISTS trip_itinerary_days_source_check;
ALTER TABLE trip_itinerary_days ADD CONSTRAINT trip_itinerary_days_source_check
  CHECK (source IN ('kb', 'llm_general', 'advisor_manual'));
