create table if not exists inbox_emails (
  id                 text        primary key,
  thread_id          text        not null,
  subject            text        not null,
  from_email         text        not null,
  from_name          text        not null default '',
  to_addresses       text[]      not null default '{}',
  cc_addresses       text[]      not null default '{}',
  email_date         text        not null,
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

create trigger inbox_emails_updated_at
  before update on inbox_emails
  for each row execute function set_updated_at();

-- Indexes for the query patterns used by the app
create index if not exists inbox_emails_category_idx        on inbox_emails (category);
create index if not exists inbox_emails_action_required_idx on inbox_emails (action_required) where action_required = true;
create index if not exists inbox_emails_urgent_idx          on inbox_emails (action_priority) where action_priority = 'urgent';
create index if not exists inbox_emails_date_idx            on inbox_emails (email_date desc);
create index if not exists inbox_emails_unread_idx          on inbox_emails (unread) where unread = true;
