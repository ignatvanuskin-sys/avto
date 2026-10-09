-- =============================================================================
-- 07_prices_payments_stats.test.sql
-- pgTAP suite: historical price snapshot, recorded payments and owner statistics.
--
-- What is proven here:
--   * a catalogue price change never rewrites the price snapshotted on a booking;
--   * record_payment(status => 'paid') stores a non-null paid_at;
--   * while a booking is not completed, owner_stats reports the snapshot as
--     scheduledValueCents (NOT revenue) and completedValueCents = 0;
--   * after set_booking_status(..., 'completed') the same quote becomes
--     completedValueCents, completedOrders = 1 and scheduledValueCents drops to
--     0 — the money is never counted twice;
--   * scheduledNote is an honest, non-empty label;
--   * owner_stats.period.timezone is the tenant timezone;
--   * a non-member calling owner_stats is rejected with SQLSTATE 42501.
--
-- Fixtures are inserted as the default table-owning role; every owner RPC is
-- called while impersonating an active member (SET LOCAL ROLE + JWT sub claim).
-- The reporting period is "today" in the tenant timezone (Europe/Moscow), and
-- the booking/payment timestamps are now(), so they always land inside it.
-- =============================================================================

begin;

select plan(15);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-000000000001', 'alpha@example.test'),
  ('30000000-0000-0000-0000-000000000003', 'stranger@example.test');

insert into public.tenants (id, slug, name, status, timezone, currency) values
  ('11111111-1111-1111-1111-111111111111', 'alpha-test', 'Alpha Test', 'live', 'Europe/Moscow', 'RUB');

insert into public.tenant_members (id, tenant_id, user_id, role, status) values
  ('10000000-0000-0000-0000-0000000000f1',
   '11111111-1111-1111-1111-111111111111',
   '10000000-0000-0000-0000-000000000001', 'owner', 'active');

insert into public.resources (id, tenant_id, key, name, kind) values
  ('10000000-0000-0000-0000-0000000000a1',
   '11111111-1111-1111-1111-111111111111', 'post-alpha', 'Alpha Post', 'post');

insert into public.services
  (id, tenant_id, key, name, duration_min, price_cents, currency, required_resource_kind)
values
  ('10000000-0000-0000-0000-0000000000c1',
   '11111111-1111-1111-1111-111111111111', 'alpha-wash', 'Alpha Wash',
   60, 500000, 'RUB', 'post');

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at)
select '11111111-1111-1111-1111-111111111111', w, time '00:00', time '23:59'
from generate_series(1, 7) as w;

insert into public.customers (id, tenant_id, name, phone, phone_normalized) values
  ('10000000-0000-0000-0000-0000000000d1',
   '11111111-1111-1111-1111-111111111111', 'Alpha Customer', '+79001110001', '79001110001');

insert into public.bookings (
  id, tenant_id, customer_id, service_id, resource_id, display_number,
  price_cents, currency, duration_min, buffer_before_min, buffer_after_min,
  service_name_snapshot, starts_at, ends_at, status, access_token_hash, idempotency_hash
) values (
  '10000000-0000-0000-0000-0000000000e1',
  '11111111-1111-1111-1111-111111111111',
  '10000000-0000-0000-0000-0000000000d1',
  '10000000-0000-0000-0000-0000000000c1',
  '10000000-0000-0000-0000-0000000000a1',
  1, 500000, 'RUB', 60, 0, 0, 'Alpha Wash',
  now(), now() + interval '1 hour', 'confirmed',
  digest('p07-token', 'sha256'), digest('p07-idem', 'sha256'));

-- ---------------------------------------------------------------------------
-- Impersonate the active owner of alpha-test.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001"}';

-- Raise the catalogue price AFTER the booking exists.
select public.set_service_price(
  '11111111-1111-1111-1111-111111111111', 'alpha-wash', 700000);

select is(
  (select b.price_cents from public.bookings b where b.id = '10000000-0000-0000-0000-0000000000e1'),
  500000::bigint,
  'a catalogue price change never rewrites the price snapshotted on the booking');

select is(
  (select s.price_cents from public.services s
    where s.tenant_id = '11111111-1111-1111-1111-111111111111' and s.key = 'alpha-wash'),
  700000::bigint,
  'set_service_price updates the catalogue price');

-- Before any payment: nothing received, nothing completed, the quote is scheduled.
select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'receivedPaymentsCents')::bigint,
  0::bigint,
  'owner_stats reports no received payments before any payment is recorded');

select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'completedValueCents')::bigint,
  0::bigint,
  'a confirmed booking contributes no completed value');

select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'scheduledValueCents')::bigint,
  500000::bigint,
  'a confirmed booking is counted as scheduled value, not as revenue');

-- Record an owner payment.
select public.record_payment(
  '11111111-1111-1111-1111-111111111111',
  '10000000-0000-0000-0000-0000000000e1',
  500000, 'cash', 'paid', null, null);

select ok(
  (select p.paid_at from public.payments p
    where p.booking_id = '10000000-0000-0000-0000-0000000000e1') is not null,
  'record_payment with status paid stores a non-null paid_at');

select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'receivedPaymentsCents')::bigint,
  500000::bigint,
  'owner_stats reports the received payment amount for the period');

select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'completedValueCents')::bigint,
  0::bigint,
  'owner_stats reports no completed value while the booking is not completed');

-- Complete the booking.
select is(
  public.set_booking_status(
    '11111111-1111-1111-1111-111111111111',
    '10000000-0000-0000-0000-0000000000e1',
    'completed') ->> 'status',
  'completed',
  'set_booking_status marks the booking completed');

select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'completedOrders')::bigint,
  1::bigint,
  'a completed booking is counted as one completed order');

select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'completedValueCents')::bigint,
  500000::bigint,
  'completedValueCents equals the price snapshotted on the booking');

select is(
  (public.owner_stats('11111111-1111-1111-1111-111111111111',
     (now() at time zone 'Europe/Moscow')::date,
     (now() at time zone 'Europe/Moscow')::date) ->> 'scheduledValueCents')::bigint,
  0::bigint,
  'a completed quote is no longer counted as scheduled value');

select ok(
  length(coalesce(
    public.owner_stats('11111111-1111-1111-1111-111111111111',
      (now() at time zone 'Europe/Moscow')::date,
      (now() at time zone 'Europe/Moscow')::date) ->> 'scheduledNote', '')) > 0,
  'owner_stats carries a non-empty scheduledNote label');

select is(
  public.owner_stats('11111111-1111-1111-1111-111111111111',
    (now() at time zone 'Europe/Moscow')::date,
    (now() at time zone 'Europe/Moscow')::date) -> 'period' ->> 'timezone',
  (select t.timezone from public.tenants t where t.id = '11111111-1111-1111-1111-111111111111'),
  'owner_stats.period.timezone equals the tenant timezone');

reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- A non-member cannot read statistics.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"30000000-0000-0000-0000-000000000003"}';

select throws_ok(
  $$ select public.owner_stats(
       '11111111-1111-1111-1111-111111111111',
       (now() at time zone 'Europe/Moscow')::date,
       (now() at time zone 'Europe/Moscow')::date) $$,
  '42501',
  'not a member of this tenant',
  'a non-member calling owner_stats is rejected with SQLSTATE 42501');

reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
