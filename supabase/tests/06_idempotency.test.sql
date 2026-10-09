-- =============================================================================
-- 06_idempotency.test.sql
-- pgTAP suite: idempotent create / cancel / reschedule.
--
-- What is proven here:
--   * a retried create with the same idempotency key, request hash and payload
--     returns the SAME booking and sets replayed = true (exactly one booking row);
--   * the same key with a DIFFERENT request hash raises BK008;
--   * a retried cancel is a replay and records no second booking_cancelled event;
--   * a retried reschedule moves the booking only once (rescheduled_count = 1);
--   * a FAILED reschedule (new moment already taken) raises BK001 and leaves the
--     original booking and its single occupancy row completely untouched.
--
-- Fixtures are inserted as the default table-owning role; the create/cancel/
-- reschedule RPCs are SECURITY DEFINER and are exercised directly. All moments
-- are expressed relative to now() in the tenant timezone (Europe/Moscow).
-- =============================================================================

begin;

select plan(15);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-000000000001', 'alpha@example.test');

insert into public.tenants (id, slug, name, status, timezone) values
  ('11111111-1111-1111-1111-111111111111', 'alpha-test', 'Alpha Test', 'live', 'Europe/Moscow');

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

-- A working window on every weekday so the target date is always open. The slot
-- grid is anchored at local midnight, so :00 / :30 start moments align.
insert into public.business_hours (tenant_id, weekday, opens_at, closes_at)
select '11111111-1111-1111-1111-111111111111', w, time '00:00', time '23:59'
from generate_series(1, 7) as w;

create temporary table idem06 (step text primary key, body jsonb);

-- ---------------------------------------------------------------------------
-- 1-4: create_booking replay.
-- ---------------------------------------------------------------------------
insert into idem06 (step, body) values ('create1',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '10:00') at time zone 'Europe/Moscow'),
    'Idem User', '+79001110001', null, null, null, null,
    'idem-create-1', 'hash-create-1'));

insert into idem06 (step, body) values ('create2',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '10:00') at time zone 'Europe/Moscow'),
    'Idem User', '+79001110001', null, null, null, null,
    'idem-create-1', 'hash-create-1'));

select is(
  (select (body ->> 'replayed')::boolean from idem06 where step = 'create1'),
  false,
  'create_booking first call reports replayed = false');

select is(
  (select body ->> 'bookingId' from idem06 where step = 'create2'),
  (select body ->> 'bookingId' from idem06 where step = 'create1'),
  'create_booking replay returns the same bookingId');

select is(
  (select (body ->> 'replayed')::boolean from idem06 where step = 'create2'),
  true,
  'create_booking replay reports replayed = true');

select is(
  (select count(*)::int from public.bookings
    where tenant_id = '11111111-1111-1111-1111-111111111111'
      and idempotency_hash = digest('idem-create-1', 'sha256')),
  1,
  'create_booking replay leaves exactly one booking row for the customer');

-- ---------------------------------------------------------------------------
-- 5: same key, different request hash -> BK008.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.create_booking(
       'alpha-test', 'alpha-wash',
       ((((now() at time zone 'Europe/Moscow')::date + 2) + time '10:00') at time zone 'Europe/Moscow'),
       'Idem User', '+79001110001', null, null, null, null,
       'idem-create-1', 'hash-create-other') $$,
  'BK008',
  'BK008: this idempotency key was used with a different payload',
  'reusing an idempotency key with a different request hash raises BK008');

-- ---------------------------------------------------------------------------
-- 6-8: cancel_booking replay.
-- ---------------------------------------------------------------------------
insert into idem06 (step, body) values ('cancel0',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '11:00') at time zone 'Europe/Moscow'),
    'Cancel User', '+79001110002', null, null, null,
    digest('cancel-token', 'sha256'), null, null));

insert into idem06 (step, body) values ('cancel1',
  public.cancel_booking(digest('cancel-token', 'sha256'), 'test cancel', 'idem-cancel-1', 'hash-cancel-1'));

insert into idem06 (step, body) values ('cancel2',
  public.cancel_booking(digest('cancel-token', 'sha256'), 'test cancel', 'idem-cancel-1', 'hash-cancel-1'));

select is(
  (select body ->> 'status' from idem06 where step = 'cancel1'),
  'cancelled',
  'cancel_booking cancels the booking on the first call');

select is(
  (select (body ->> 'replayed')::boolean from idem06 where step = 'cancel2'),
  true,
  'cancel_booking replay reports replayed = true');

select is(
  (select count(*)::int from public.booking_events
    where booking_id = (select (body ->> 'bookingId')::uuid from idem06 where step = 'cancel0')
      and event = 'booking_cancelled'),
  1,
  'cancelling twice records exactly one booking_cancelled event');

-- ---------------------------------------------------------------------------
-- 9-10: reschedule_booking replay moves the booking only once.
-- ---------------------------------------------------------------------------
insert into idem06 (step, body) values ('resched0',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '12:00') at time zone 'Europe/Moscow'),
    'Resched User', '+79001110003', null, null, null,
    digest('resched-token', 'sha256'), null, null));

insert into idem06 (step, body) values ('resched1',
  public.reschedule_booking(
    digest('resched-token', 'sha256'),
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '13:00') at time zone 'Europe/Moscow'),
    'idem-resched-1', 'hash-resched-1'));

insert into idem06 (step, body) values ('resched2',
  public.reschedule_booking(
    digest('resched-token', 'sha256'),
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '13:00') at time zone 'Europe/Moscow'),
    'idem-resched-1', 'hash-resched-1'));

select is(
  (select b.rescheduled_count from public.bookings b
    where b.id = (select (body ->> 'bookingId')::uuid from idem06 where step = 'resched0')),
  1,
  'reschedule_booking replay increments rescheduled_count only once');

select is(
  (select b.starts_at from public.bookings b
    where b.id = (select (body ->> 'bookingId')::uuid from idem06 where step = 'resched0')),
  ((((now() at time zone 'Europe/Moscow')::date + 2) + time '13:00') at time zone 'Europe/Moscow'),
  'reschedule_booking replay keeps the booking at the new moment');

-- ---------------------------------------------------------------------------
-- 11-15: a failed reschedule leaves the original booking intact.
-- ---------------------------------------------------------------------------
insert into idem06 (step, body) values ('a0',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '14:00') at time zone 'Europe/Moscow'),
    'Collide A', '+79001110004', null, null, null,
    digest('token-a', 'sha256'), null, null));

insert into idem06 (step, body) values ('b0',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '15:00') at time zone 'Europe/Moscow'),
    'Collide B', '+79001110005', null, null, null,
    digest('token-b', 'sha256'), null, null));

select throws_ok(
  $$ select public.reschedule_booking(
       digest('token-a', 'sha256'),
       ((((now() at time zone 'Europe/Moscow')::date + 2) + time '15:00') at time zone 'Europe/Moscow')) $$,
  'BK001',
  'BK001: no resource is free for the requested moment',
  'a reschedule onto a moment that is already taken raises BK001');

select is(
  (select b.starts_at from public.bookings b
    where b.id = (select (body ->> 'bookingId')::uuid from idem06 where step = 'a0')),
  ((((now() at time zone 'Europe/Moscow')::date + 2) + time '14:00') at time zone 'Europe/Moscow'),
  'a failed reschedule leaves the original starts_at untouched');

select is(
  (select b.ends_at from public.bookings b
    where b.id = (select (body ->> 'bookingId')::uuid from idem06 where step = 'a0')),
  ((((now() at time zone 'Europe/Moscow')::date + 2) + time '15:00') at time zone 'Europe/Moscow'),
  'a failed reschedule leaves the original ends_at untouched');

select is(
  (select count(*)::int from public.resource_occupancies o
    where o.booking_id = (select (body ->> 'bookingId')::uuid from idem06 where step = 'a0')),
  1,
  'a failed reschedule leaves exactly one occupancy row');

select ok(
  (select lower(o.period) = ((((now() at time zone 'Europe/Moscow')::date + 2) + time '14:00') at time zone 'Europe/Moscow')
     and upper(o.period) = ((((now() at time zone 'Europe/Moscow')::date + 2) + time '15:00') at time zone 'Europe/Moscow')
   from public.resource_occupancies o
   where o.booking_id = (select (body ->> 'bookingId')::uuid from idem06 where step = 'a0')),
  'the surviving occupancy still points at the original interval');

select * from finish();
rollback;
