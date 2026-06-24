  -- ================================================================
  -- Migration 001: Client + booking resolver infrastructure
  -- Apply this in Supabase SQL editor before enabling lib/resolvers.ts.
  -- All statements are idempotent (IF NOT EXISTS / OR REPLACE).
  -- ================================================================

  -- ----------------------------------------------------------------
  -- 1. pg_trgm for fuzzy name matching
  -- ----------------------------------------------------------------
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  -- ----------------------------------------------------------------
  -- 2. normalized_name generated column on clients
  --
  --    Normalization rules (must match normalizeName() in lib/resolvers.ts):
  --      a. lowercase
  --      b. strip leading title prefix  (mr, mrs, ms, dr, mstr, miss, prof — with/without dot)
  --      c. strip trailing family suffix (&/and Family, (party), Group)
  --      d. collapse whitespace, trim
  --
  --    IMPORTANT: never INSERT or UPDATE normalized_name directly —
  --    it is GENERATED ALWAYS AS (stored) and Postgres maintains it
  --    automatically. Remove it from any payload before writing to clients.
  -- ----------------------------------------------------------------
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS normalized_name text
    GENERATED ALWAYS AS (
      trim(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(full_name),
              -- (a+b) strip title prefix after lowercasing
              '^\s*(mr\.?|mrs\.?|ms\.?|dr\.?|mstr\.?|miss|prof\.?)\s+',
              '', 'g'
            ),
            -- (c) strip trailing family/group suffix
            '\s+(&|and)?\s*(family|\(party\)|group)\s*$',
            '', 'g'
          ),
          -- (d) collapse multiple spaces
          '\s+',
          ' ', 'g'
        )
      )
    ) STORED;

  -- ----------------------------------------------------------------
  -- 3. Indexes on clients.normalized_name
  -- ----------------------------------------------------------------

  -- Btree for exact equality lookups (resolveClient step 2)
  CREATE INDEX IF NOT EXISTS clients_normalized_name_idx
    ON clients (normalized_name);

  -- GIN trigram index for similarity queries (resolveClient step 3)
  CREATE INDEX IF NOT EXISTS clients_normalized_name_trgm_idx
    ON clients USING gin (normalized_name gin_trgm_ops);

  -- ----------------------------------------------------------------
  -- 4. Composite index for booking dedup queries
  --    (resolveBooking step 1: client_id + property_id + check_in + check_out)
  -- ----------------------------------------------------------------
  CREATE INDEX IF NOT EXISTS bookings_dedup_idx
    ON bookings (client_id, property_id, check_in, check_out)
    WHERE client_id IS NOT NULL
      AND check_in  IS NOT NULL
      AND check_out IS NOT NULL;

  -- ----------------------------------------------------------------
  -- 5. client_dedup_flags — surface pre-resolver duplicates + fuzzy
  --    candidates for manual review. Resolver never auto-merges these.
  -- ----------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS client_dedup_flags (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- client_id_a is the canonical / newly inserted row
    -- client_id_b is the suspected duplicate
    client_id_a uuid        NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    client_id_b uuid        NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    -- 'exact_normalized_name_duplicate' | 'fuzzy_match_candidate'
    reason      text        NOT NULL,
    resolved    boolean     NOT NULL DEFAULT false,
    resolved_by uuid,
    resolved_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS client_dedup_flags_unresolved_idx
    ON client_dedup_flags (resolved)
    WHERE resolved = false;

  -- ----------------------------------------------------------------
  -- 6. find_similar_clients — used by resolveClient step 3.
  --    Requires pg_trgm (step 1) and the trgm index (step 3).
  -- ----------------------------------------------------------------
  CREATE OR REPLACE FUNCTION find_similar_clients(
    input_name text,
    threshold  float DEFAULT 0.65
  )
  RETURNS TABLE (id uuid, normalized_name text, sim float)
  LANGUAGE sql
  STABLE
  AS $$
    SELECT
      c.id,
      c.normalized_name,
      similarity(c.normalized_name, input_name) AS sim
    FROM clients c
    WHERE c.normalized_name IS NOT NULL
      AND similarity(c.normalized_name, input_name) > threshold
    ORDER BY sim DESC
    LIMIT 5;
  $$;
