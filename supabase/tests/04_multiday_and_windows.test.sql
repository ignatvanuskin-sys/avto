-- =============================================================================
-- 04_multiday_and_windows.test.sql
-- pgTAP suite: multi-day services, working-window fit, lead time, booking
-- horizon, slot-grid alignment and schedule exceptions.
--
-- Fixtures are seeded as the default (table-owning, RLS-bypassing) role; the
-- public RPCs (create_booking / available_slots) are SECURITY DEFINER and are
-- granted to anon, so no member impersonation is required here.
--
-- The tenant timezone is authoritative for working windows. All moments are
-- relative to now() and expressed through the tenant timezone Europe/Moscow
-- (no DST), so every "day + N" value is a stable wall-clock 09:00 slot that is
-- aligned to the 30-minute slot grid (offset 0 from the window lower bound).
-- =============================================================================

begin;

select plan(10);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name, status, timezone) values
  ('eeee0000-0000-0000-0000-000000000001', 'win-test', 'Windows Test',
   'live', 'Europe/Moscow');

insert into public.resources (id, tenant_id, key, name, kind, sort_order) values
  ('eeee0000-0000-0000-0000-0000000000a1',
   'eeee0000-0000-0000-0000-000000000001', 'win-post', 'Windows Post', 'post', 0);

insert into public.services
  (id, tenant_id, key, name, duration_min, buffer_before_min, buffer_after_min,
   price_cents, currency, required_resource_kind, spans_days)
values
  ('eeee0000-0000-0000-0000-0000000000c1',
   'eeee0000-0000-0000-0000-000000000001', 'win-multiday', 'Windows Multiday',
   2880, 30, 45, 800000, 'RUB', 'post', true),
  ('eeee0000-0000-0000-0000-0000000000c2',
   'eeee0000-0000-0000-0000-000000000001', 'win-toolong', 'Windows Too Long',
   600, 0, 0, 300000, 'RUB', 'post', false),
  ('eeee0000-0000-0000-0000-0000000000c3',
   'eeee0000-0000-0000-0000-000000000001', 'win-fits', 'Windows Fits',
   60, 0, 0, 200000, 'RUB', 'post', false);

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values
  ('eeee0000-0000-0000-0000-000000000001', 1, '09:00', '18:00'),
  ('eeee0000-0000-0000-0000-000000000001', 2, '09:00', '18:00'),
  ('eeee0000-0000-0000-0000-000000000001', 3, '09:00', '18:00'),
  ('eeee0000-0000-0000-0000-000000000001', 4, '09:00', '18:00'),
  ('eeee0000-0000-0000-0000-000000000001', 5, '09:00', '18:00'),
  ('eeee0000-0000-0000-0000-000000000001', 6, '09:00', '18:00'),
  ('eeee0000-0000-0000-0000-000000000001', 7, '09:00', '18:00');

-- ---------------------------------------------------------------------------
-- 1-2. A spans_days service: 2880-minute duration + 30-minute before-buffer +
--      45-minute after-buffer is ONE occupancy spanning 2955 minutes.
-- ---------------------------------------------------------------------------
select public.create_booking(
  p_tenant_slug   => 'win-test',
  p_service_key   => 'win-multiday',
  p_starts_at     => (date_trunc('day', now() at time zone 'Europe/Moscow')
                      + interval '20 days' + time '09:00') at time zone 'Europe/Moscow',
  p_customer_name => 'Multiday Customer',
  p_customer_phone=> '+79990000006',
  p_booking_id    => 'eeee0000-0000-0000-0000-0000000000e1',
  p_token_hash    => digest('win-multiday-token', 'sha256')
);

select is(
  (select count(*)::int from public.resource_occupancies o
     where o.booking_id = 'eeee0000-0000-0000-0000-0000000000e1'),
  1,
  'a spans_days service produces exactly one occupancy row'
);

select is(
  (select (extract(epoch from (upper(o.period) - lower(o.period))) / 60)::int
     from public.resource_occupancies o
     where o.booking_id = 'eeee0000-0000-0000-0000-0000000000e1'),
  2955,
  'the multi-day occupancy spans duration plus both buffers (2880 + 30 + 45 minutes)'
);

-- ---------------------------------------------------------------------------
-- 3. A same-day service that cannot fit the 09:00-18:00 window -> BK001.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
  select public.create_booking(
    'win-test', 'win-toolong',
    (date_trunc('day', now() at time zone 'Europe/Moscow')
     + interval '2 days' + time '09:00') at time zone 'Europe/Moscow',
    'Too Long Customer', '+79990000007'
  )
  $$,
  'BK001',
  null,
  'a same-day service larger than the working window is rejected with BK001'
);

-- ---------------------------------------------------------------------------
-- 4. A start before now() + booking_lead_minutes -> BK002.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
  select public.create_booking(
    'win-test', 'win-fits',
    now() + interval '5 minutes',
    'Too Soon Customer', '+79990000008'
  )
  $$,
  'BK002',
  null,
  'a start before now() + booking_lead_minutes is rejected with BK002'
);

-- ---------------------------------------------------------------------------
-- 5. A start beyond now() + booking_horizon_days -> BK003.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
  select public.create_booking(
    'win-test', 'win-fits',
    now() + interval '100 days',
    'Too Far Customer', '+79990000009'
  )
  $$,
  'BK003',
  null,
  'a start beyond now() + booking_horizon_days is rejected with BK003'
);

-- ---------------------------------------------------------------------------
-- 6. A start inside the window but off the slot grid -> BK001.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
  select public.create_booking(
    'win-test', 'win-fits',
    (date_trunc('day', now() at time zone 'Europe/Moscow')
     + interval '2 days' + time '09:15') at time zone 'Europe/Moscow',
    'Unaligned Customer', '+79990000010'
  )
  $$,
  'BK001',
  null,
  'a start not aligned to slot_step_minutes is rejected with BK001'
);

-- ---------------------------------------------------------------------------
-- 7-8. A closed schedule exception yields zero slots that day, while the same
--      weekday without an exception still yields slots.
-- ---------------------------------------------------------------------------
insert into public.schedule_exceptions (tenant_id, on_date, is_closed, note) values
  ('eeee0000-0000-0000-0000-000000000001',
   (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '4 days')::date,
   true, 'closed for testing');

select is(
  (select count(*)::int
     from public.available_slots(
       'win-test', 'win-fits',
       (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '4 days')::date,
       (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '4 days')::date
     )),
  0,
  'a closed schedule exception yields zero available slots for that day'
);

select cmp_ok(
  (select count(*)::int
     from public.available_slots(
       'win-test', 'win-fits',
       (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '11 days')::date,
       (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '11 days')::date
     )),
  '>=', 1,
  'the same weekday without an exception still yields at least one slot'
);

-- ---------------------------------------------------------------------------
-- 9-10. A shortened open exception yields slots only inside its narrow window.
-- ---------------------------------------------------------------------------
insert into public.schedule_exceptions
  (tenant_id, on_date, is_closed, opens_at, closes_at, note) values
  ('eeee0000-0000-0000-0000-000000000001',
   (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '5 days')::date,
   false, '12:00', '13:00', 'shortened day');

select cmp_ok(
  (select count(*)::int
     from public.available_slots(
       'win-test', 'win-fits',
       (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '5 days')::date,
       (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '5 days')::date
     )),
  '>=', 1,
  'a shortened open exception still yields at least one slot'
);

select ok(
  (select bool_and(
      s.slot_start >= ((date_trunc('day', now() at time zone 'Europe/Moscow')
                        + interval '5 days' + time '12:00') at time zone 'Europe/Moscow')
      and s.slot_start < ((date_trunc('day', now() at time zone 'Europe/Moscow')
                           + interval '5 days' + time '13:00') at time zone 'Europe/Moscow')
    )
   from public.available_slots(
     'win-test', 'win-fits',
     (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '5 days')::date,
     (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '5 days')::date
   ) s),
  'every slot on the shortened day lies inside the exception window'
);

select * from finish();
rollback;
