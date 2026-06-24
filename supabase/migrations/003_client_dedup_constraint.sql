-- ================================================================
-- Migration 003: Unique constraint on clients.normalized_name
-- ================================================================
--
-- IMPORTANT — execution order:
--   1. Run scripts/dedup-clients.ts in dry-run mode, review output
--   2. Run: DRY_RUN=false npm run dedup:clients  (live merge)
--   3. THEN apply THIS migration in the Supabase SQL editor
--   4. Verify no errors — the constraint must apply cleanly
--
-- Applying this migration BEFORE the dedup script has run will fail
-- with a unique-violation error if any duplicate normalized_name
-- values still exist in the clients table.
--
-- After this constraint is active, resolveClient in lib/resolvers.ts
-- uses ON CONFLICT (normalized_name) DO NOTHING to atomically prevent
-- race-condition duplicates.

ALTER TABLE clients
  ADD CONSTRAINT clients_normalized_name_unique UNIQUE (normalized_name);
