-- =============================================================================
-- 0005_payments.sql
-- Money actually received. Deliberately separate from `bookings.price_cents`,
-- which is the *quoted* value of a scheduled service.
--
-- Reporting invariant: a future booking's quoted price is never reported as
-- revenue. Statistics therefore read `payments` for received money and
-- `bookings` for scheduled value, and never mix the two.
-- =============================================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid not null,
  amount_cents bigint not null,
  currency char(3) not null,
  method public.payment_method not null,
  status public.payment_status not null default 'paid',
  provider_ref text,
  paid_at timestamptz,
  refunded_at timestamptz,
  note text,
  is_demo boolean not null default false,
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payments_amount_nonzero check (amount_cents <> 0),
  constraint payments_currency check (currency ~ '^[A-Z]{3}$'),
  constraint payments_paid_timestamp check (status <> 'paid' or paid_at is not null),
  constraint payments_refund_timestamp check (status <> 'refunded' or refunded_at is not null),
  constraint payments_booking_fk
    foreign key (tenant_id, booking_id)
    references public.bookings (tenant_id, id) on delete cascade,
  constraint payments_tenant_id_key unique (tenant_id, id)
);

-- Statistics read window: "received in period".
create index payments_received_idx
  on public.payments (tenant_id, paid_at desc)
  where status = 'paid';

create index payments_booking_idx on public.payments (tenant_id, booking_id);

create trigger payments_touch
  before update on public.payments
  for each row execute function app.touch_updated_at();
