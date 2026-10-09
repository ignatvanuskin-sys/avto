-- =============================================================================
-- 0010_rpc_owner.sql
-- Owner-only operations. Every function re-checks membership on the server,
-- because a SECURITY DEFINER function bypasses RLS by design — the role check
-- inside the function body is what keeps an unlucky grant from becoming a
-- cross-tenant hole.
--
-- Statistics rules enforced here:
--  * the period is interpreted in the tenant timezone and echoed back, so the
--    interface and the AI assistant can never disagree about it;
--  * visits, completed orders and received payments are reported separately;
--  * the value of still-scheduled work is labelled `scheduledValueCents` and is
--    never called revenue.
-- =============================================================================

create or replace function app.require_member(
  p_tenant_id uuid,
  p_roles public.member_role[] default null
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.is_tenant_member(p_tenant_id, p_roles) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
end;
$$;

revoke all on function app.require_member(uuid, public.member_role[]) from public;

-- ---------------------------------------------------------------------------
-- Which studios does the signed-in user own or work in?
-- ---------------------------------------------------------------------------
create or replace function public.owner_tenant_context()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tenantId', m.tenant_id,
        'slug', t.slug,
        'name', t.name,
        'role', m.role,
        'status', t.status,
        'timezone', t.timezone,
        'currency', t.currency,
        'accentColor', t.accent_color
      )
      order by t.name
    ),
    '[]'::jsonb
  )
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid()
    and m.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- Statistics. All arithmetic is done in SQL, in one statement per metric.
-- ---------------------------------------------------------------------------
create or replace function public.owner_stats(
  p_tenant_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_visits bigint;
  v_completed bigint;
  v_no_show bigint;
  v_cancelled bigint;
  v_scheduled_value bigint;
  v_completed_value bigint;
  v_received bigint;
  v_refunded bigint;
  v_outstanding bigint;
  v_minutes_booked bigint;
  v_minutes_capacity bigint;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager', 'master']::public.member_role[]);

  select t.timezone into v_tz from public.tenants t where t.id = p_tenant_id;
  if v_tz is null then
    raise exception 'unknown tenant' using errcode = 'BK005';
  end if;

  v_from := (coalesce(p_from, (now() at time zone v_tz)::date)::timestamp) at time zone v_tz;
  v_to := ((coalesce(p_to, (now() at time zone v_tz)::date) + 1)::timestamp) at time zone v_tz;

  select
    count(*) filter (where b.status <> 'cancelled'),
    count(*) filter (where b.status = 'completed'),
    count(*) filter (where b.status = 'no_show'),
    count(*) filter (where b.status = 'cancelled'),
    coalesce(sum(b.price_cents) filter (where b.status in ('pending', 'confirmed', 'in_progress')), 0),
    coalesce(sum(b.price_cents) filter (where b.status = 'completed'), 0),
    coalesce(sum(b.duration_min) filter (where b.status <> 'cancelled'), 0)
  into v_visits, v_completed, v_no_show, v_cancelled, v_scheduled_value, v_completed_value, v_minutes_booked
  from public.bookings b
  where b.tenant_id = p_tenant_id
    and b.starts_at >= v_from
    and b.starts_at < v_to;

  select
    coalesce(sum(p.amount_cents) filter (where p.status = 'paid'), 0),
    coalesce(sum(p.amount_cents) filter (where p.status = 'refunded'), 0)
  into v_received, v_refunded
  from public.payments p
  where p.tenant_id = p_tenant_id
    and p.paid_at >= v_from
    and p.paid_at < v_to;

  -- quoted minus received: what is still owed on completed work
  select greatest(0, v_completed_value - v_received) into v_outstanding;

  -- Capacity is counted per calendar date *in the tenant timezone*, one
  -- working window at a time, multiplied by the number of active resources.
  select coalesce(sum(
      (extract(epoch from (upper(w) - lower(w))) / 60) * rc.n
    ), 0)::bigint
  into v_minutes_capacity
  from generate_series(
         (v_from at time zone v_tz)::date,
         ((v_to - interval '1 second') at time zone v_tz)::date,
         interval '1 day'
       ) as d
  cross join lateral app.working_windows(p_tenant_id, d::date) as w
  cross join lateral (
    select count(*) as n from public.resources r
    where r.tenant_id = p_tenant_id and r.is_active
  ) as rc;

  return jsonb_build_object(
    'period', jsonb_build_object(
      'from', (v_from at time zone v_tz)::date,
      'to', ((v_to - interval '1 day') at time zone v_tz)::date,
      'timezone', v_tz
    ),
    -- a car that came in, whatever the outcome
    'visits', v_visits,
    -- work actually finished
    'completedOrders', v_completed,
    'noShowOrders', v_no_show,
    'cancelledOrders', v_cancelled,
    -- money actually received in the period
    'receivedPaymentsCents', v_received,
    'refundedPaymentsCents', v_refunded,
    -- value of completed work that has not been paid yet
    'completedValueCents', v_completed_value,
    'outstandingCents', v_outstanding,
    -- NOT revenue: the quoted value of work that is still ahead of us
    'scheduledValueCents', v_scheduled_value,
    'scheduledNote', 'quoted value of work scheduled in this period, not received revenue',
    'capacity', jsonb_build_object(
      'bookedMinutes', v_minutes_booked,
      'availableMinutes', v_minutes_capacity,
      'utilization', case
        when v_minutes_capacity > 0
        then round((v_minutes_booked::numeric / v_minutes_capacity::numeric) * 100, 1)
        else 0
      end
    ),
    'currency', (select t.currency from public.tenants t where t.id = p_tenant_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Blocking a post (or an entire day) uses the very same occupancy table as a
-- booking, which is why a block and a booking can never overlap.
-- ---------------------------------------------------------------------------
create or replace function public.block_resource(
  p_tenant_id uuid,
  p_resource_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager', 'master']::public.member_role[]);

  if p_ends_at <= p_starts_at then
    raise exception 'BK001: block end must be after its start' using errcode = 'BK001';
  end if;

  insert into public.resource_occupancies (
    tenant_id, resource_id, kind, block_reason, period, created_by
  )
  values (
    p_tenant_id, p_resource_id, 'block',
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'blocked'),
    tstzrange(p_starts_at, p_ends_at, '[)'),
    auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object(
    'occupancyId', v_id,
    'resourceId', p_resource_id,
    'startsAt', p_starts_at,
    'endsAt', p_ends_at,
    'kind', 'block'
  );
exception
  when exclusion_violation then
    raise exception 'BK001: this resource is already busy over that interval'
      using errcode = 'BK001';
end;
$$;

create or replace function public.release_occupancy(
  p_tenant_id uuid,
  p_occupancy_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.resource_occupancies;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager', 'master']::public.member_role[]);

  select * into v_row
  from public.resource_occupancies o
  where o.tenant_id = p_tenant_id and o.id = p_occupancy_id;

  if not found then
    raise exception 'BK006: occupancy not found' using errcode = 'BK006';
  end if;

  if v_row.kind <> 'block' then
    raise exception 'BK007: a booking occupancy is released by cancelling the booking'
      using errcode = 'BK007';
  end if;

  delete from public.resource_occupancies where id = p_occupancy_id;

  return jsonb_build_object('occupancyId', p_occupancy_id, 'released', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Catalogue / tenant maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_service_price(
  p_tenant_id uuid,
  p_service_key text,
  p_price_cents bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service public.services;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager']::public.member_role[]);

  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'BK010: price must be a non-negative amount' using errcode = 'BK010';
  end if;

  update public.services
  set price_cents = p_price_cents
  where tenant_id = p_tenant_id and key = p_service_key
  returning * into v_service;

  if not found then
    raise exception 'BK004: unknown service' using errcode = 'BK004';
  end if;

  -- existing bookings keep price_cents as snapshotted: history is immutable
  return jsonb_build_object(
    'serviceKey', v_service.key,
    'priceCents', v_service.price_cents,
    'currency', v_service.currency
  );
end;
$$;

create or replace function public.set_service_active(
  p_tenant_id uuid,
  p_service_key text,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service public.services;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager']::public.member_role[]);

  update public.services
  set is_active = coalesce(p_is_active, true)
  where tenant_id = p_tenant_id and key = p_service_key
  returning * into v_service;

  if not found then
    raise exception 'BK004: unknown service' using errcode = 'BK004';
  end if;

  return jsonb_build_object('serviceKey', v_service.key, 'isActive', v_service.is_active);
end;
$$;

create or replace function public.set_business_hours(
  p_tenant_id uuid,
  p_weekday smallint,
  p_opens_at time,
  p_closes_at time,
  p_is_closed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager']::public.member_role[]);

  insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, is_closed)
  values (p_tenant_id, p_weekday, p_opens_at, p_closes_at, coalesce(p_is_closed, false))
  on conflict (tenant_id, weekday) do update
    set opens_at = excluded.opens_at,
        closes_at = excluded.closes_at,
        is_closed = excluded.is_closed;

  return jsonb_build_object(
    'weekday', p_weekday, 'opensAt', p_opens_at,
    'closesAt', p_closes_at, 'isClosed', coalesce(p_is_closed, false)
  );
end;
$$;

create or replace function public.set_schedule_exception(
  p_tenant_id uuid,
  p_on_date date,
  p_is_closed boolean,
  p_opens_at time default null,
  p_closes_at time default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager']::public.member_role[]);

  insert into public.schedule_exceptions (
    tenant_id, on_date, is_closed, opens_at, closes_at, note
  )
  values (p_tenant_id, p_on_date, p_is_closed, p_opens_at, p_closes_at, p_note)
  on conflict (tenant_id, on_date) do update
    set is_closed = excluded.is_closed,
        opens_at = excluded.opens_at,
        closes_at = excluded.closes_at,
        note = excluded.note;

  return jsonb_build_object(
    'onDate', p_on_date, 'isClosed', p_is_closed,
    'opensAt', p_opens_at, 'closesAt', p_closes_at, 'note', p_note
  );
end;
$$;

-- Activating a studio switches on real notifications. It is intentionally an
-- explicit owner action, and it refuses to run if the business basics are
-- missing.
create or replace function public.set_tenant_status(
  p_tenant_id uuid,
  p_status public.tenant_status
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant public.tenants;
  v_service_count integer;
  v_resource_count integer;
  v_hours_count integer;
begin
  perform app.require_member(p_tenant_id, array['owner']::public.member_role[]);

  select * into v_tenant from public.tenants t where t.id = p_tenant_id;
  if not found then
    raise exception 'BK005: unknown tenant' using errcode = 'BK005';
  end if;

  if p_status = 'live' then
    select count(*) into v_service_count
    from public.services s where s.tenant_id = p_tenant_id and s.is_active;
    select count(*) into v_resource_count
    from public.resources r where r.tenant_id = p_tenant_id and r.is_active;
    select count(*) into v_hours_count
    from public.business_hours h where h.tenant_id = p_tenant_id and not h.is_closed;

    if v_service_count = 0 or v_resource_count = 0 or v_hours_count = 0 then
      raise exception 'BK010: services, resources and working hours are required before going live'
        using errcode = 'BK010';
    end if;
  end if;

  update public.tenants set status = p_status where id = p_tenant_id;

  return jsonb_build_object('tenantId', p_tenant_id, 'status', p_status);
end;
$$;

-- Owner-recorded payments. This is the only place a payment row is created.
create or replace function public.record_payment(
  p_tenant_id uuid,
  p_booking_id uuid,
  p_amount_cents bigint,
  p_method public.payment_method,
  p_status public.payment_status default 'paid',
  p_note text default null,
  p_provider_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager']::public.member_role[]);

  if p_amount_cents is null or p_amount_cents = 0 then
    raise exception 'BK010: payment amount must be non-zero' using errcode = 'BK010';
  end if;

  insert into public.payments (
    tenant_id, booking_id, amount_cents, currency, method, status,
    paid_at, refunded_at, note, provider_ref, recorded_by
  )
  select
    p_tenant_id, b.id, p_amount_cents, b.currency, p_method, p_status,
    case when p_status in ('paid', 'refunded') then now() else null end,
    case when p_status = 'refunded' then now() else null end,
    p_note, p_provider_ref, auth.uid()
  from public.bookings b
  where b.tenant_id = p_tenant_id and b.id = p_booking_id
  returning * into v_payment;

  if not found then
    raise exception 'BK006: booking not found' using errcode = 'BK006';
  end if;

  return jsonb_build_object(
    'paymentId', v_payment.id,
    'bookingId', v_payment.booking_id,
    'amountCents', v_payment.amount_cents,
    'currency', v_payment.currency,
    'method', v_payment.method,
    'status', v_payment.status,
    'paidAt', v_payment.paid_at
  );
end;
$$;

create or replace function public.set_booking_status(
  p_tenant_id uuid,
  p_booking_id uuid,
  p_status public.booking_status
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager', 'master']::public.member_role[]);

  select * into v_booking
  from public.bookings b
  where b.tenant_id = p_tenant_id and b.id = p_booking_id
  for update;

  if not found then
    raise exception 'BK006: booking not found' using errcode = 'BK006';
  end if;

  if p_status = 'cancelled' then
    delete from public.resource_occupancies o
    where o.tenant_id = p_tenant_id and o.booking_id = p_booking_id;
    perform app.retire_booking_jobs(p_tenant_id, p_booking_id, 'cancelled by owner');
  elsif p_status in ('completed', 'no_show') then
    -- the resource stays occupied until the moment has passed; releasing now
    -- would make the day look free while the car is still standing there
    null;
  end if;

  update public.bookings
  set status = p_status,
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end
  where id = p_booking_id;

  insert into public.booking_events (tenant_id, booking_id, event, actor, payload)
  values (p_tenant_id, p_booking_id, 'status_' || p_status::text, 'owner',
          jsonb_build_object('from', v_booking.status, 'to', p_status));

  return jsonb_build_object('bookingId', p_booking_id, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Asset registration. `origin = 'owner'` rows are never touched by
-- `tenant:publish`, which is how uploaded photos survive a re-publish.
-- ---------------------------------------------------------------------------
create or replace function public.upsert_tenant_asset(
  p_tenant_id uuid,
  p_kind text,
  p_url text,
  p_origin text default 'owner',
  p_alt text default null,
  p_sort_order integer default 0,
  p_storage_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_asset public.tenant_assets;
begin
  perform app.require_member(p_tenant_id, array['owner', 'manager']::public.member_role[]);

  insert into public.tenant_assets (
    tenant_id, kind, url, origin, alt, sort_order, storage_path
  )
  values (p_tenant_id, p_kind, p_url, p_origin, p_alt, p_sort_order, p_storage_path)
  returning * into v_asset;

  return jsonb_build_object(
    'assetId', v_asset.id, 'kind', v_asset.kind,
    'url', v_asset.url, 'origin', v_asset.origin
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Cron entry point: turn "a booking starts in 24h/2h" into outbox rows.
-- Deduplicated per booking and per start moment, so a reschedule naturally
-- produces a new reminder instead of a duplicate of the old one.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_due_reminders(p_window_minutes integer default 5)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window integer;
  v_inserted integer;
begin
  v_window := greatest(1, least(coalesce(p_window_minutes, 5), 120));

  with due as (
    select
      b.tenant_id,
      b.id as booking_id,
      r.kind,
      r.lead,
      b.starts_at
    from public.bookings b
    join public.tenants t on t.id = b.tenant_id
    cross join (values
      ('reminder_24h'::public.job_kind, interval '24 hours'),
      ('reminder_2h'::public.job_kind, interval '2 hours')
    ) as r(kind, lead)
    where t.status = 'live'
      and b.status in ('pending', 'confirmed')
      and b.starts_at - r.lead <= now() + make_interval(mins => v_window)
      and b.starts_at - r.lead > now() - make_interval(mins => v_window)
  )
  insert into public.notification_jobs (
    tenant_id, booking_id, kind, channel, payload, dedup_key, run_after
  )
  select
    d.tenant_id,
    d.booking_id,
    d.kind,
    'push',
    jsonb_build_object(
      'audience', 'customer',
      'bookingId', d.booking_id,
      'startsAt', d.starts_at
    ),
    'reminder:' || d.kind::text || ':' || d.booking_id::text || ':'
      || extract(epoch from d.starts_at)::bigint::text,
    now()
  from due d
  on conflict (dedup_key) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
