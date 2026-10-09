-- =============================================================================
-- 01_isolation_and_catalog.test.sql
-- pgTAP suite: tenant isolation under RLS + the public catalogue projection.
--
-- Impersonation mechanism: fixtures are seeded as the default (table-owning,
-- RLS-bypassing) role; to act as a real tenant member we use
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<member-uuid>"}';
-- so auth.uid() (which reads the JWT `sub` claim) resolves to an active
-- public.tenant_members row and app.is_tenant_member() decides visibility.
-- =============================================================================

begin;

select plan(10);

-- ---------------------------------------------------------------------------
-- Fixtures. `set local` / `reset role` are used so impersonation never leaks
-- and the inserts themselves run with the privileges of the owning role.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-000000000001', 'alpha@example.test'),
  ('20000000-0000-0000-0000-000000000002', 'beta@example.test');

insert into public.tenants (id, slug, name, status, timezone) values
  ('11111111-1111-1111-1111-111111111111', 'alpha-test', 'Alpha Test', 'live', 'Europe/Moscow'),
  ('22222222-2222-2222-2222-222222222222', 'beta-test',  'Beta Test',  'live', 'Asia/Almaty');

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
   '22222222-2222-2222-2222-222222222222', 'post-beta',  'Beta Post',  'post');

insert into public.services
  (id, tenant_id, key, name, duration_min, price_cents, currency, required_resource_kind)
values
  ('10000000-0000-0000-0000-0000000000c1',
   '11111111-1111-1111-1111-111111111111', 'alpha-wash', 'Alpha Wash',
   60, 500000, 'RUB', 'post'),
  ('20000000-0000-0000-0000-0000000000c2',
   '22222222-2222-2222-2222-222222222222', 'beta-only', 'Beta Only',
   60, 500000, 'KZT', 'post');

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values
  ('11111111-1111-1111-1111-111111111111', 1, '09:00', '18:00'),
  ('22222222-2222-2222-2222-222222222222', 1, '09:00', '18:00');

insert into public.customers (id, tenant_id, name, phone, phone_normalized) values
  ('10000000-0000-0000-0000-0000000000d1',
   '11111111-1111-1111-1111-111111111111', 'Alpha Customer', '+79000000001', '79000000001'),
  ('20000000-0000-0000-0000-0000000000d2',
   '22222222-2222-2222-2222-222222222222', 'Beta Customer',  '+79000000002', '79000000002');

insert into public.bookings (
  id, tenant_id, customer_id, service_id, resource_id, display_number,
  price_cents, currency, duration_min, buffer_before_min, buffer_after_min,
  service_name_snapshot, starts_at, ends_at, status, access_token_hash, idempotency_hash
) values
  ('10000000-0000-0000-0000-0000000000e1',
   '11111111-1111-1111-1111-111111111111',
   '10000000-0000-0000-0000-0000000000d1',
   '10000000-0000-0000-0000-0000000000c1',
   '10000000-0000-0000-0000-0000000000a1',
   1, 500000, 'RUB', 60, 0, 0, 'Alpha Wash',
   now() + interval '2 days', now() + interval '2 days 1 hour', 'confirmed',
   digest('alpha-booking-token', 'sha256'), digest('alpha-idem', 'sha256')),
  ('20000000-0000-0000-0000-0000000000e2',
   '22222222-2222-2222-2222-222222222222',
   '20000000-0000-0000-0000-0000000000d2',
   '20000000-0000-0000-0000-0000000000c2',
   '20000000-0000-0000-0000-0000000000b2',
   1, 500000, 'KZT', 60, 0, 0, 'Beta Only',
   now() + interval '2 days', now() + interval '2 days 1 hour', 'confirmed',
   digest('beta-booking-token', 'sha256'), digest('beta-idem', 'sha256'));

insert into public.payments
  (tenant_id, booking_id, amount_cents, currency, method, status, paid_at)
values
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-0000000000e1',
   500000, 'RUB', 'cash', 'paid', now()),
  ('22222222-2222-2222-2222-222222222222', '20000000-0000-0000-0000-0000000000e2',
   500000, 'KZT', 'cash', 'paid', now());

insert into public.notification_jobs (tenant_id, booking_id, kind, channel, dedup_key) values
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-0000000000e1',
   'booking_created', 'push', 'alpha-job-1'),
  ('22222222-2222-2222-2222-222222222222', '20000000-0000-0000-0000-0000000000e2',
   'booking_created', 'push', 'beta-job-1');

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation under RLS.
--    Impersonate an active member of alpha-test (mechanism: SET LOCAL ROLE
--    plus SET LOCAL request.jwt.claims, the claim auth.uid() reads).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001"}';

select is( (select count(*) from public.bookings)::int,          1,
           'RLS: member of alpha sees only alpha bookings');
select is( (select count(*) from public.customers)::int,         1,
           'RLS: member of alpha sees only alpha customers');
select is( (select count(*) from public.payments)::int,          1,
           'RLS: member of alpha sees only alpha payments');
select is( (select count(*) from public.notification_jobs)::int, 1,
           'RLS: member of alpha sees only alpha notification jobs');

reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 2. Public catalogue projection: alpha's own keys present, beta's absent.
-- ---------------------------------------------------------------------------
select is(
  (public.public_tenant_profile('alpha-test') -> 'services')::text like '%alpha-wash%',
  true,
  'public_tenant_profile(alpha-test) contains the alpha service key'
);
select is(
  (public.public_tenant_profile('alpha-test') -> 'services')::text like '%beta-only%',
  false,
  'public_tenant_profile(alpha-test) leaks no beta service key'
);

-- ---------------------------------------------------------------------------
-- 3. A cross-tenant service key is rejected by create_booking with BK004.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.create_booking(
       'alpha-test', 'beta-only', now() + interval '3 days',
       'Test User', '+79000000009'
     ) $$,
  'BK004',
  'BK004: unknown service',
  'create_booking rejects a service key that exists only in another tenant'
);

-- ---------------------------------------------------------------------------
-- 4. Composite-FK guarantee: alpha tenant_id + beta service_id is refused.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
  insert into public.bookings (
    tenant_id, customer_id, service_id, resource_id, display_number,
    price_cents, currency, duration_min, buffer_before_min, buffer_after_min,
    service_name_snapshot, starts_at, ends_at, access_token_hash, idempotency_hash
  ) values (
    '11111111-1111-1111-1111-111111111111',
    '10000000-0000-0000-0000-0000000000d1',
    '20000000-0000-0000-0000-0000000000c2',
    '10000000-0000-0000-0000-0000000000a1',
    999, 500000, 'RUB', 60, 0, 0, 'Cross',
    now() + interval '1 day', now() + interval '1 day 1 hour',
    digest('cross-token', 'sha256'), digest('cross-idem', 'sha256')
  )
  $$,
  '23503',
  'booking with a foreign tenant service violates the composite foreign key'
);

-- ---------------------------------------------------------------------------
-- 5. Token lookup: the right hash returns the booking, an unknown one returns
--    NULL.
-- ---------------------------------------------------------------------------
select is(
  (public.get_booking_by_token(digest('alpha-booking-token', 'sha256')) ->> 'bookingId'),
  '10000000-0000-0000-0000-0000000000e1',
  'get_booking_by_token returns the booking for the matching token hash'
);
select ok(
  public.get_booking_by_token(digest('no-such-token', 'sha256')) is null,
  'get_booking_by_token returns NULL for an unrelated token hash'
);

select * from finish();
rollback;
