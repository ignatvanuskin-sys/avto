-- =============================================================================
-- 03_concurrency.test.sql
-- pgTAP suite: double booking is impossible through the SAME data structure the
-- booking path uses (public.resource_occupancies + its GiST EXCLUDE constraint
-- resource_occupancies_no_overlap on (tenant_id =, resource_id =, period &&)).
--
--   Part A (same session):    a raw overlapping insert on the already-occupied
--                             resource raises SQLSTATE 23P01 (exclusion_violation).
--   Part B (same session):    the same overlap on a DIFFERENT resource of the
--                             same tenant succeeds -> the exclusion is per
--                             resource, not global.
--   Part C (separate session):a genuinely separate backend (dblink) holds a
--                             committed occupancy; the overlapping insert issued
--                             from another dblink session fails with 23P01, and
--                             the first session's row is left untouched.
--   Part D (RPC path):        the public create_booking for an already-taken
--                             interval maps the collision to BK001.
--
-- Why Part C commits its fixtures: the whole pgTAP file runs inside one
-- transaction that ends with rollback, so a second backend can never see the
-- uncommitted local fixtures (it would see neither them nor their referenced
-- rows). Part C therefore builds its tenant/resource/first occupancy on the
-- dblink connection itself and commits them, exactly mirroring "another client
-- is already holding this slot". It cleans up with an explicit remote delete.
--
-- All fixture moments are relative to now() and built to overlap generously, so
-- the millisecond drift between the two backends cannot change the outcome.
-- =============================================================================

begin;

select plan(6);

-- ---------------------------------------------------------------------------
-- Fixtures (default role)
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name, status, timezone) values
  ('bbbb0000-0000-0000-0000-000000000001', 'conc-test', 'Concurrency Test',
   'live', 'Europe/Moscow');

insert into public.resources (id, tenant_id, key, name, kind, sort_order) values
  ('bbbb0000-0000-0000-0000-0000000000a1',
   'bbbb0000-0000-0000-0000-000000000001', 'conc-post-1', 'Conc Post 1', 'post', 0),
  ('bbbb0000-0000-0000-0000-0000000000a2',
   'bbbb0000-0000-0000-0000-000000000001', 'conc-post-2', 'Conc Post 2', 'post', 1);

insert into public.services
  (id, tenant_id, key, name, duration_min, price_cents, currency, required_resource_kind)
values
  ('bbbb0000-0000-0000-0000-0000000000c1',
   'bbbb0000-0000-0000-0000-000000000001', 'conc-wash', 'Conc Wash',
   60, 500000, 'RUB', 'post');

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values
  ('bbbb0000-0000-0000-0000-000000000001', 1, '09:00', '18:00'),
  ('bbbb0000-0000-0000-0000-000000000001', 2, '09:00', '18:00'),
  ('bbbb0000-0000-0000-0000-000000000001', 3, '09:00', '18:00'),
  ('bbbb0000-0000-0000-0000-000000000001', 4, '09:00', '18:00'),
  ('bbbb0000-0000-0000-0000-000000000001', 5, '09:00', '18:00'),
  ('bbbb0000-0000-0000-0000-000000000001', 6, '09:00', '18:00'),
  ('bbbb0000-0000-0000-0000-000000000001', 7, '09:00', '18:00');

-- A real booking, through the RPC, seats post-1 at a fixed aligned slot.
insert into public.customers (id, tenant_id, name, phone, phone_normalized) values
  ('bbbb0000-0000-0000-0000-0000000000d1',
   'bbbb0000-0000-0000-0000-000000000001', 'Conc Customer',
   '+79990000002', '79990000002');

select public.create_booking(
  p_tenant_slug          => 'conc-test',
  p_service_key          => 'conc-wash',
  p_starts_at            => (date_trunc('day', now() at time zone 'Europe/Moscow')
                             + interval '2 days' + time '09:00') at time zone 'Europe/Moscow',
  p_customer_name        => 'Conc Customer',
  p_customer_phone       => '+79990000002',
  p_booking_id           => 'bbbb0000-0000-0000-0000-0000000000e1',
  p_token_hash           => digest('conc-token', 'sha256'),
  p_preferred_resource_id=> 'bbbb0000-0000-0000-0000-0000000000a1'
);

-- ---------------------------------------------------------------------------
-- Part A: raw overlapping insert on the SAME resource -> 23P01
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
  insert into public.resource_occupancies (tenant_id, resource_id, kind, block_reason, period)
  values (
    'bbbb0000-0000-0000-0000-000000000001',
    'bbbb0000-0000-0000-0000-0000000000a1',
    'block', 'raw-overlap-same-resource',
    tstzrange(
      ((date_trunc('day', now() at time zone 'Europe/Moscow')
        + interval '2 days' + time '09:00') at time zone 'Europe/Moscow') + interval '30 minutes',
      ((date_trunc('day', now() at time zone 'Europe/Moscow')
        + interval '2 days' + time '09:00') at time zone 'Europe/Moscow') + interval '1 hour 30 minutes',
      '[)')
  )
  $$,
  '23P01',
  null,
  'Part A: a raw occupancy overlapping the booking on the same resource raises 23P01'
);

-- ---------------------------------------------------------------------------
-- Part B: the same overlap on a DIFFERENT resource of the same tenant succeeds
-- ---------------------------------------------------------------------------
select lives_ok(
  $$
  insert into public.resource_occupancies (tenant_id, resource_id, kind, block_reason, period)
  values (
    'bbbb0000-0000-0000-0000-000000000001',
    'bbbb0000-0000-0000-0000-0000000000a2',
    'block', 'raw-overlap-other-resource',
    tstzrange(
      ((date_trunc('day', now() at time zone 'Europe/Moscow')
        + interval '2 days' + time '09:00') at time zone 'Europe/Moscow') + interval '30 minutes',
      ((date_trunc('day', now() at time zone 'Europe/Moscow')
        + interval '2 days' + time '09:00') at time zone 'Europe/Moscow') + interval '1 hour 30 minutes',
      '[)')
  )
  $$,
  'Part B: the same overlap on a different resource is accepted (per-resource exclusion)'
);

-- ---------------------------------------------------------------------------
-- Part C: a genuinely separate backend session.
--   1. 'conc' holds a committed tenant/resource/occupancy.
--   2. 'conc2' attempts an overlapping insert and reports its SQLSTATE.
--   3. the first session's row must still be there.
-- ---------------------------------------------------------------------------
create extension if not exists dblink;

select dblink_connect('conc',  'dbname=' || current_database());
select dblink_connect('conc2', 'dbname=' || current_database());

-- The remote holder: committed on 'conc' (each dblink_exec autocommits).
-- Defensive pre-cleanup keeps Part C idempotent if a previous run aborted
-- between the committed remote fixtures and their explicit teardown below.
select dblink_exec('conc', $$
  delete from public.tenants where id = 'cccc0000-0000-0000-0000-000000000001'
$$);

select dblink_exec('conc', $$
  insert into public.tenants (id, slug, name, status, timezone)
  values ('cccc0000-0000-0000-0000-000000000001', 'conc-remote', 'Conc Remote',
          'live', 'UTC')
$$);

select dblink_exec('conc', $$
  insert into public.resources (id, tenant_id, key, name, kind, sort_order)
  values ('cccc0000-0000-0000-0000-0000000000a1',
          'cccc0000-0000-0000-0000-000000000001',
          'conc-remote-post', 'Conc Remote Post', 'post', 0)
$$);

select dblink_exec('conc', $$
  insert into public.resource_occupancies (tenant_id, resource_id, kind, block_reason, period)
  values ('cccc0000-0000-0000-0000-000000000001',
          'cccc0000-0000-0000-0000-0000000000a1',
          'block', 'remote-hold',
          tstzrange(now() + interval '10 days',
                    now() + interval '10 days 1 hour', '[)'))
$$);

-- A remote helper that captures the SQLSTATE instead of aborting the session.
select dblink_exec('conc2', $q$
  create or replace function pg_temp.conc_overlap() returns text
  language plpgsql as $f$
  begin
    insert into public.resource_occupancies
      (tenant_id, resource_id, kind, block_reason, period)
    values ('cccc0000-0000-0000-0000-000000000001',
            'cccc0000-0000-0000-0000-0000000000a1',
            'block', 'concurrent-intruder',
            tstzrange(now() + interval '10 days 30 minutes',
                      now() + interval '10 days 1 hour 30 minutes', '[)'));
    return 'inserted';
  exception when others then
    return sqlstate;
  end;
  $f$
$q$);

select ok(
  (select pid from dblink('conc',  'select pg_backend_pid()') as t(pid int))
  <>
  (select pid from dblink('conc2', 'select pg_backend_pid()') as t(pid int)),
  'Part C: dblink opens genuinely separate backend sessions'
);

select is(
  (select res from dblink('conc2', 'select pg_temp.conc_overlap()') as t(res text)),
  '23P01',
  'Part C: the overlapping insert issued from the separate session fails with 23P01'
);

select is(
  (select count(*)::int from public.resource_occupancies o
     where o.tenant_id = 'cccc0000-0000-0000-0000-000000000001'
       and o.kind = 'block'),
  1,
  'Part C: the first session''s occupancy row is untouched by the failed insert'
);

-- Cross-session fixtures are committed, so they must be removed explicitly.
select dblink_exec('conc', $$
  delete from public.tenants where id = 'cccc0000-0000-0000-0000-000000000001'
$$);
select dblink_disconnect('conc');
select dblink_disconnect('conc2');

-- ---------------------------------------------------------------------------
-- Part D: the RPC path maps the collision to BK001.
-- A second create_booking for the same, already-taken interval (pinned to the
-- taken resource) finds no free resource and raises BK001.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
  select public.create_booking(
    p_tenant_slug          => 'conc-test',
    p_service_key          => 'conc-wash',
    p_starts_at            => (date_trunc('day', now() at time zone 'Europe/Moscow')
                               + interval '2 days' + time '09:00') at time zone 'Europe/Moscow',
    p_customer_name        => 'Concurrency Rival',
    p_customer_phone       => '+79990000003',
    p_preferred_resource_id=> 'bbbb0000-0000-0000-0000-0000000000a1'
  )
  $$,
  'BK001',
  null,
  'Part D: create_booking for an already-taken interval is rejected with BK001'
);

select * from finish();
rollback;
