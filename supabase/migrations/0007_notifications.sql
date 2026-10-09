-- =============================================================================
-- 0007_notifications.sql
-- Push subscriptions and the transactional outbox.
--
-- Why an outbox: notifications must be enqueued in the very transaction that
-- changes the booking, but delivered by a separate worker. That gives us
-- at-least-once delivery with deduplication, safe retries with a lease, and a
-- truthful state we can show in the owner interface.
-- =============================================================================

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  -- who is being notified: the customer about their booking, or the studio
  -- owners about any booking of the tenant
  audience text not null,
  booking_id uuid,
  owner_user_id uuid references auth.users (id) on delete cascade,
  user_agent text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint push_subscriptions_audience check (audience in ('customer', 'owner')),
  -- a browser endpoint is unique per push service, not per tenant
  constraint push_subscriptions_endpoint_unique unique (endpoint),
  constraint push_subscriptions_target check (
    (audience = 'customer' and booking_id is not null and owner_user_id is null)
    or (audience = 'owner' and owner_user_id is not null and booking_id is null)
  ),
  constraint push_subscriptions_booking_fk
    foreign key (tenant_id, booking_id)
    references public.bookings (tenant_id, id) on delete cascade
);

create index push_subscriptions_owner_idx
  on public.push_subscriptions (tenant_id, owner_user_id) where is_active;

create trigger push_subscriptions_touch
  before update on public.push_subscriptions
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------
create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid,
  kind public.job_kind not null,
  channel public.job_channel not null,
  payload jsonb not null default '{}'::jsonb,
  status public.job_status not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  leased_by text,
  last_error text,
  sent_at timestamptz,
  -- idempotent enqueue: the same logical notification can only exist once
  dedup_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_jobs_dedup_unique unique (dedup_key),
  constraint notification_jobs_attempts check (attempts >= 0 and max_attempts >= 1),
  constraint notification_jobs_booking_fk
    foreign key (tenant_id, booking_id)
    references public.bookings (tenant_id, id) on delete cascade
);

create index notification_jobs_ready_idx
  on public.notification_jobs (run_after)
  where status in ('pending', 'failed');

create index notification_jobs_lease_idx
  on public.notification_jobs (lease_until)
  where status = 'processing';

create index notification_jobs_booking_idx
  on public.notification_jobs (tenant_id, booking_id, kind);

create trigger notification_jobs_touch
  before update on public.notification_jobs
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Enqueue helper. Deduplicated, so a retried request cannot produce a second
-- notification for the same logical event.
-- ---------------------------------------------------------------------------
create or replace function app.enqueue_notification(
  p_tenant_id uuid,
  p_booking_id uuid,
  p_kind public.job_kind,
  p_channel public.job_channel,
  p_dedup_key text,
  p_payload jsonb default '{}'::jsonb,
  p_run_after timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.notification_jobs (
    tenant_id, booking_id, kind, channel, payload, dedup_key, run_after
  )
  values (
    p_tenant_id, p_booking_id, p_kind, p_channel, coalesce(p_payload, '{}'::jsonb),
    p_dedup_key, coalesce(p_run_after, now())
  )
  on conflict (dedup_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function app.enqueue_notification(uuid, uuid, public.job_kind, public.job_channel, text, jsonb, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- Worker: claim a batch with a lease. FOR UPDATE SKIP LOCKED makes it safe to
-- run several workers at once; the lease makes a crashed worker recoverable.
-- ---------------------------------------------------------------------------
create or replace function public.claim_notification_jobs(
  p_limit integer default 20,
  p_lease_seconds integer default 60,
  p_worker text default 'worker'
)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidates as (
    select j.id
    from public.notification_jobs j
    where (
        j.status in ('pending', 'failed')
        and j.run_after <= now()
      )
      or (
        j.status = 'processing'
        and j.lease_until is not null
        and j.lease_until < now()
      )
    order by j.run_after
    limit greatest(1, least(coalesce(p_limit, 20), 200))
    for update skip locked
  )
  update public.notification_jobs j
  set status = 'processing',
      attempts = j.attempts + 1,
      leased_by = p_worker,
      lease_until = now() + make_interval(secs => greatest(5, coalesce(p_lease_seconds, 60)))
  from candidates c
  where j.id = c.id
  returning j.*;
end;
$$;

create or replace function public.complete_notification_job(
  p_job_id uuid,
  p_success boolean,
  p_error text default null,
  p_retry_delay_seconds integer default 60
)
returns public.job_status
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.notification_jobs;
  v_status public.job_status;
begin
  select * into v_job from public.notification_jobs where id = p_job_id for update;
  if not found then
    return null;
  end if;

  if p_success then
    v_status := 'sent';
    update public.notification_jobs
    set status = v_status, sent_at = now(), lease_until = null, leased_by = null, last_error = null
    where id = p_job_id;
  elsif v_job.attempts >= v_job.max_attempts then
    v_status := 'dead';
    update public.notification_jobs
    set status = v_status, lease_until = null, leased_by = null, last_error = p_error
    where id = p_job_id;
  else
    v_status := 'failed';
    update public.notification_jobs
    set status = v_status,
        lease_until = null,
        leased_by = null,
        last_error = p_error,
        run_after = now() + make_interval(secs => greatest(5, coalesce(p_retry_delay_seconds, 60)))
    where id = p_job_id;
  end if;

  return v_status;
end;
$$;

-- A booking that moved or was cancelled must not keep reminding the customer
-- about the old time. Pending reminder jobs are retired, not silently dropped.
create or replace function app.retire_booking_jobs(
  p_tenant_id uuid,
  p_booking_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.notification_jobs
  set status = 'dead',
      last_error = p_reason,
      lease_until = null,
      leased_by = null
  where tenant_id = p_tenant_id
    and booking_id = p_booking_id
    and status in ('pending', 'failed', 'processing');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function app.retire_booking_jobs(uuid, uuid, text) from public;
