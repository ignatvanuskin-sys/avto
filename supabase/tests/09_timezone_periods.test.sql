-- =============================================================================
-- 09_timezone_periods.test.sql
-- pgTAP suite: reporting periods and availability follow the tenant timezone.
--
-- What is proven here:
--   * two tenants with different timezones report their own period.timezone;
--   * a booking at 23:00 local time on the LAST day of a period is counted inside
--     that period (visits = 1) and falls outside a period ending one day earlier
--     (visits = 0) — the period is a tenant-local calendar range, not a UTC one;
--   * available_slots for the Almaty tenant returns timestamps that land inside
--     the Almaty working window when converted to Asia/Almaty, and outside the
--     Moscow window when converted to Europe/Moscow.
--
-- Fixtures are inserted as the default table-owning role; owner_stats is called
-- while impersonating each tenant's active owner. All moments are relative to
-- now() expressed in the relevant tenant timezone.
-- =============================================================================

begin;

select plan(8);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-000000000001', 'alpha@example.test'),
  ('20000000-0000-0000-0000-000000000002', 'beta@example.test');

insert into public.tenants (id, slug, name, status, timezone, currency) values
  ('11111111-1111-1111-1111-111111111111', 'alpha-test', 'Alpha Test', 'live', 'Europe/Moscow', 'RUB'),
  ('22222222-2222-2222-2222-222222222222', 'beta-test',  'Beta Test',  'live', 'Asia/Almaty',   'KZT');

insert into public.tenant_members (id, tenant_id, user_id, role, status) values
  ('10000000-0000-0000-0000-0000000000f1',
   '11111111-1111-1111-1111-111111111111',
   '10000000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('20000000-0000-0000-0000-0000000000f2',
   '22222222-2222-2222-2222-222222222222',
   '20000000-0000-0000-0000-000000000002', 'owner', 'active');

insert into public.resources (id, tenant_id, key, name, kind) values
  ('10000000-0000-0000-0000-0000000000a1',
   '11111111-1111-1111-1111-111111111111', 'post-alpha', 'Alpha Post', 'post'),
  ('20000000-0000-0000-0000-0000000000b2',
   '22222222-2222-2222-2222-222222222222', 'post-beta', 'Beta Post', 'post');

insert into public.services
  (id, tenant_id, key, name, duration_min, price_cents, currency, required_resource_kind)
values
  ('10000000-0000-0000-0000-0000000000c1',
   '11111111-1111-1111-1111-111111111111', 'alpha-wash', 'Alpha Wash', 60, 500000, 'RUB', 'post'),
  ('20000000-0000-0000-0000-0000000000c2',
   '22222222-2222-2222-2222-222222222222', 'beta-wash', 'Beta Wash', 60, 500000, 'KZT', 'post');

-- Both tenants work 09:00-18:00 local; the Almaty and Moscow windows therefore
-- denote different absolute instants.
insert into public.business_hours (tenant_id, weekday, opens_at, closes_at)
select t.id, w, time '09:00', time '18:00'
from (values ('11111111-1111-1111-1111-111111111111'::uuid),
             ('22222222-2222-2222-2222-222222222222'::uuid)) as t(id)
cross join generate_series(1, 7) as w;

insert into public.customers (id, tenant_id, name, phone, phone_normalized) values
  ('20000000-0000-0000-0000-0000000000d2',
   '22222222-2222-2222-2222-222222222222', 'Beta Customer', '+79002220002', '79002220002');

-- The boundary booking: 23:00 on the last local day of the period.
insert into public.bookings (
  id, tenant_id, customer_id, service_id, resource_id, display_number,
  price_cents, currency, duration_min, buffer_before_min, buffer_after_min,
  service_name_snapshot, starts_at, ends_at, status, access_token_hash, idempotency_hash
) values (
  '20000000-0000-0000-0000-0000000000e2',
  '22222222-2222-2222-2222-222222222222',
  '20000000-0000-0000-0000-0000000000d2',
  '20000000-0000-0000-0000-0000000000c2',
  '20000000-0000-0000-0000-0000000000b2',
  1, 500000, 'KZT', 60, 0, 0, 'Beta Wash',
  ((((now() at time zone 'Asia/Almaty')::date) + time '23:00') at time zone 'Asia/Almaty'),
  ((((now() at time zone 'Asia/Almaty')::date) + time '23:00') at time zone 'Asia/Almaty') + interval '1 hour',
  'confirmed', digest('tz-token', 'sha256'), digest('tz-idem', 'sha256'));

-- ---------------------------------------------------------------------------
-- 1-4: per-tenant period timezone and the local last-day boundary.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001"}';

select is(
  public.owner_stats(
    '11111111-1111-1111-1111-111111111111',
    (now() at time zone 'Europe/Moscow')::date,
    (now() at time zone 'Europe/Moscow')::date) -> 'period' ->> 'timezone',
  'Europe/Moscow',
  'the Moscow tenant reports its own period timezone');

set local request.jwt.claims = '{"sub":"20000000-0000-0000-0000-000000000002"}';

select is(
  public.owner_stats(
    '22222222-2222-2222-2222-222222222222',
    (now() at time zone 'Asia/Almaty')::date,
    (now() at time zone 'Asia/Almaty')::date) -> 'period' ->> 'timezone',
  'Asia/Almaty',
  'the Almaty tenant reports its own period timezone');

select is(
  (public.owner_stats(
    '22222222-2222-2222-2222-222222222222',
    (now() at time zone 'Asia/Almaty')::date,
    (now() at time zone 'Asia/Almaty')::date) ->> 'visits')::bigint,
  1::bigint,
  'the 23:00 local booking is counted inside the period that ends on its own day');

select is(
  (public.owner_stats(
    '22222222-2222-2222-2222-222222222222',
    (now() at time zone 'Asia/Almaty')::date - 1,
    (now() at time zone 'Asia/Almaty')::date - 1) ->> 'visits')::bigint,
  0::bigint,
  'the same booking is outside a period ending one local day earlier');

reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 5-7: availability is generated in the tenant timezone.
--    The Almaty slots, converted back to Asia/Almaty, must fall inside the
--    Almaty 09:00-18:00 window; converted to Europe/Moscow they do not.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
   from public.available_slots(
     'beta-test', 'beta-wash',
     (now() at time zone 'Asia/Almaty')::date + 1,
     (now() at time zone 'Asia/Almaty')::date + 1) s
   where (s.slot_start at time zone 'Asia/Almaty')::time < time '09:00'
      or (s.slot_start at time zone 'Asia/Almaty')::time >= time '18:00'),
  0,
  'every Almaty slot lands inside the Almaty working window');

select ok(
  exists (
    select 1
    from public.available_slots(
      'beta-test', 'beta-wash',
      (now() at time zone 'Asia/Almaty')::date + 1,
      (now() at time zone 'Asia/Almaty')::date + 1) s
    where (s.slot_start at time zone 'Europe/Moscow')::time < time '09:00'
       or (s.slot_start at time zone 'Europe/Moscow')::time >= time '18:00'),
  'the same Almaty slots fall outside the Moscow working window');

select ok(
  (select count(*)
   from public.available_slots(
     'beta-test', 'beta-wash',
     (now() at time zone 'Asia/Almaty')::date + 1,
     (now() at time zone 'Asia/Almaty')::date + 1)) > 0,
  'available_slots returns at least one slot for the Almaty tenant');

-- ---------------------------------------------------------------------------
-- 8: the fixture really is 23:00 local in Asia/Almaty.
-- ---------------------------------------------------------------------------
select is(
  (select to_char(b.starts_at at time zone 'Asia/Almaty', 'HH24:MI')
     from public.bookings b where b.id = '20000000-0000-0000-0000-0000000000e2'),
  '23:00',
  'the boundary booking is a 23:00 Asia/Almaty local moment');

select * from finish();
rollback;
