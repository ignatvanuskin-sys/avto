-- =============================================================================
-- 0009_rpc_booking.sql
-- The public booking API. Everything the customer-facing app can do is here.
--
-- Why this is the only write path for anonymous callers:
--  * the client cannot choose tenant_id, price, duration or buffers — all of
--    them are resolved server-side from the slug and the service key;
--  * the requested start moment is re-validated against working hours,
--    exceptions, lead time, horizon and the slot grid;
--  * create/reschedule/cancel are single transactions, so a failure leaves the
--    previous state untouched;
--  * every mutation is idempotent through the idempotency ledger.
--
-- Error codes (stable, mapped 1:1 by the Edge Function):
--   BK001 slot outside working hours / does not fit
--   BK002 slot too soon (lead time)
--   BK003 slot beyond the booking horizon
--   BK004 service not found
--   BK005 tenant not found or suspended
--   BK006 booking not found
--   BK007 booking is not in a mutable state
--   BK008 idempotency key reused with a different payload
--   BK009 resource not eligible for this service
--   BK010 invalid customer data
--   BK011 public request budget for this tenant is exhausted
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Public branding + catalogue projection. Returns no personal data.
-- ---------------------------------------------------------------------------
create or replace function public.public_tenant_profile(p_slug citext)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', t.id,
    'slug', t.slug,
    'name', t.name,
    'tagline', t.tagline,
    'description', t.description,
    'status', t.status,
    'timezone', t.timezone,
    'locale', t.locale,
    'currency', t.currency,
    'accentColor', t.accent_color,
    'accentForeground', t.accent_foreground,
    'contactPhone', t.contact_phone,
    'contactEmail', t.contact_email,
    'contactWhatsapp', t.contact_whatsapp,
    'contactTelegram', t.contact_telegram,
    'address', t.address,
    'mapUrl', t.map_url,
    'booking', jsonb_build_object(
      'leadMinutes', t.booking_lead_minutes,
      'horizonDays', t.booking_horizon_days,
      'slotStepMinutes', t.slot_step_minutes,
      'minCancelNoticeMinutes', t.min_cancel_notice_minutes
    ),
    'ai', jsonb_build_object('enabled', t.ai_enabled),
    'assets', coalesce((
      select jsonb_agg(
        jsonb_build_object('kind', a.kind, 'url', a.url, 'alt', a.alt)
        order by a.sort_order, a.created_at
      )
      from public.tenant_assets a
      where a.tenant_id = t.id and a.url is not null
    ), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', s.key,
          'name', s.name,
          'description', s.description,
          'durationMin', s.duration_min,
          'bufferBeforeMin', s.buffer_before_min,
          'bufferAfterMin', s.buffer_after_min,
          'priceCents', s.price_cents,
          'currency', s.currency,
          'category', s.category,
          'imageUrl', s.image_url,
          'spansDays', s.spans_days,
          'resourceKind', s.required_resource_kind
        )
        order by s.sort_order, s.name
      )
      from public.services s
      where s.tenant_id = t.id and s.is_active
    ), '[]'::jsonb),
    'resources', coalesce((
      select jsonb_agg(
        jsonb_build_object('key', r.key, 'name', r.name, 'kind', r.kind)
        order by r.sort_order, r.key
      )
      from public.resources r
      where r.tenant_id = t.id and r.is_active
    ), '[]'::jsonb),
    'hours', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'weekday', h.weekday,
          'opensAt', to_char(h.opens_at, 'HH24:MI'),
          'closesAt', to_char(h.closes_at, 'HH24:MI'),
          'isClosed', h.is_closed
        )
        order by h.weekday
      )
      from public.business_hours h
      where h.tenant_id = t.id
    ), '[]'::jsonb)
  )
  from public.tenants t
  where t.slug = p_slug and t.status <> 'suspended';
$$;

comment on function public.public_tenant_profile(citext) is
  'Anonymous-safe tenant projection: branding, services, hours. No PII.';

-- ---------------------------------------------------------------------------
-- Shared validation of a requested start moment.
-- Raises BK002/BK003/BK001 and returns the full occupancy interval.
-- ---------------------------------------------------------------------------
create or replace function app.validate_booking_start(
  p_tenant public.tenants,
  p_service public.services,
  p_starts_at timestamptz
)
returns tstzrange
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_occupancy tstzrange;
  v_aligned boolean;
  v_fits boolean;
begin
  if p_starts_at is null then
    raise exception 'BK001: start moment is required' using errcode = 'BK001';
  end if;

  if p_starts_at < now() + make_interval(mins => p_tenant.booking_lead_minutes) then
    raise exception 'BK002: start moment is too soon' using errcode = 'BK002';
  end if;

  if p_starts_at > now() + make_interval(days => p_tenant.booking_horizon_days) then
    raise exception 'BK003: start moment is beyond the booking horizon' using errcode = 'BK003';
  end if;

  v_occupancy := tstzrange(
    p_starts_at - make_interval(mins => p_service.buffer_before_min),
    p_starts_at + make_interval(mins => p_service.duration_min)
                + make_interval(mins => p_service.buffer_after_min),
    '[)'
  );

  -- The start must be an admission moment: inside an open window and aligned to
  -- the configured slot grid. This is what makes working hours authoritative
  -- and stops a client from posting an arbitrary timestamp.
  select exists (
    select 1
    from app.working_windows(
      p_tenant.id,
      (p_starts_at at time zone p_tenant.timezone)::date
    ) as w
    where p_starts_at >= lower(w)
      and p_starts_at < upper(w)
      and mod(
            extract(epoch from (p_starts_at - lower(w)))::bigint,
            (p_tenant.slot_step_minutes * 60)::bigint
          ) = 0
  ) into v_aligned;

  if not v_aligned then
    raise exception 'BK001: start moment is not an admission moment on this date'
      using errcode = 'BK001';
  end if;

  if not p_service.spans_days then
    select exists (
      select 1
      from app.working_windows(
        p_tenant.id,
        (p_starts_at at time zone p_tenant.timezone)::date
      ) as w
      where v_occupancy <@ w
    ) into v_fits;

    if not v_fits then
      raise exception 'BK001: the service and its buffers do not fit in the working window'
        using errcode = 'BK001';
    end if;
  end if;

  return v_occupancy;
end;
$$;

revoke all on function app.validate_booking_start(public.tenants, public.services, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- Find a free eligible resource for the occupancy.
-- ---------------------------------------------------------------------------
create or replace function app.pick_resource(
  p_tenant_id uuid,
  p_service public.services,
  p_occupancy tstzrange,
  p_preferred_resource_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_resource_id uuid;
begin
  if p_preferred_resource_id is not null then
    if not exists (
      select 1
      from app.eligible_resources(p_tenant_id, p_service.required_resource_kind, p_service.id) e
      where e.resource_id = p_preferred_resource_id
    ) then
      raise exception 'BK009: resource is not eligible for this service' using errcode = 'BK009';
    end if;
  end if;

  select e.resource_id into v_resource_id
  from app.eligible_resources(p_tenant_id, p_service.required_resource_kind, p_service.id) e
  where (p_preferred_resource_id is null or e.resource_id = p_preferred_resource_id)
    and not exists (
      select 1
      from public.resource_occupancies o
      where o.tenant_id = p_tenant_id
        and o.resource_id = e.resource_id
        and o.period && p_occupancy
    )
  order by e.sort_order
  limit 1;

  return v_resource_id;
end;
$$;

revoke all on function app.pick_resource(uuid, public.services, tstzrange, uuid) from public;

-- ---------------------------------------------------------------------------
-- Idempotency ledger helpers
-- ---------------------------------------------------------------------------
create or replace function app.idempotency_lookup(
  p_tenant_id uuid,
  p_scope text,
  p_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.idempotency_keys;
begin
  if p_key is null or length(p_key) < 8 then
    return null;
  end if;

  select * into v_row
  from public.idempotency_keys k
  where k.tenant_id = p_tenant_id and k.scope = p_scope and k.key = p_key;

  if not found then
    return null;
  end if;

  if v_row.request_hash <> p_request_hash then
    raise exception 'BK008: this idempotency key was used with a different payload'
      using errcode = 'BK008';
  end if;

  return v_row.response;
end;
$$;

revoke all on function app.idempotency_lookup(uuid, text, text, text) from public;

create or replace function app.idempotency_store(
  p_tenant_id uuid,
  p_scope text,
  p_key text,
  p_request_hash text,
  p_response jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.idempotency_keys (tenant_id, scope, key, request_hash, response)
  values (p_tenant_id, p_scope, p_key, p_request_hash, p_response)
  on conflict (tenant_id, scope, key) do nothing;
$$;

revoke all on function app.idempotency_store(uuid, text, text, text, jsonb) from public;

-- ---------------------------------------------------------------------------
-- CREATE
-- ---------------------------------------------------------------------------
create or replace function public.create_booking(
  p_tenant_slug citext,
  p_service_key text,
  p_starts_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_customer_comment text default null,
  p_booking_id uuid default null,
  p_token_hash bytea default null,
  p_idempotency_key text default null,
  p_request_hash text default null,
  p_preferred_resource_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant public.tenants;
  v_service public.services;
  v_occupancy tstzrange;
  v_resource_id uuid;
  v_customer_id uuid;
  v_booking_id uuid;
  v_display_number bigint;
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_phone text;
begin
  select * into v_tenant
  from public.tenants t
  where t.slug = p_tenant_slug and t.status <> 'suspended';

  if not found then
    raise exception 'BK005: unknown or suspended tenant' using errcode = 'BK005';
  end if;

  -- shared atomic budget: protects the write path from being hammered
  perform app.enforce_rate_limit(
    'booking:' || v_tenant.id::text,
    v_tenant.public_rate_limit_per_minute,
    60
  );

  select * into v_service
  from public.services s
  where s.tenant_id = v_tenant.id and s.key = p_service_key and s.is_active;

  if not found then
    raise exception 'BK004: unknown service' using errcode = 'BK004';
  end if;

  v_request_hash := coalesce(
    p_request_hash,
    encode(digest(
      concat_ws('|', v_tenant.id::text, v_service.id::text, p_starts_at::text,
                coalesce(p_customer_phone, ''), coalesce(p_customer_name, '')),
      'sha256'
    ), 'hex')
  );

  v_replay := app.idempotency_lookup(v_tenant.id, 'create_booking', p_idempotency_key, v_request_hash);
  if v_replay is not null then
    return v_replay || jsonb_build_object('replayed', true);
  end if;

  v_phone := regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g');
  if length(v_phone) < 5 or length(v_phone) > 20 or length(btrim(coalesce(p_customer_name, ''))) < 2 then
    raise exception 'BK010: customer name and phone are required' using errcode = 'BK010';
  end if;

  v_occupancy := app.validate_booking_start(v_tenant, v_service, p_starts_at);
  v_resource_id := app.pick_resource(v_tenant.id, v_service, v_occupancy, p_preferred_resource_id);

  if v_resource_id is null then
    raise exception 'BK001: no resource is free for this moment' using errcode = 'BK001';
  end if;

  insert into public.customers (tenant_id, name, phone, phone_normalized, email)
  values (
    v_tenant.id,
    btrim(p_customer_name),
    btrim(p_customer_phone),
    v_phone,
    nullif(btrim(coalesce(p_customer_email, '')), '')
  )
  on conflict (tenant_id, phone_normalized) do update
    set name = excluded.name,
        email = coalesce(excluded.email, public.customers.email)
  returning id into v_customer_id;

  v_booking_id := coalesce(p_booking_id, gen_random_uuid());
  v_display_number := app.next_counter(v_tenant.id, 'booking');

  insert into public.bookings (
    id, tenant_id, customer_id, service_id, resource_id, display_number,
    price_cents, currency, duration_min, buffer_before_min, buffer_after_min,
    service_name_snapshot, starts_at, ends_at, status,
    customer_comment, access_token_hash, idempotency_hash
  )
  values (
    v_booking_id, v_tenant.id, v_customer_id, v_service.id, v_resource_id, v_display_number,
    v_service.price_cents, v_service.currency, v_service.duration_min,
    v_service.buffer_before_min, v_service.buffer_after_min,
    v_service.name,
    p_starts_at,
    p_starts_at + make_interval(mins => v_service.duration_min),
    'confirmed',
    nullif(btrim(coalesce(p_customer_comment, '')), ''),
    coalesce(p_token_hash, digest(gen_random_uuid()::text, 'sha256')),
    digest(coalesce(p_idempotency_key, v_booking_id::text), 'sha256')
  );

  insert into public.resource_occupancies (
    tenant_id, resource_id, booking_id, kind, period
  )
  values (v_tenant.id, v_resource_id, v_booking_id, 'booking', v_occupancy);

  insert into public.booking_events (tenant_id, booking_id, event, actor, payload)
  values (
    v_tenant.id, v_booking_id, 'booking_created', 'customer',
    jsonb_build_object('startsAt', p_starts_at, 'resourceId', v_resource_id)
  );

  -- Preview tenants are demo-only and must never send real notifications.
  if v_tenant.status = 'live' then
    perform app.enqueue_notification(
      v_tenant.id, v_booking_id, 'booking_created', 'push',
      'booking_created:' || v_booking_id::text || ':push',
      jsonb_build_object('audience', 'customer', 'bookingId', v_booking_id)
    );
    perform app.enqueue_notification(
      v_tenant.id, v_booking_id, 'booking_created', 'push',
      'booking_created:' || v_booking_id::text || ':owner',
      jsonb_build_object('audience', 'owner', 'bookingId', v_booking_id)
    );
  end if;

  v_response := jsonb_build_object(
    'bookingId', v_booking_id,
    'displayNumber', v_display_number,
    'tenantSlug', v_tenant.slug,
    'serviceKey', v_service.key,
    'serviceName', v_service.name,
    'resourceId', v_resource_id,
    'startsAt', p_starts_at,
    'endsAt', p_starts_at + make_interval(mins => v_service.duration_min),
    'bufferBeforeMin', v_service.buffer_before_min,
    'bufferAfterMin', v_service.buffer_after_min,
    'priceCents', v_service.price_cents,
    'currency', v_service.currency,
    'status', 'confirmed',
    'timezone', v_tenant.timezone,
    'replayed', false
  );

  perform app.idempotency_store(
    v_tenant.id, 'create_booking', p_idempotency_key, v_request_hash, v_response
  );

  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- READ BY TOKEN
-- The customer holds only the token; we look the booking up by its hash.
-- ---------------------------------------------------------------------------
create or replace function public.get_booking_by_token(p_token_hash bytea)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'bookingId', b.id,
    'displayNumber', b.display_number,
    'tenantSlug', t.slug,
    'tenantName', t.name,
    'timezone', t.timezone,
    'currency', b.currency,
    'status', b.status,
    'startsAt', b.starts_at,
    'endsAt', b.ends_at,
    'durationMin', b.duration_min,
    'bufferBeforeMin', b.buffer_before_min,
    'bufferAfterMin', b.buffer_after_min,
    'serviceKey', s.key,
    'serviceName', b.service_name_snapshot,
    'resourceName', r.name,
    'priceCents', b.price_cents,
    'customerName', c.name,
    'customerPhone', c.phone,
    'customerComment', b.customer_comment,
    'minCancelNoticeMinutes', t.min_cancel_notice_minutes,
    'canReschedule', b.status in ('pending', 'confirmed')
       and b.starts_at > now() + make_interval(mins => t.min_cancel_notice_minutes),
    'canCancel', b.status in ('pending', 'confirmed')
       and b.starts_at > now() + make_interval(mins => t.min_cancel_notice_minutes),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'amountCents', p.amount_cents, 'currency', p.currency,
        'method', p.method, 'status', p.status, 'paidAt', p.paid_at
      ) order by p.created_at)
      from public.payments p
      where p.tenant_id = b.tenant_id and p.booking_id = b.id
    ), '[]'::jsonb)
  )
  from public.bookings b
  join public.tenants t on t.id = b.tenant_id
  join public.services s on s.tenant_id = b.tenant_id and s.id = b.service_id
  join public.resources r on r.tenant_id = b.tenant_id and r.id = b.resource_id
  join public.customers c on c.tenant_id = b.tenant_id and c.id = b.customer_id
  where b.access_token_hash = p_token_hash;
$$;

-- ---------------------------------------------------------------------------
-- RESCHEDULE
-- Single transaction. If the new interval collides, the exception is caught,
-- the subtransaction is rolled back and the ORIGINAL booking survives intact.
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_booking(
  p_token_hash bytea,
  p_new_starts_at timestamptz,
  p_idempotency_key text default null,
  p_request_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings;
  v_tenant public.tenants;
  v_service public.services;
  v_occupancy tstzrange;
  v_resource_id uuid;
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
begin
  select * into v_booking from public.bookings b
  where b.access_token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'BK006: booking not found' using errcode = 'BK006';
  end if;

  select * into v_tenant from public.tenants t where t.id = v_booking.tenant_id;
  select * into v_service from public.services s
  where s.tenant_id = v_booking.tenant_id and s.id = v_booking.service_id;

  v_request_hash := coalesce(
    p_request_hash,
    encode(digest(concat_ws('|', v_booking.id::text, p_new_starts_at::text), 'sha256'), 'hex')
  );

  v_replay := app.idempotency_lookup(v_booking.tenant_id, 'reschedule_booking', p_idempotency_key, v_request_hash);
  if v_replay is not null then
    return v_replay || jsonb_build_object('replayed', true);
  end if;

  if v_booking.status not in ('pending', 'confirmed') then
    raise exception 'BK007: a booking in status % cannot be moved', v_booking.status
      using errcode = 'BK007';
  end if;

  if v_booking.starts_at <= now() + make_interval(mins => v_tenant.min_cancel_notice_minutes) then
    raise exception 'BK007: this booking can no longer be moved'
      using errcode = 'BK007';
  end if;

  v_occupancy := app.validate_booking_start(v_tenant, v_service, p_new_starts_at);
  v_resource_id := app.pick_resource(v_booking.tenant_id, v_service, v_occupancy, null);

  if v_resource_id is null then
    raise exception 'BK001: no resource is free for the requested moment'
      using errcode = 'BK001';
  end if;

  begin
    delete from public.resource_occupancies o
    where o.tenant_id = v_booking.tenant_id and o.booking_id = v_booking.id;

    insert into public.resource_occupancies (tenant_id, resource_id, booking_id, kind, period)
    values (v_booking.tenant_id, v_resource_id, v_booking.id, 'booking', v_occupancy);
  exception
    when exclusion_violation then
      -- subtransaction rolled back: the original occupancy row is still there
      raise exception 'BK001: the new moment was taken while you were choosing'
        using errcode = 'BK001';
  end;

  update public.bookings
  set starts_at = p_new_starts_at,
      ends_at = p_new_starts_at + make_interval(mins => v_service.duration_min),
      buffer_before_min = v_service.buffer_before_min,
      buffer_after_min = v_service.buffer_after_min,
      resource_id = v_resource_id,
      rescheduled_count = rescheduled_count + 1,
      last_rescheduled_at = now()
  where id = v_booking.id;

  insert into public.booking_events (tenant_id, booking_id, event, actor, payload)
  values (
    v_booking.tenant_id, v_booking.id, 'booking_rescheduled', 'customer',
    jsonb_build_object(
      'from', v_booking.starts_at, 'to', p_new_starts_at, 'resourceId', v_resource_id
    )
  );

  if v_tenant.status = 'live' then
    -- the old reminders are now wrong; retire them and remind on the new time
    perform app.retire_booking_jobs(
      v_booking.tenant_id, v_booking.id, 'rescheduled to ' || p_new_starts_at::text
    );
    perform app.enqueue_notification(
      v_booking.tenant_id, v_booking.id, 'booking_rescheduled', 'push',
      'booking_rescheduled:' || v_booking.id::text || ':' || extract(epoch from p_new_starts_at)::bigint::text,
      jsonb_build_object(
        'audience', 'customer', 'bookingId', v_booking.id,
        'previousStartsAt', v_booking.starts_at, 'startsAt', p_new_starts_at
      )
    );
    perform app.enqueue_notification(
      v_booking.tenant_id, v_booking.id, 'booking_rescheduled', 'push',
      'booking_rescheduled_owner:' || v_booking.id::text || ':' || extract(epoch from p_new_starts_at)::bigint::text,
      jsonb_build_object(
        'audience', 'owner', 'bookingId', v_booking.id,
        'previousStartsAt', v_booking.starts_at, 'startsAt', p_new_starts_at
      )
    );
  end if;

  v_response := jsonb_build_object(
    'bookingId', v_booking.id,
    'displayNumber', v_booking.display_number,
    'tenantSlug', v_tenant.slug,
    'serviceKey', v_service.key,
    'serviceName', v_booking.service_name_snapshot,
    'resourceId', v_resource_id,
    'startsAt', p_new_starts_at,
    'endsAt', p_new_starts_at + make_interval(mins => v_service.duration_min),
    'priceCents', v_booking.price_cents,
    'currency', v_booking.currency,
    'status', v_booking.status,
    'timezone', v_tenant.timezone,
    'previousStartsAt', v_booking.starts_at,
    'replayed', false
  );

  perform app.idempotency_store(
    v_booking.tenant_id, 'reschedule_booking', p_idempotency_key, v_request_hash, v_response
  );

  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- CANCEL
-- ---------------------------------------------------------------------------
create or replace function public.cancel_booking(
  p_token_hash bytea,
  p_reason text default null,
  p_idempotency_key text default null,
  p_request_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings;
  v_tenant public.tenants;
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
begin
  select * into v_booking from public.bookings b
  where b.access_token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'BK006: booking not found' using errcode = 'BK006';
  end if;

  select * into v_tenant from public.tenants t where t.id = v_booking.tenant_id;

  v_request_hash := coalesce(
    p_request_hash,
    encode(digest(concat_ws('|', v_booking.id::text, 'cancel'), 'sha256'), 'hex')
  );

  v_replay := app.idempotency_lookup(v_booking.tenant_id, 'cancel_booking', p_idempotency_key, v_request_hash);
  if v_replay is not null then
    return v_replay || jsonb_build_object('replayed', true);
  end if;

  -- cancelling twice is not an error: the second call is a no-op replay
  if v_booking.status = 'cancelled' then
    v_response := jsonb_build_object(
      'bookingId', v_booking.id,
      'status', 'cancelled',
      'startsAt', v_booking.starts_at,
      'cancelledAt', v_booking.cancelled_at,
      'tenantSlug', v_tenant.slug,
      'replayed', true
    );
    perform app.idempotency_store(
      v_booking.tenant_id, 'cancel_booking', p_idempotency_key, v_request_hash, v_response
    );
    return v_response;
  end if;

  if v_booking.status not in ('pending', 'confirmed') then
    raise exception 'BK007: a booking in status % cannot be cancelled', v_booking.status
      using errcode = 'BK007';
  end if;

  delete from public.resource_occupancies o
  where o.tenant_id = v_booking.tenant_id and o.booking_id = v_booking.id;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = v_booking.id;

  insert into public.booking_events (tenant_id, booking_id, event, actor, payload)
  values (
    v_booking.tenant_id, v_booking.id, 'booking_cancelled', 'customer',
    jsonb_build_object('reason', p_reason)
  );

  if v_tenant.status = 'live' then
    perform app.retire_booking_jobs(v_booking.tenant_id, v_booking.id, 'booking cancelled');
    perform app.enqueue_notification(
      v_tenant.id, v_booking.id, 'booking_cancelled', 'push',
      'booking_cancelled:' || v_booking.id::text || ':owner',
      jsonb_build_object('audience', 'owner', 'bookingId', v_booking.id)
    );
  end if;

  v_response := jsonb_build_object(
    'bookingId', v_booking.id,
    'displayNumber', v_booking.display_number,
    'tenantSlug', v_tenant.slug,
    'status', 'cancelled',
    'startsAt', v_booking.starts_at,
    'cancelledAt', now(),
    'replayed', false
  );

  perform app.idempotency_store(
    v_booking.tenant_id, 'cancel_booking', p_idempotency_key, v_request_hash, v_response
  );

  return v_response;
end;
$$;
