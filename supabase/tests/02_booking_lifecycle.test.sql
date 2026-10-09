-- =============================================================================
-- 02_booking_lifecycle.test.sql
-- pgTAP suite: the customer booking lifecycle through the public RPCs.
--
-- Covered: create_booking -> reschedule_booking -> cancel_booking, the single
-- occupancy row that backs a booking, the audit trail in booking_events and the
-- customer token projection (get_booking_by_token).
--
-- Fixtures are seeded as the default (table-owning, RLS-bypassing) role, exactly
-- like 01_isolation_and_catalog.test.sql. No member impersonation is needed here
-- because the booking RPCs are SECURITY DEFINER and granted to anon. Every
-- fixture moment is relative to now() and lands inside the 09:00-18:00 window of
-- the tenant timezone (Europe/Moscow has no DST, so the local wall clock is
-- stable across the whole transaction).
-- =============================================================================

begin;

select plan(13);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-00000000000a', 'life-owner@example.test');

insert into public.tenants (id, slug, name, status, timezone) values
  ('aaaa0000-0000-0000-0000-000000000001', 'life-test', 'Lifecycle Test',
   'live', 'Europe/Moscow');

insert into public.tenant_members (id, tenant_id, user_id, role, status) values
  ('aaaa0000-0000-0000-0000-0000000000f1',
   'aaaa0000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000a', 'owner', 'active');

insert into public.resources (id, tenant_id, key, name, kind, sort_order) values
  ('aaaa0000-0000-0000-0000-0000000000a1',
   'aaaa0000-0000-0000-0000-000000000001', 'life-post', 'Life Test Post',
   'post', 0);

insert into public.services
  (id, tenant_id, key, name, duration_min, price_cents, currency, required_resource_kind)
values
  ('aaaa0000-0000-0000-0000-0000000000c1',
   'aaaa0000-0000-0000-0000-000000000001', 'life-wash', 'Life Wash',
   60, 500000, 'RUB', 'post');

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values
  ('aaaa0000-0000-0000-0000-000000000001', 1, '09:00', '18:00'),
  ('aaaa0000-0000-0000-0000-000000000001', 2, '09:00', '18:00'),
  ('aaaa0000-0000-0000-0000-000000000001', 3, '09:00', '18:00'),
  ('aaaa0000-0000-0000-0000-000000000001', 4, '09:00', '18:00'),
  ('aaaa0000-0000-0000-0000-000000000001', 5, '09:00', '18:00'),
  ('aaaa0000-0000-0000-0000-000000000001', 6, '09:00', '18:00'),
  ('aaaa0000-0000-0000-0000-000000000001', 7, '09:00', '18:00');

-- ---------------------------------------------------------------------------
-- create_booking at a valid, aligned slot two days ahead.
-- ---------------------------------------------------------------------------
select public.create_booking(
  p_tenant_slug   => 'life-test',
  p_service_key   => 'life-wash',
  p_starts_at     => (date_trunc('day', now() at time zone 'Europe/Moscow')
                      + interval '2 days' + time '09:00') at time zone 'Europe/Moscow',
  p_customer_name => 'Lifecycle Customer',
  p_customer_phone=> '+79990000001',
  p_customer_email=> 'life-customer@example.test',
  p_booking_id    => 'aaaa0000-0000-0000-0000-0000000000e1',
  p_token_hash    => digest('life-token', 'sha256')
);

select is(
  (select b.status::text from public.bookings b
     where b.id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  'confirmed',
  'create_booking stores the new booking as confirmed'
);

select ok(
  (select b.display_number <> 0 from public.bookings b
     where b.id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  'create_booking assigns a non-zero display_number'
);

select is(
  (select count(*)::int from public.resource_occupancies o
     where o.booking_id = 'aaaa0000-0000-0000-0000-0000000000e1'
       and o.kind = 'booking'),
  1,
  'exactly one booking occupancy row exists for the booking'
);

select is(
  (select o.period::text from public.resource_occupancies o
     where o.booking_id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  (select b.occupancy::text from public.bookings b
     where b.id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  'the occupancy period equals the booking occupancy interval'
);

-- ---------------------------------------------------------------------------
-- reschedule_booking moves the booking to the next day at the same slot.
-- ---------------------------------------------------------------------------
select public.reschedule_booking(
  p_token_hash    => digest('life-token', 'sha256'),
  p_new_starts_at => (date_trunc('day', now() at time zone 'Europe/Moscow')
                      + interval '3 days' + time '09:00') at time zone 'Europe/Moscow'
);

select is(
  (select o.period::text from public.resource_occupancies o
     where o.booking_id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  tstzrange(
    (date_trunc('day', now() at time zone 'Europe/Moscow')
     + interval '3 days' + time '09:00') at time zone 'Europe/Moscow',
    (date_trunc('day', now() at time zone 'Europe/Moscow')
     + interval '3 days' + time '09:00') at time zone 'Europe/Moscow'
     + interval '1 hour',
    '[)'
  )::text,
  'reschedule_booking replaces the occupancy with the new interval'
);

select is(
  (select count(*)::int from public.resource_occupancies o
     where o.booking_id = 'aaaa0000-0000-0000-0000-0000000000e1'
       and o.kind = 'booking'),
  1,
  'reschedule_booking leaves exactly one booking occupancy row'
);

select is(
  (select b.rescheduled_count from public.bookings b
     where b.id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  1,
  'reschedule_booking increments rescheduled_count to 1'
);

select is(
  (select count(*)::int from public.booking_events e
     where e.booking_id = 'aaaa0000-0000-0000-0000-0000000000e1'
       and e.event = 'booking_rescheduled'),
  1,
  'reschedule_booking writes a booking_rescheduled audit event'
);

-- ---------------------------------------------------------------------------
-- cancel_booking
-- ---------------------------------------------------------------------------
select public.cancel_booking(
  p_token_hash => digest('life-token', 'sha256'),
  p_reason     => 'customer changed their mind'
);

select is(
  (select b.status::text from public.bookings b
     where b.id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  'cancelled',
  'cancel_booking sets the booking status to cancelled'
);

select ok(
  (select b.cancelled_at is not null from public.bookings b
     where b.id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  'cancel_booking records cancelled_at'
);

select is(
  (select count(*)::int from public.resource_occupancies o
     where o.booking_id = 'aaaa0000-0000-0000-0000-0000000000e1'),
  0,
  'cancel_booking deletes the booking occupancy row'
);

select is(
  (select count(*)::int from public.booking_events e
     where e.booking_id = 'aaaa0000-0000-0000-0000-0000000000e1'
       and e.event = 'booking_cancelled'),
  1,
  'cancel_booking writes a booking_cancelled audit event'
);

select is(
  public.get_booking_by_token(digest('life-token', 'sha256')) ->> 'canCancel',
  'false',
  'get_booking_by_token reports canCancel=false after cancellation'
);

select * from finish();
rollback;
