create table if not exists inbox_emails (
  id                 text        primary key,
  thread_id          text        not null,
  subject            text        not null,
  from_email         text        not null,
  from_name          text        not null default '',
  to_addresses       text[]      not null default '{}',
  cc_addresses       text[]      not null default '{}',
  email_date         text        not null,
  received_at        timestamptz not null default now(),
  snippet            text        not null default '',
  body               text,
  unread             boolean     not null default true,

  -- Classification
  category           text        not null,
  tags               text[]      not null default '{}',
  summary            text        not null default '',
  action_required    boolean     not null default false,
  action_priority    text        not null default 'none',
  action_description text,
  unanswered_hours   integer,

  -- Extracted structured data (JSONB)
  booking            jsonb,
  finance            jsonb,
  supplier_contact   jsonb,

  -- Which user's inbox this email belongs to
  inbox_address      text        not null default '',
  booking_extracted           boolean     not null default false,
  has_confirmation_attachment boolean     not null default false,

  synced_at          timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Trigger to keep updated_at current
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger inbox_emails_updated_at
  before update on inbox_emails
  for each row execute function set_updated_at();

-- Indexes for the query patterns used by the app
create index if not exists inbox_emails_category_idx        on inbox_emails (category);
create index if not exists inbox_emails_action_required_idx on inbox_emails (action_required) where action_required = true;
create index if not exists inbox_emails_urgent_idx          on inbox_emails (action_priority) where action_priority = 'urgent';
create index if not exists inbox_emails_date_idx            on inbox_emails (email_date desc);
create index if not exists inbox_emails_unread_idx          on inbox_emails (unread) where unread = true;
create index if not exists inbox_emails_inbox_address_idx   on inbox_emails (inbox_address);

-- Idempotent migration: add columns to existing tables
alter table inbox_emails add column if not exists inbox_address     text    not null default '';
alter table inbox_emails add column if not exists received_at                timestamptz not null default now();
alter table inbox_emails add column if not exists booking_extracted           boolean not null default false;
alter table inbox_emails add column if not exists has_confirmation_attachment boolean not null default false;

create index if not exists inbox_emails_unextracted_idx on inbox_emails (booking_extracted) where booking_extracted = false;

-- ----------------------------------------------------------------
-- inbox_users: persists Gmail OAuth tokens per user
-- ----------------------------------------------------------------

create table if not exists inbox_users (
  id            uuid        primary key default gen_random_uuid(),
  email         text        unique not null,
  access_token  text,
  refresh_token text,
  token_expiry  timestamptz,
  last_sync     timestamptz,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

grant all on inbox_users to service_role;

create or replace trigger inbox_users_updated_at
  before update on inbox_users
  for each row execute function set_updated_at();

create index if not exists inbox_users_active_idx on inbox_users (active) where active = true;

-- ----------------------------------------------------------------
-- AI extraction agent: misc overflow column + new bookings columns
-- ----------------------------------------------------------------

-- misc text column on tables that receive Claude's unstructured overflow
alter table bookings    add column if not exists misc       text;
alter table commissions add column if not exists misc       text;
alter table enquiries   add column if not exists misc       text;
alter table clients     add column if not exists misc       text;

-- new bookings columns referenced by the extraction agent schema
alter table bookings    add column if not exists country    text;
alter table bookings    add column if not exists chain      text;
alter table bookings    add column if not exists onyx_ref   text;
alter table bookings    add column if not exists group_name text;

-- ----------------------------------------------------------------
-- Full table definitions (live schema — captured from Supabase)
-- Used by the AI extraction agent to understand every table.
-- ----------------------------------------------------------------

create table if not exists air_bookings (
  id                    uuid        not null default gen_random_uuid(),
  case_id               uuid,
  booking_id            uuid,
  client_id             uuid,
  passenger_name        text        not null,
  airline               text,
  flight_number         text,
  origin                text,
  destination           text,
  departure_datetime    timestamptz,
  arrival_datetime      timestamptz,
  cabin_class           text,
  pnr                   text,
  amadeus_ref           text,
  ticket_number         text,
  fare_basis            text,
  fare_inr              numeric,
  taxes_inr             numeric,
  total_inr             numeric,
  service_charge_inr    numeric,
  reissued              boolean     default false,
  reissue_penalty_inr   numeric,
  reissue_fare_diff_inr numeric,
  original_ticket_id    uuid,
  consolidator          text,
  client_type           text        default 'leisure',
  corporate_account     text,
  status                text        default 'confirmed',
  booked_by             uuid,
  trip_id               uuid,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create table if not exists airport_vip_services (
  id            uuid        not null default gen_random_uuid(),
  booking_id    uuid,
  client_id     uuid,
  airport       text,
  airport_name  text,
  service_type  text,
  service_date  date,
  flight_number text,
  pax_names     text[],
  provider      text,
  status        text        default 'requested',
  cost          numeric,
  currency      text,
  notes         text,
  booked_by     uuid,
  trip_id       uuid,
  created_at    timestamptz default now()
);

create table if not exists booking_pax (
  id                   uuid        not null default gen_random_uuid(),
  booking_id           uuid        not null,
  client_id            uuid,
  full_name            text        not null,
  title                text,
  passport_number      text,
  passport_nationality text,
  passport_expiry      date,
  date_of_birth        date,
  room_number_assigned text,
  trip_id              uuid,
  created_at           timestamptz default now()
);

create table if not exists bookings (
  id                    uuid        not null default gen_random_uuid(),
  client_id             uuid,
  client_name           text,
  num_rooms             integer     default 1,
  num_adults            integer,
  num_children          integer,
  property_id           uuid,
  hotel_name            text,
  city                  text,
  country               text,
  chain                 text,
  booked_by             uuid,
  booked_by_name        text,
  booking_source        text,
  booking_channel       text,
  sub_agent_id          uuid,
  amadeus_ref           text,
  lhw_ref               text,
  hotel_ref             text,
  ottila_ref            text,
  onyx_ref              text,
  check_in              date        not null,
  check_out             date        not null,
  nights                integer,
  total_cost            numeric,
  currency              text,
  total_cost_usd        numeric,
  commission_rate       numeric,
  commission_expected   numeric,
  commission_channel    text,
  commissionable        boolean     default true,
  commission_negotiated boolean     default false,
  status                text        default 'confirmed',
  cancellation_date     date,
  cancellation_reason   text,
  cancellation_deadline date,
  cancellation_policy   text,
  amended_from          uuid,
  vip_flag              boolean     default false,
  vvip_flag             boolean     default false,
  special_occasion      text,
  enquiry_id            uuid,
  source_thread_id      text,
  is_group_booking      boolean     default false,
  group_name            text,
  notes                 text,
  internal_notes        text,
  email_id              text,
  misc                  text,
  trip_id               uuid,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create table if not exists client_documents (
  id                   uuid        not null default gen_random_uuid(),
  client_id            uuid,
  document_type        text        not null,
  passport_number      text,
  passport_nationality text,
  passport_expiry      date,
  passport_dob         date,
  storage_path         text,
  valid_until          date,
  verified             boolean     default false,
  verified_by          uuid,
  uploaded_by          uuid,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create table if not exists client_health_notes (
  id                   uuid        not null default gen_random_uuid(),
  client_id            uuid        not null,
  condition            text,
  details              text,
  dietary_restrictions text[],
  mobility_notes       text,
  medication_notes     text,
  emergency_contact    text,
  relevant_for_hotels  boolean     default true,
  notes                text,
  added_by             uuid,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create table if not exists client_preferences (
  id              uuid        not null default gen_random_uuid(),
  client_id       uuid        not null,
  category        text        not null,
  preference      text        not null,
  preference_type text        default 'like',
  source          text,
  booking_id      uuid,
  property_id     uuid,
  notes           text,
  noted_by        uuid,
  confirmed       boolean     default false,
  mention_count   integer     default 1,
  last_observed   date,
  active          boolean     default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists client_relationships (
  id                 uuid        not null default gen_random_uuid(),
  primary_client_id  uuid,
  related_client_id  uuid,
  relationship_type  text,
  group_name         text,
  notes              text,
  created_at         timestamptz default now()
);

create table if not exists clients (
  id                 uuid        not null default gen_random_uuid(),
  full_name          text        not null,
  title              text,
  first_name         text,
  last_name          text,
  email              text,
  phone              text,
  whatsapp           text,
  nationality        text,
  city_of_residence  text,
  relationship_owner uuid,
  vip_level          text        default 'standard',
  client_since       date,
  referred_by        uuid,
  company            text,
  loyalty_programs   jsonb       default '[]',
  birthday           date,
  anniversary        date,
  other_occasions    jsonb       default '[]',
  general_notes      text,
  internal_notes     text,
  active             boolean     default true,
  misc               text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table if not exists commission_payments (
  id             uuid        not null default gen_random_uuid(),
  commission_id  uuid        not null,
  amount         numeric     not null,
  currency       text        not null,
  payment_date   date        not null,
  payment_method text,
  reference      text,
  bank_ref       text,
  notes          text,
  recorded_by    uuid,
  created_at     timestamptz default now()
);

create table if not exists commissions (
  id                   uuid        not null default gen_random_uuid(),
  booking_id           uuid        not null,
  amount_expected      numeric     not null,
  currency             text        not null,
  amount_expected_usd  numeric,
  amount_received      numeric,
  date_received        date,
  amount_received_usd  numeric,
  variance             numeric,
  channel              text,
  channel_case_no      text,
  intermediary         text,
  bank_ref             text,
  status               text        default 'pending',
  expected_by          date,
  last_chased_date     date,
  chased_by            uuid,
  chase_count          integer     default 0,
  notes                text,
  misc                 text,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create table if not exists email_threads (
  id               uuid        not null default gen_random_uuid(),
  gmail_thread_id  text,
  gmail_subject    text,
  from_email       text,
  from_name        text,
  received_at      timestamptz,
  category         text,
  booking_id       uuid,
  client_id        uuid,
  property_id      uuid,
  enquiry_id       uuid,
  commission_id    uuid,
  summary          text,
  action_required  boolean     default false,
  action_priority  text,
  action_description text,
  resolved         boolean     default false,
  resolved_at      timestamptz,
  resolved_by      uuid,
  inbox_address    text,
  created_at       timestamptz default now()
);

create table if not exists enquiries (
  id                  uuid        not null default gen_random_uuid(),
  client_id           uuid,
  client_name         text,
  property_id         uuid,
  property_name       text,
  destination         text,
  check_in            date,
  check_out           date,
  num_rooms           integer     default 1,
  num_adults          integer,
  num_children        integer,
  child_ages          integer[],
  quoted_rate         numeric,
  quoted_currency     text,
  quoted_by           uuid,
  quoted_at           timestamptz default now(),
  amadeus_option_ref  text,
  status              text        default 'sent',
  lost_reason         text,
  converted_booking_id uuid,
  notes               text,
  misc                text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create table if not exists feedback_conversations (
  id                  uuid        not null default gen_random_uuid(),
  booking_id          uuid        not null,
  recipient_type      text        not null,
  recipient_id        text,
  recipient_email     text,
  recipient_name      text,
  channel             text,
  message_sent        text,
  sent_at             timestamptz,
  reply_received      text,
  replied_at          timestamptz,
  processed           boolean     default false,
  feedback_id         uuid,
  insights_extracted  jsonb       default '{}',
  created_at          timestamptz default now()
);

create table if not exists post_stay_triggers (
  id                          uuid        not null default gen_random_uuid(),
  booking_id                  uuid        not null,
  checkout_date               date        not null,
  client_outreach_scheduled   timestamptz,
  client_outreach_sent        boolean     default false,
  client_outreach_sent_at     timestamptz,
  client_replied              boolean     default false,
  client_conversation_id      uuid,
  hotel_outreach_scheduled    timestamptz,
  hotel_outreach_sent         boolean     default false,
  hotel_outreach_sent_at      timestamptz,
  hotel_replied               boolean     default false,
  hotel_conversation_id       uuid,
  status                      text        default 'pending',
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

create table if not exists pre_stay_comms (
  id               uuid        not null default gen_random_uuid(),
  booking_id       uuid        not null,
  task_id          uuid,
  direction        text        not null,
  recipient_type   text,
  to_email         text,
  to_name          text,
  subject          text,
  body             text,
  gmail_thread_id  text,
  gmail_message_id text,
  sent_by          uuid,
  sent_at          timestamptz,
  replied_at       timestamptz,
  reply_received   boolean     default false,
  created_at       timestamptz default now()
);

create table if not exists pre_stay_tasks (
  id             uuid        not null default gen_random_uuid(),
  booking_id     uuid        not null,
  task_type      text        not null,
  description    text,
  due_date       date,
  status         text        default 'pending',
  assigned_to    uuid,
  auto_generated boolean     default true,
  generated_at   timestamptz default now(),
  sent_at        timestamptz,
  completed_at   timestamptz,
  notes          text,
  trip_id        uuid,
  created_at     timestamptz default now()
);

create table if not exists properties (
  id                    uuid        not null default gen_random_uuid(),
  name                  text        not null,
  brand                 text,
  chain                 text,
  city                  text,
  country               text,
  region                text,
  property_type         text,
  consortiums           text[],
  default_commission    numeric,
  commission_channel    text,
  commissionable        boolean     default true,
  property_email        text,
  reservations_email    text,
  general_phone         text,
  booking_notes         text,
  vip_contact_notes     text,
  relationship_strength text        default 'standard',
  active                boolean     default true,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create table if not exists property_contacts (
  id                 uuid        not null default gen_random_uuid(),
  property_id        uuid        not null,
  name               text        not null,
  title              text,
  email              text,
  phone              text,
  whatsapp           text,
  department         text,
  our_contact        uuid,
  relationship_notes text,
  active             boolean     default true,
  left_property      boolean     default false,
  left_date          date,
  new_property       uuid,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table if not exists property_intelligence (
  id                 uuid        not null default gen_random_uuid(),
  property_id        uuid        not null,
  category           text        not null,
  insight            text        not null,
  confidence         text        default 'reported',
  source_type        text,
  reported_by_client uuid,
  reported_by_team   uuid,
  booking_id         uuid,
  mention_count      integer     default 1,
  last_verified      date,
  valid_until        date,
  active             boolean     default true,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table if not exists property_rooms (
  id                      uuid        not null default gen_random_uuid(),
  property_id             uuid        not null,
  room_number             text,
  room_name               text,
  room_type               text,
  floor                   integer,
  view                    text,
  notes                   text,
  recommended             boolean     default false,
  avoid                   boolean     default false,
  avoid_reason            text,
  first_reported_by       uuid,
  first_reported_booking  uuid,
  mention_count           integer     default 1,
  last_verified           date,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

create table if not exists stay_feedback (
  id                       uuid        not null default gen_random_uuid(),
  booking_id               uuid        not null,
  client_id                uuid,
  property_id              uuid,
  feedback_date            date        default current_date,
  overall_rating           integer,
  room_rating              integer,
  service_rating           integer,
  dining_rating            integer,
  value_rating             integer,
  highlights               text,
  improvements             text,
  would_return             boolean,
  room_number_stayed       text,
  notable_staff            text,
  source                   text,
  raw_response             text,
  processed_by_ai          boolean     default false,
  preferences_extracted    boolean     default false,
  intelligence_extracted   boolean     default false,
  shared_with_hotel        boolean     default false,
  shared_date              date,
  created_at               timestamptz default now()
);

create table if not exists sub_agents (
  id               uuid        not null default gen_random_uuid(),
  name             text        not null,
  contact_name     text,
  email            text,
  phone            text,
  commission_split numeric,
  payment_terms    text,
  notes            text,
  active           boolean     default true,
  created_at       timestamptz default now()
);

create table if not exists suppliers (
  id              uuid        not null default gen_random_uuid(),
  name            text        not null,
  type            text,
  country         text,
  email           text,
  phone           text,
  contact_name    text,
  commission_rate numeric,
  payment_terms   text,
  notes           text,
  active          boolean     default true,
  created_at      timestamptz default now()
);

create table if not exists team_members (
  id         uuid        not null default gen_random_uuid(),
  name       text        not null,
  email      text        not null,
  role       text,
  title      text,
  phone      text,
  active     boolean     default true,
  created_at timestamptz default now()
);

create table if not exists team_targets (
  id                   uuid        not null default gen_random_uuid(),
  team_member_id       uuid        not null,
  period               text        not null,
  target_bookings      integer,
  target_revenue_usd   numeric,
  target_commission_usd numeric,
  notes                text,
  created_at           timestamptz default now()
);

create table if not exists trips (
  id                uuid        not null default gen_random_uuid(),
  name              text,
  primary_client_id uuid,
  group_name        text,
  start_date        date,
  end_date          date,
  destination       text,
  status            text,
  owner             uuid,
  notes             text,
  misc              text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists visa_tracking (
  id                  uuid        not null default gen_random_uuid(),
  booking_id          uuid        not null,
  client_id           uuid,
  destination_country text,
  nationality         text,
  visa_required       boolean,
  visa_type           text,
  visa_status         text        default 'not_checked',
  application_date    date,
  expected_date       date,
  received_date       date,
  notes               text,
  checked_by          uuid,
  trip_id             uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
