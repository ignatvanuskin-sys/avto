-- =============================================================================
-- 0004_bookings.sql
-- Customers, bookings, audit trail and idempotency records.
--
-- Invariants enforced here (not in the client):
--  * the client never supplies tenant_id, price, duration or buffers — all of
--    them are snapshotted from `services` inside a SECURITY DEFINER function;
--  * a booking keeps the price that was valid when it was created, so later
--    price edits never rewrite history;
--  * only a hash of the customer access token is stored.
-- =============================================================================

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  phone text not null,
  email text,
  -- Normalised phone (digits only) used for de-duplication inside a tenant.
  phone_normalized text not null,
  notes text,
  -- Demo rows exist only inside `preview` tenants and are the only data a
  -- preview environment is allowed to contain.
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customers_phone_format check (length(phone_normalized) between 5 and 20),
  constraint customers_tenant_phone unique (tenant_id, phone_normalized),
  constraint customers_tenant_id_key unique (tenant_id, id)
);

create trigger customers_touch
  before update on public.customers
  for each row execute function app.touch_updated_at();

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null,
  service_id uuid not null,
  resource_id uuid not null,

  display_number bigint not null,

  -- Snapshot block. These values are copied from the catalogue on insert and
  -- are immutable afterwards: this is the "historical price" guarantee.
  price_cents bigint not null,
  currency char(3) not null,
  duration_min integer not null,
  buffer_before_min integer not null,
  buffer_after_min integer not null,
  service_name_snapshot text not null,

  -- Occupied interval of the service itself (without buffers).
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- Full occupancy interval including buffers. Maintained by a trigger rather
  -- than a generated column so the interval construction is never subject to
  -- expression-immutability restrictions.
  occupancy tstzrange not null,

  status public.booking_status not null default 'pending',
  customer_comment text,
  owner_comment text,
  is_demo boolean not null default false,

  -- SHA-256 of the customer access token. The plaintext token is never stored.
  access_token_hash bytea not null,
  -- SHA-256 of the idempotency key, so a request retry re-issues the exact
  -- same access without keeping the raw key around.
  idempotency_hash bytea not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_reason text,
  rescheduled_count integer not null default 0,
  last_rescheduled_at timestamptz,

  constraint bookings_time_range check (ends_at > starts_at),
  constraint bookings_duration_positive check (duration_min > 0),
  constraint bookings_price check (price_cents >= 0),
  constraint bookings_currency check (currency ~ '^[A-Z]{3}$'),
  constraint bookings_display_number unique (tenant_id, display_number),
  constraint bookings_access_token_unique unique (access_token_hash),
  constraint bookings_customer_fk
    foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete restrict,
  constraint bookings_service_fk
    foreign key (tenant_id, service_id)
    references public.services (tenant_id, id) on delete restrict,
  constraint bookings_resource_fk
    foreign key (tenant_id, resource_id)
    references public.resources (tenant_id, id) on delete restrict
);

create index bookings_tenant_time_idx on public.bookings (tenant_id, starts_at desc);
create index bookings_tenant_status_idx on public.bookings (tenant_id, status, starts_at);
create index bookings_customer_idx on public.bookings (tenant_id, customer_id, starts_at desc);
create index bookings_idempotency_idx on public.bookings (tenant_id, idempotency_hash);

create trigger bookings_touch
  before update on public.bookings
  for each row execute function app.touch_updated_at();

-- Keep the occupied interval in sync with the timestamps and buffers. Doing it
-- in a trigger guarantees the value can never drift from the stored fields.
create or replace function app.bookings_sync_occupancy()
returns trigger
language plpgsql
as $$
begin
  new.occupancy := tstzrange(
    new.starts_at - make_interval(mins => new.buffer_before_min),
    new.ends_at + make_interval(mins => new.buffer_after_min),
    '[)'
  );
  return new;
end;
$$;

create trigger bookings_sync_occupancy
  before insert or update of starts_at, ends_at, buffer_before_min, buffer_after_min
  on public.bookings
  for each row execute function app.bookings_sync_occupancy();

-- ---------------------------------------------------------------------------
-- Audit trail: every state transition is recorded, which is what makes the
-- reschedule/cancel behaviour explainable after the fact.
-- ---------------------------------------------------------------------------
create table public.booking_events (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid not null,
  event text not null,
  actor text not null,
  payload jsonb,
  created_at timestamptz not null default now(),

  constraint booking_events_actor check (actor in ('customer', 'owner', 'system', 'ai')),
  constraint booking_events_booking_fk
    foreign key (tenant_id, booking_id)
    references public.bookings (tenant_id, id) on delete cascade
);

create index booking_events_booking_idx on public.booking_events (tenant_id, booking_id, created_at);

-- ---------------------------------------------------------------------------
-- Idempotency ledger. Repeated create/reschedule/cancel requests return the
-- first recorded response instead of performing the mutation twice.
-- `request_hash` lets us reject a reused key with a different payload.
-- ---------------------------------------------------------------------------
create table public.idempotency_keys (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  scope text not null,
  key text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),

  primary key (tenant_id, scope, key)
);

create index idempotency_keys_created_idx on public.idempotency_keys (created_at);
