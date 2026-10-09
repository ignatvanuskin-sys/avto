-- =============================================================================
-- 05_blocking.test.sql
-- pgTAP suite: manual resource blocks share the booking occupancy table, so a
-- block and a booking can never overlap, and releasing a block frees the slot.
--
-- Fixtures are seeded as the default (table-owning, RLS-bypassing) role. Owner
-- RPCs (block_resource / release_occupancy) re-check membership via
-- app.require_member, so they are exercised under impersonation:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<member-uuid>"}';
-- and reset with `reset role` + clearing request.jwt.claims, exactly like
-- 01_isolation_and_catalog.test.sql. All moments are relative to now() and land
-- inside the 09:00-18:00 window of the Europe/Moscow (no DST) tenant timezone.
-- =============================================================================

begin;

select plan(9);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-00000000000b', 'block-owner@example.test'),
  ('20000000-0000-0000-0000-00000000000c', 'block-outsider@example.test');

insert into public.tenants (id, slug, name, status, timezone) values
  ('dddd0000-0000-0000-0000-000000000001', 'block-test', 'Block Test',
   'live', 'Europe/Moscow');

insert into public.tenant_members (id, tenant_id, user_id, role, status) values
  ('dddd0000-0000-0000-0000-0000000000f1',
   'dddd0000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000b', 'owner', 'active');

insert into public.resources (id, tenant_id, key, name, kind, sort_order) values
  ('dddd0000-0000-0000-0000-0000000000a1',
   'dddd0000-0000-0000-0000-000000000001', 'block-post', 'Block Test Post',
   'post', 0);

insert into public.services
  (id, tenant_id, key, name, duration_min, price_cents, currency, required_resource_kind)
values
  ('dddd0000-0000-0000-0000-0000000000c1',
   'dddd0000-0000-0000-0000-000000000001', 'block-wash', 'Block Wash',
   60, 500000, 'RUB', 'post');

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values
  ('dddd0000-0000-0000-0000-000000000001', 1, '09:00', '18:00'),
  ('dddd0000-0000-0000-0000-000000000001', 2, '09:00', '18:00'),
  ('dddd0000-0000-0000-0000-000000000001', 3, '09:00', '18:00'),
  ('dddd0000-0000-0000-0000-000000000001', 4, '09:00', '18:00'),
  ('dddd0000-0000-0000-0000-000000000001', 5, '09:00', '18:00'),
  ('dddd0000-0000-0000-0000-000000000001', 6, '09:00', '18:00'),
  ('dddd0000-0000-0000-0000-000000000001', 7, '09:00', '18:00');

-- ---------------------------------------------------------------------------
-- The owner blocks 09:00-12:00 two days ahead.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-00000000000b"}';

select public.block_resource(
  p_tenant_id   => 'dddd0000-0000-0000-0000-000000000001',
  p_resource_id => 'dddd0000-0000-0000-0000-0000000000a1',
  p_starts_at   => (date_trunc('day', now() at time zone 'Europe/Moscow')
                    + interval '2 days' + time '09:00') at time zone 'Europe/Moscow',
  p_ends_at     => (date_trunc('day', now() at time zone 'Europe/Moscow')
                    + interval '2 days' + time '12:00') at time zone 'Europe/Moscow',
  p_reason      => 'maintenance'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- 1-3. The block row has the required shape.
select is(
  (select count(*)::int from public.resource_occupancies o
     where o.tenant_id = 'dddd0000-0000-0000-0000-000000000001'
       and o.kind = 'block'),
  1,
  'block_resource creates exactly one occupancy row of kind block'
);

select ok(
  (select bool_and(o.booking_id is null) from public.resource_occupancies o
     where o.tenant_id = 'dddd0000-0000-0000-0000-000000000001'
       and o.kind = 'block'),
  'a block occupancy has booking_id IS NULL'
);

select is(
  (select max(o.block_reason) from public.resource_occupancies o
     where o.tenant_id = 'dddd0000-0000-0000-0000-000000000001'
       and o.kind = 'block'),
  'maintenance',
  'block_resource records the supplied (non-null) block_reason'
);

-- 4. A booking overlapping the block is rejected.
select throws_ok(
  $$
  select public.create_booking(
    'block-test', 'block-wash',
    (date_trunc('day', now() at time zone 'Europe/Moscow')
     + interval '2 days' + time '09:00') at time zone 'Europe/Moscow',
    'Blocked Customer', '+79990000004'
  )
  $$,
  'BK001',
  null,
  'a booking overlapping a block is rejected with BK001'
);

-- 5. available_slots offers nothing inside the blocked interval.
select ok(
  not exists (
    select 1
    from public.available_slots(
           'block-test', 'block-wash',
           (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '2 days')::date,
           (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '2 days')::date
         ) s
    where s.slot_start >= ((date_trunc('day', now() at time zone 'Europe/Moscow')
                            + interval '2 days' + time '09:00') at time zone 'Europe/Moscow')
      and s.slot_start <  ((date_trunc('day', now() at time zone 'Europe/Moscow')
                            + interval '2 days' + time '12:00') at time zone 'Europe/Moscow')
  ),
  'available_slots returns no slot inside the blocked interval'
);

-- 6-7. Releasing the block deletes it and frees the interval again.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-00000000000b"}';

select public.release_occupancy(
  p_tenant_id    => 'dddd0000-0000-0000-0000-000000000001',
  p_occupancy_id => (select o.id from public.resource_occupancies o
                     where o.tenant_id = 'dddd0000-0000-0000-0000-000000000001'
                       and o.kind = 'block')
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select count(*)::int from public.resource_occupancies o
     where o.tenant_id = 'dddd0000-0000-0000-0000-000000000001'
       and o.kind = 'block'),
  0,
  'release_occupancy deletes the block row'
);

select ok(
  (public.create_booking(
     'block-test', 'block-wash',
     (date_trunc('day', now() at time zone 'Europe/Moscow')
      + interval '2 days' + time '09:00') at time zone 'Europe/Moscow',
     'Freed Customer', '+79990000005'
   ) ->> 'bookingId') is not null,
  'the previously blocked interval becomes bookable after release'
);

-- 8. Releasing a booking occupancy is refused.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-00000000000b"}';

select throws_ok(
  $$
  select public.release_occupancy(
    'dddd0000-0000-0000-0000-000000000001',
    (select o.id from public.resource_occupancies o
      where o.tenant_id = 'dddd0000-0000-0000-0000-000000000001'
        and o.kind = 'booking')
  )
  $$,
  'BK007',
  null,
  'release_occupancy refuses a booking occupancy with BK007'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- 9. A non-member cannot block.
set local role authenticated;
set local request.jwt.claims = '{"sub":"20000000-0000-0000-0000-00000000000c"}';

select throws_ok(
  $$
  select public.block_resource(
    'dddd0000-0000-0000-0000-000000000001',
    'dddd0000-0000-0000-0000-0000000000a1',
    (date_trunc('day', now() at time zone 'Europe/Moscow')
     + interval '2 days' + time '13:00') at time zone 'Europe/Moscow',
    (date_trunc('day', now() at time zone 'Europe/Moscow')
     + interval '2 days' + time '14:00') at time zone 'Europe/Moscow',
    'intruder'
  )
  $$,
  '42501',
  null,
  'a non-member calling block_resource is refused with SQLSTATE 42501'
);

reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
