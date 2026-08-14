-- ================================================================
-- 011_trip_builder_chat.sql
-- Trip Builder chat persistence. Scoped by trip_id, not by team
-- member — unlike Trainer Chat's one-conversation-per-person model,
-- the chat pane and sidebar are both per-trip (see build brief).
-- A trip must exist before any message can be stored against it —
-- the "start trip" turn itself is handled client-side as an
-- ephemeral pre-trip exchange (see lib/trip-builder/agent.ts) and
-- is not persisted here.
-- Apply in Supabase SQL editor. Idempotent.
-- ================================================================

CREATE TABLE IF NOT EXISTS trip_chat_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  created_by  text        NOT NULL, -- team member email
  role        text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text        NOT NULL,
  tool_calls  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_chat_messages_trip_id
  ON trip_chat_messages(trip_id, created_at);

GRANT ALL ON trip_chat_messages TO service_role;
