-- =============================================================================
-- 08_outbox.test.sql
-- pgTAP suite: the transactional notification outbox.
--
-- What is proven here:
--   * a live tenant booking enqueues notification_jobs rows with a non-empty
--     dedup_key, while a preview tenant enqueues ZERO (preview never notifies);
--   * claim_notification_jobs leases a job (status = 'processing', non-null
--     lease_until, attempts = 1) and a second claim inside the same transaction
--     does not hand out the same job again;
--   * complete_notification_job(id, true) marks a job 'sent' with sent_at set;
--   * a retryable failure (attempts < max_attempts) becomes 'failed' with a
--     future run_after, while a failure at max_attempts becomes 'dead';
--   * enqueue_due_reminders is deduplicated across two calls for the same
--     booking and start moment;
--   * retiring a booking's jobs (app.retire_booking_jobs, the helper the cancel
--     RPC invokes) leaves no pending job for that booking.
--
-- Fixtures run as the default table-owning role; the outbox worker RPCs are
-- SECURITY DEFINER and are driven directly. All moments are relative to now().
-- =============================================================================

begin;

select plan(17);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name, status, timezone) values
  ('11111111-1111-1111-1111-111111111111', 'alpha-test', 'Alpha Test', 'live', 'Europe/Moscow'),
  ('22222222-2222-2222-2222-222222222222', 'beta-test', 'Beta Test', 'preview', 'Asia/Almaty');

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

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at)
select t.id, w, time '00:00', time '23:59'
from (values ('11111111-1111-1111-1111-111111111111'::uuid),
             ('22222222-2222-2222-2222-222222222222'::uuid)) as t(id)
cross join generate_series(1, 7) as w;

-- Bookings via the public RPC so the real enqueue path is exercised.
create temporary table created08 (label text primary key, body jsonb);

insert into created08 (label, body) values ('live',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '10:00') at time zone 'Europe/Moscow'),
    'Live User', '+79002220001'));

insert into created08 (label, body) values ('preview',
  public.create_booking(
    'beta-test', 'beta-wash',
    ((((now() at time zone 'Asia/Almaty')::date + 2) + time '10:00') at time zone 'Asia/Almaty'),
    'Preview User', '+79002220002'));

-- ---------------------------------------------------------------------------
-- 1-3: enqueue rules for live vs preview tenants.
-- ---------------------------------------------------------------------------
select ok(
  (select count(*) from public.notification_jobs
    where booking_id = (select (body ->> 'bookingId')::uuid from created08 where label = 'live')) >= 1,
  'a live tenant booking enqueues at least one notification job');

select is(
  (select count(*)::int from public.notification_jobs
    where booking_id = (select (body ->> 'bookingId')::uuid from created08 where label = 'live')
      and coalesce(dedup_key, '') = ''),
  0,
  'every live outbox row carries a non-empty dedup_key');

select is(
  (select count(*)::int from public.notification_jobs
    where booking_id = (select (body ->> 'bookingId')::uuid from created08 where label = 'preview')),
  0,
  'a preview tenant booking enqueues zero notification jobs');

-- ---------------------------------------------------------------------------
-- 4-8: claim a batch with a lease; a second claim does not repeat a job.
-- ---------------------------------------------------------------------------
create temporary table claimed08 as
  select * from public.claim_notification_jobs(50, 60, 'pgtap-worker');

select ok(
  (select count(*) from claimed08) >= 1,
  'claim_notification_jobs returns at least one job');

select is(
  (select status::text from claimed08 order by id limit 1),
  'processing',
  'a claimed job is marked processing');

select ok(
  (select lease_until is not null from claimed08 order by id limit 1),
  'a claimed job receives a non-null lease_until');

select is(
  (select attempts from claimed08 order by id limit 1),
  1,
  'a claimed job records exactly one attempt');

create temporary table claimed08b as
  select * from public.claim_notification_jobs(50, 60, 'pgtap-worker-2');

select ok(
  not exists (select 1 from claimed08 a join claimed08b b on a.id = b.id),
  'a second claim in the same transaction does not return the same job again');

-- ---------------------------------------------------------------------------
-- 9-10: a successful completion.
-- ---------------------------------------------------------------------------
select is(
  public.complete_notification_job(
    (select id from claimed08 order by id limit 1), true)::text,
  'sent',
  'complete_notification_job(true) marks the job sent');

select ok(
  (select sent_at is not null from public.notification_jobs
    where id = (select id from claimed08 order by id limit 1)),
  'a sent job records sent_at');

-- ---------------------------------------------------------------------------
-- 11-13: retryable failure vs a failure at max_attempts.
-- ---------------------------------------------------------------------------
insert into public.notification_jobs
  (tenant_id, kind, channel, status, attempts, max_attempts, dedup_key)
values
  ('11111111-1111-1111-1111-111111111111', 'reminder_24h', 'push', 'processing', 1, 5, 'outbox-fail-1'),
  ('11111111-1111-1111-1111-111111111111', 'reminder_24h', 'push', 'processing', 5, 5, 'outbox-dead-1');

select is(
  public.complete_notification_job(
    (select id from public.notification_jobs where dedup_key = 'outbox-fail-1'),
    false, 'boom', 30)::text,
  'failed',
  'a failure below max_attempts is marked failed');

select ok(
  (select run_after > now() from public.notification_jobs where dedup_key = 'outbox-fail-1'),
  'a retryable failure schedules a future run_after');

select is(
  public.complete_notification_job(
    (select id from public.notification_jobs where dedup_key = 'outbox-dead-1'),
    false, 'boom', 30)::text,
  'dead',
  'a failure at max_attempts is marked dead');

-- ---------------------------------------------------------------------------
-- 14-15: due-reminder enqueue is deduplicated across two calls.
-- ---------------------------------------------------------------------------
insert into public.customers (id, tenant_id, name, phone, phone_normalized) values
  ('10000000-0000-0000-0000-0000000000d9',
   '11111111-1111-1111-1111-111111111111', 'Soon Customer', '+79002220009', '79002220009');

insert into public.bookings (
  id, tenant_id, customer_id, service_id, resource_id, display_number,
  price_cents, currency, duration_min, buffer_before_min, buffer_after_min,
  service_name_snapshot, starts_at, ends_at, status, access_token_hash, idempotency_hash
) values (
  '10000000-0000-0000-0000-0000000000e9',
  '11111111-1111-1111-1111-111111111111',
  '10000000-0000-0000-0000-0000000000d9',
  '10000000-0000-0000-0000-0000000000c1',
  '10000000-0000-0000-0000-0000000000a1',
  99, 500000, 'RUB', 60, 0, 0, 'Alpha Wash',
  now() + interval '24 hours', now() + interval '25 hours', 'confirmed',
  digest('soon-token', 'sha256'), digest('soon-idem', 'sha256'));

create temporary table rem08 (n int primary key, inserted int);

insert into rem08 (n, inserted) values (1, public.enqueue_due_reminders(5));
insert into rem08 (n, inserted) values (2, public.enqueue_due_reminders(5));

select is(
  (select inserted from rem08 where n = 1),
  1,
  'enqueue_due_reminders enqueues the one due reminder');

select is(
  (select inserted from rem08 where n = 2),
  0,
  'enqueue_due_reminders is deduplicated on the second call');

-- ---------------------------------------------------------------------------
-- 16-17: retiring a booking's jobs leaves nothing pending.
-- ---------------------------------------------------------------------------
create temporary table cancel08 (label text primary key, body jsonb);

insert into cancel08 (label, body) values ('d2',
  public.create_booking(
    'alpha-test', 'alpha-wash',
    ((((now() at time zone 'Europe/Moscow')::date + 2) + time '16:00') at time zone 'Europe/Moscow'),
    'Cancelling User', '+79002220010', null, null, null,
    digest('outbox-cancel-token', 'sha256'), null, null));

select ok(
  (select count(*) from public.notification_jobs
    where booking_id = (select (body ->> 'bookingId')::uuid from cancel08 where label = 'd2')
      and status = 'pending') >= 1,
  'a fresh live booking has at least one pending outbox job');

select app.retire_booking_jobs(
  '11111111-1111-1111-1111-111111111111',
  (select (body ->> 'bookingId')::uuid from cancel08 where label = 'd2'),
  'booking cancelled');

select is(
  (select count(*)::int from public.notification_jobs
    where booking_id = (select (body ->> 'bookingId')::uuid from cancel08 where label = 'd2')
      and status = 'pending'),
  0,
  'retiring a booking leaves no pending job for it');

select * from finish();
rollback;
