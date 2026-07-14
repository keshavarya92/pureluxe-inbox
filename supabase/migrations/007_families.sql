-- ================================================================
-- 007_families.sql
-- Families, family members, and family booking members
-- ================================================================

-- 1. Families table
CREATE TABLE families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_name text NOT NULL,
  notes       text,
  created_by  text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- 2. Family members — links clients to families with a role
CREATE TABLE family_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member',
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(family_id, client_id)
);

-- 3. Family booking members — which family members are on a booking
CREATE TABLE family_booking_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'guest',
  created_at timestamptz DEFAULT now(),
  UNIQUE(booking_id, client_id)
);

-- 4. Add lead_client_id to bookings
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS lead_client_id uuid REFERENCES clients(id);

-- 5. Indexes
CREATE INDEX family_members_family_id_idx      ON family_members(family_id);
CREATE INDEX family_members_client_id_idx      ON family_members(client_id);
CREATE INDEX family_booking_members_booking_idx ON family_booking_members(booking_id);
CREATE INDEX family_booking_members_client_idx  ON family_booking_members(client_id);

-- 6. Grant access to service role
GRANT ALL ON families               TO service_role;
GRANT ALL ON family_members         TO service_role;
GRANT ALL ON family_booking_members TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
