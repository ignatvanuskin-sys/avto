-- =============================================================================
-- 0006_occupancy.sql
-- The single source of truth for "is this resource busy".
--
-- A booking and a manual block are the same kind of object: a row in
-- `resource_occupancies` with a tstzrange. Overlap is impossible because of a
-- PostgreSQL EXCLUDE constraint, so two concurrent requests can never both
-- win the same resource — the second one gets a constraint violation instead
-- of a silent double booking.
-- =============================================================================

create table public.resource_occupancies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  resource_id uuid not null,
  booking_id uuid,
  kind public.occupancy_kind not null,
  block_reason text,
  created_by uuid references auth.users (id) on delete set null,
  period tstzrange not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint resource_occupancies_resource_fk
    foreign key (tenant_id, resource_id)
    references public.resources (tenant_id, id) on delete cascade,
  constraint resource_occupancies_booking_fk
    foreign key (tenant_id, booking_id)
    references public.bookings (tenant_id, id) on delete cascade,

  -- Half-open intervals, never empty: [start, end)
  constraint resource_occupancies_bounds check (
    not isempty(period) and lower_inc(period) and not upper_inc(period)
  ),
  constraint resource_occupancies_kind_fields check (
    (kind = 'booking' and booking_id is not null and block_reason is null)
    or (kind = 'block' and booking_id is null and block_reason is not null)
  ),
  -- one occupancy row per booking, which makes reschedule "replace the row"
  constraint resource_occupancies_one_per_booking unique (booking_id),

  -- The actual exclusion guarantee.
  constraint resource_occupancies_no_overlap exclude using gist (
    tenant_id with =,
    resource_id with =,
    period with &&
  ),
  constraint resource_occupancies_tenant_id_key unique (tenant_id, id)
);

create index resource_occupancies_period_idx
  on public.resource_occupancies using gist (resource_id, period);
create index resource_occupancies_tenant_booking_idx
  on public.resource_occupancies (tenant_id, booking_id);

create trigger resource_occupancies_touch
  before update on public.resource_occupancies
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Working windows for one calendar date, resolved in the tenant timezone.
-- Exceptions always win over the weekly schedule.
-- ---------------------------------------------------------------------------
create or replace function app.working_windows(p_tenant_id uuid, p_date date)
returns setof tstzrange
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_weekday smallint;
  v_exception public.schedule_exceptions;
  v_hours public.business_hours;
begin
  select t.timezone into v_tz from public.tenants t where t.id = p_tenant_id;
  if v_tz is null then
    return;
  end if;

  select * into v_exception
  from public.schedule_exceptions e
  where e.tenant_id = p_tenant_id and e.on_date = p_date;

  if found then
    if v_exception.is_closed then
      return;
    end if;
    return query
      select tstzrange(
        (p_date + v_exception.opens_at) at time zone v_tz,
        (p_date + v_exception.closes_at) at time zone v_tz,
        '[)'
      );
    return;
  end if;

  v_weekday := extract(isodow from p_date)::smallint;

  select * into v_hours
  from public.business_hours h
  where h.tenant_id = p_tenant_id and h.weekday = v_weekday;

  if not found or v_hours.is_closed then
    return;
  end if;

  return query
    select tstzrange(
      (p_date + v_hours.opens_at) at time zone v_tz,
      (p_date + v_hours.closes_at) at time zone v_tz,
      '[)'
    );
end;
$$;

revoke all on function app.working_windows(uuid, date) from public;

-- ---------------------------------------------------------------------------
-- Which concrete resources may serve a given service, in preference order.
-- An explicit allow-list, when present, wins over kind matching.
-- ---------------------------------------------------------------------------
create or replace function app.eligible_resources(
  p_tenant_id uuid,
  p_kind text,
  p_service_id uuid
)
returns table (resource_id uuid, sort_order integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with allowed as (
    select sr.resource_id
    from public.service_resources sr
    where sr.tenant_id = p_tenant_id and sr.service_id = p_service_id
  )
  select r.id, r.sort_order
  from public.resources r
  where r.tenant_id = p_tenant_id
    and r.is_active
    and r.kind = p_kind
    and (
      not exists (select 1 from allowed)
      or r.id in (select a.resource_id from allowed a)
    )
  order by r.sort_order, r.key;
$$;

revoke all on function app.eligible_resources(uuid, text, uuid) from public;

-- ---------------------------------------------------------------------------
-- Public availability. Returns only free start moments, never personal data.
-- The requested window is hard-capped so a single call cannot scan a year.
-- ---------------------------------------------------------------------------
create or replace function public.available_slots(
  p_tenant_slug citext,
  p_service_key text,
  p_from date default null,
  p_to date default null
)
returns table (
  slot_start timestamptz,
  slot_resource_id uuid,
  slot_resource_name text
)
-- VOLATILE on purpose: this function consumes the tenant's shared request
-- budget, and a STABLE function may not write.
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_days constant integer := 31;
  v_tenant_id uuid;
  v_tz text;
  v_lead integer;
  v_horizon integer;
  v_step integer;
  v_tenant_limit integer;
  v_service public.services;
  v_from date;
  v_to date;
  v_limit timestamptz;
  v_date date;
  v_window tstzrange;
  v_cursor timestamptz;
  v_occ tstzrange;
  v_candidate record;
begin
  select t.id, t.timezone, t.booking_lead_minutes, t.booking_horizon_days,
         t.slot_step_minutes, t.public_rate_limit_per_minute
    into v_tenant_id, v_tz, v_lead, v_horizon, v_step, v_tenant_limit
  from public.tenants t
  where t.slug = p_tenant_slug
    and t.status <> 'suspended';

  if v_tenant_id is null then
    return;
  end if;

  -- Slot search is read-mostly but called several times per booking, hence the
  -- more generous multiplier over the tenant's write budget.
  perform app.enforce_rate_limit(
    'slots:' || v_tenant_id::text,
    (v_tenant_limit * 4)::bigint,
    60
  );

  select * into v_service
  from public.services s
  where s.tenant_id = v_tenant_id
    and s.key = p_service_key
    and s.is_active;

  if not found then
    return;
  end if;

  v_from := coalesce(p_from, (now() at time zone v_tz)::date);
  v_to := coalesce(p_to, v_from);
  if v_to < v_from then
    v_to := v_from;
  end if;
  if (v_to - v_from) > c_max_days then
    v_to := v_from + c_max_days;
  end if;

  v_limit := now() + make_interval(days => v_horizon);

  for v_date in
    select g::date from generate_series(v_from, v_to, interval '1 day') as g
  loop
    for v_window in select * from app.working_windows(v_tenant_id, v_date) loop
      v_cursor := v_window.lower;
      while v_cursor < v_window.upper loop
        v_occ := tstzrange(
          v_cursor - make_interval(mins => v_service.buffer_before_min),
          v_cursor + make_interval(mins => v_service.duration_min)
                  + make_interval(mins => v_service.buffer_after_min),
          '[)'
        );

        if v_cursor >= now() + make_interval(mins => v_lead)
           and v_cursor <= v_limit
           and (
             -- multi-day service: the start is an acceptance moment inside an
             -- open window, the occupancy then continues without gaps
             (v_service.spans_days and v_cursor < v_window.upper)
             -- same-day service: the whole occupancy must fit in this window
             or (not v_service.spans_days and v_occ <@ v_window)
           )
        then
          for v_candidate in
            select * from app.eligible_resources(
              v_tenant_id, v_service.required_resource_kind, v_service.id
            )
          loop
            if not exists (
              select 1
              from public.resource_occupancies o
              where o.tenant_id = v_tenant_id
                and o.resource_id = v_candidate.resource_id
                and o.period && v_occ
            ) then
              slot_start := v_cursor;
              slot_resource_id := v_candidate.resource_id;
              slot_resource_name := (
                select r.name from public.resources r where r.id = v_candidate.resource_id
              );
              return next;
              exit;
            end if;
          end loop;
        end if;

        v_cursor := v_cursor + make_interval(mins => v_step);
      end loop;
    end loop;
  end loop;
end;
$$;

comment on function public.available_slots(citext, text, date, date) is
  'Public slot search. Picks the first free eligible resource for each start.';
