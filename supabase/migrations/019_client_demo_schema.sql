-- ================================================================
-- 019_client_demo_schema.sql
-- Schema for the client-facing chat demo (build brief §2/§3/§7):
--   1. client_chat_messages — persisted chat thread per trip, the
--      client-facing counterpart to trip_chat_messages.
--   2. is_demo flag on trip_builder_trips/bookings/client_chat_messages
--      so demo-generated rows can be filtered out of real reporting.
--   3. trip_line_items.breakdown / property_name — generic additions
--      (not demo-only) so a single accommodation option can carry a
--      structured fee breakdown (room rate / resort fee / transfer)
--      and be grouped by property, which the client rate sidebar needs
--      and nothing in the existing schema provided.
--   4. One seeded demo client/family (build brief §6) — a fixed row so
--      the chat backend has a real client_id to attach trips to before
--      real auth (Session 6) exists. Session 6 will bind Google login
--      to this same record rather than creating a new one.
--   5. A Maldives high_value_routing row so Path 5 (wholesale-first)
--      is actually exercised by the demo, per build brief §3.
--
-- Apply in Supabase SQL editor. All statements are idempotent.
-- ================================================================

-- ----------------------------------------------------------------
-- 1. client_chat_messages
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_chat_messages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    uuid        NOT NULL REFERENCES trip_builder_trips(id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text        NOT NULL,
  tool_calls jsonb,
  is_demo    boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_chat_messages_trip_id_idx ON client_chat_messages(trip_id);

-- ----------------------------------------------------------------
-- 2. is_demo flags
-- ----------------------------------------------------------------
ALTER TABLE trip_builder_trips ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE bookings           ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- ----------------------------------------------------------------
-- 3. trip_line_items additions
-- ----------------------------------------------------------------
ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS breakdown     jsonb;
ALTER TABLE trip_line_items ADD COLUMN IF NOT EXISTS property_name text;

-- ----------------------------------------------------------------
-- 4. Seeded demo client/family — fixed IDs so this is idempotent and
--    so app code can reference them as constants.
-- ----------------------------------------------------------------
INSERT INTO clients (id, full_name, email, active)
VALUES ('00000000-0000-4000-8000-000000000001', 'Jordan Ellis', 'jordan.ellis@example.com', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO families (id, family_name, notes, created_by)
VALUES ('00000000-0000-4000-8000-000000000002', 'Client Portal Demo', 'Shared demo persona for the client-facing chat product — every client-portal Google login maps to this one record until real per-user identity (Session 6) lands.', 'client-demo-seed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO family_members (family_id, client_id, role, is_primary)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'primary', true)
ON CONFLICT (family_id, client_id) DO NOTHING;

-- ----------------------------------------------------------------
-- 5. Maldives → Path 5 (wholesale-first), so the demo's mock adapter
--    genuinely exercises the high-value routing path per build brief
--    §3 ("any Maldives property triggers Path 5, not a whitelist").
--    wholesale_source 'client_demo_mock' is recognized by the mock
--    adapter's wholesaler variant (lib/client/mock-rates.ts).
-- ----------------------------------------------------------------
INSERT INTO high_value_routing (destination, wholesale_source, notes)
SELECT 'Maldives', 'client_demo_mock', 'Seeded for the client chat demo — exercises Path 5 against generated (not live) rates.'
WHERE NOT EXISTS (
  SELECT 1 FROM high_value_routing WHERE destination ILIKE 'Maldives'
);

-- ----------------------------------------------------------------
-- 6. Grants (matches every other table in this schema — no RLS).
-- ----------------------------------------------------------------
GRANT ALL ON client_chat_messages TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
