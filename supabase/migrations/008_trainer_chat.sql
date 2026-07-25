-- ================================================================
-- 008_trainer_chat.sql
-- Trainer Chat Session 1: client_documents (passport uploads) +
-- knowledge_chunks (narrative facts, pgvector-backed).
-- Apply in Supabase SQL editor. All statements are idempotent.
-- ================================================================

-- ----------------------------------------------------------------
-- 1. pgvector for knowledge_chunks embeddings
-- ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------
-- 2. client_documents — passport OCR results, written only after
--    team-member approval of the in-chat diff card (see AGENTS.md
--    Section 5). approved/approved_by/approved_at exist for audit
--    even though Session 1 only ever inserts pre-approved rows.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  doc_type          text        NOT NULL CHECK (doc_type = 'passport'), -- passport only in Session 1
  storage_path      text        NOT NULL,
  extracted_fields  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  expiry_date       date,
  uploaded_by       text        NOT NULL, -- team member email
  approved          boolean     NOT NULL DEFAULT false,
  approved_by       text,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_documents_client_id
  ON client_documents(client_id);

-- ----------------------------------------------------------------
-- 3. knowledge_chunks — narrative facts that don't map to a hard
--    field (dump mode + interview mode catch-all). Nullable
--    client_id/destination/property let queries pre-filter before
--    vector search.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text        NOT NULL CHECK (source_type IN ('dump','interview','whatsapp','itinerary','note')),
  client_id    uuid        REFERENCES clients(id) ON DELETE SET NULL,
  destination  text,
  property     text,
  content      text        NOT NULL,
  embedding    vector(1536),
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_client_id
  ON knowledge_chunks(client_id);

-- ivfflat requires rows in the table to build well-distributed lists;
-- fine to create against an empty table, but re-run ANALYZE (or
-- `REINDEX INDEX idx_knowledge_chunks_embedding`) once real data lands
-- so list assignment reflects the actual embedding distribution.
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ----------------------------------------------------------------
-- 4. Grant access to service role
-- ----------------------------------------------------------------
GRANT ALL ON client_documents  TO service_role;
GRANT ALL ON knowledge_chunks  TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
