-- ================================================================
-- 009_trainer_chat_messages.sql
-- Persistence for the unified Trainer Chat window (replaces the
-- family-tabs interview flow with a single ongoing conversation per
-- team member). Apply in Supabase SQL editor. Idempotent.
-- ================================================================

CREATE TABLE IF NOT EXISTS trainer_chat_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Scoped per team member — each person has their own conversation.
  created_by  text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text        NOT NULL,
  -- Record of any tool calls made while producing this message (assistant
  -- role only) — what was looked up or written, for an auditable transcript
  -- separate from the human-readable `content`.
  tool_calls  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trainer_chat_messages_created_by
  ON trainer_chat_messages(created_by, created_at);

GRANT ALL ON trainer_chat_messages TO service_role;
