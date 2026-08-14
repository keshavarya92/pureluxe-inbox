# Provenance Manual Test Checklist

Covers Build Tracker row "Manual test checklist" (Provenance System). Written by tracing
the actual save path, not from the spec — see `BUILD_TRACKER.md` for why the Sheet's
"Scoped / Not Implemented" status on the two rows this checklist depends on was wrong; both
are implemented (`supabase/migrations/015_trip_itinerary_days_advisor_manual.sql`,
`lib/trip-builder/tools.ts`).

## How stamping actually works (read before testing)

`buildTripBuilderTools(tripId)` (`lib/trip-builder/tools.ts:166`) holds one closure variable,
`lastSuggestionSource`, per call. Every `request_suggestion` tool call overwrites it with
that suggestion's `source` (`'kb'` or `'llm_general'`, decided in `kb-tool.ts` at generation
time). Every `save_itinerary_day` call reads it, falls back to `'advisor_manual'` if it's
`null`, then **resets it to `null`** — so it's consumed by exactly one save, not sticky
across saves.

Critically: `runTripChatTurn` (`lib/trip-builder/agent.ts:213`) calls
`buildTripBuilderTools(tripId)` **fresh on every chat turn** (every HTTP request to
`/api/studio/trip-builder/chat`). The closure — and `lastSuggestionSource` with it — does
not survive between turns. It only persists across the multiple tool-call *rounds* inside
one turn's tool loop.

## Test cases

1. **KB hit stamps `kb`.** Ask for a suggestion for a destination/property with rows in
   `destination_facts`/`property_facts` that populate the requested category, then save an
   itinerary day in the same turn. Confirm `trip_itinerary_days.source = 'kb'`.

2. **KB miss falls back to `llm_general`.** Same as above for a destination/property with no
   matching KB rows (or a matched row whose relevant field is empty — `kb-tool.ts:105-120`
   guards per-field, not per-row-match, so a row that matches but has nothing for the
   requested category should still fall through here). Confirm `source = 'llm_general'`.

3. **No suggestion call defaults to `advisor_manual`.** Give the agent itinerary content to
   save with no preceding `request_suggestion` in that turn. Confirm `source =
   'advisor_manual'`, not `'llm_general'` or a null/error.

4. **Suggestion is consumed by exactly one save.** In one turn: call `request_suggestion`,
   then `save_itinerary_day` twice (two different days) with no second suggestion call in
   between. Confirm day 1 gets the suggestion's source and **day 2 gets `advisor_manual`**
   — the flag resets after first use, it does not apply to every save in the turn.

5. **Suggestion source does not survive a turn boundary.** Turn 1: call
   `request_suggestion`, then end the turn without saving (e.g. the advisor asks a follow-up
   question instead of confirming). Turn 2 (new HTTP request): save that same content.
   Expected/current behavior is `source = 'advisor_manual'`, even though the content
   actually originated from a KB/LLM suggestion shown one turn earlier — confirm this is the
   actual behavior, and decide with Keshav whether it's acceptable (content that visibly
   came from a suggestion one message ago gets silently mislabeled as advisor-authored) or
   needs the suggestion source persisted somewhere turn-durable (e.g. on the trip row, or
   re-derived from chat history) instead of an in-memory closure.

6. **Updating an existing day re-evaluates the rule.** Re-save a day that already exists
   (upsert path in `saveItineraryDay`) both with and without a preceding suggestion in that
   turn. Confirm the stamped source reflects the *edit's* suggestion state, not whatever the
   day was originally stamped with.

7. **DB constraint rejects anything outside the three values.** `trip_itinerary_days_source_check`
   (added in migration 015) should reject any `source` other than `'kb'`, `'llm_general'`,
   `'advisor_manual'` — confirm with a direct insert/update attempt.

8. **Migration 015 backfill.** For any pre-existing rows, confirm none still read `source =
   'manual'` post-migration (the migration's `UPDATE` should have caught all of them) —
   spot-check directly against Supabase rather than trusting the migration ran cleanly.

9. **Language doesn't overstate certainty (qualitative, not automatable).** Per
   `agent.ts`'s system prompt rule ("never restate that as more or less certain... never
   claim something is 'grounded' or 'verified' on your own authority"), read a sample of
   assistant replies following both a `kb` and an `llm_general` suggestion and confirm the
   chat reply doesn't claim more confidence for `llm_general` content than the tag warrants.

## Not covered here

Whether stamped provenance is ever surfaced to the client or advisor outside the DB — it
currently isn't (see `docs/itinerary-content-generation-trace.md`, "Provenance-stamping
intersection"). That's a design question, not a test case.
