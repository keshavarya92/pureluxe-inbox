-- Migration 006: Grant service_role access to client_relationships
-- schema.sql created the table but omitted the GRANT (same class of bug
-- fixed for client_dedup_flags in migration 005), so linkClientRelationship
-- was silently failing to insert relationship links via the API.
GRANT SELECT, INSERT, UPDATE ON client_relationships TO service_role;
