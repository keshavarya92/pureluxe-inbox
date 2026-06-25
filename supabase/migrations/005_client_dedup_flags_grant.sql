-- Migration 005: Grant service_role access to client_dedup_flags
-- Migration 001 created the table but omitted the GRANT, so the resolver
-- was silently failing to log fuzzy-match candidates via the API.
GRANT SELECT, INSERT, UPDATE ON client_dedup_flags TO service_role;
