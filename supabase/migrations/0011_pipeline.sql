-- =============================================================================
-- 0011_pipeline.sql
-- The only write path used by `tenant:publish`. Restricted to service_role.
--
-- Re-publish guarantees:
--   * rows are UPSERTed, never deleted, so bookings that point at a service or
--     a resource keep their foreign keys;
--   * bookings are not touched at all;
--   * assets uploaded by the owner (origin = 'owner') are preserved; only the
--     pipeline's own assets are replaced;
--   * the studio does not silently go live: status only changes when the
--     configuration asks for it and the readiness checks pass.
-- =============================================================================

create or replace function public.replace_pipeline_assets(
  p_tenant_id uuid,
  p_assets jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  delete from public.tenant_assets
  where tenant_id = p_tenant_id and origin = 'pipeline';

  insert into public.tenant_assets (tenant_id, kind, url, origin, alt, sort_order, storage_path)
  select
    p_tenant_id,
    (a ->> 'kind'),
    (a ->> 'url'),
    'pipeline',
    (a ->> 'alt'),
    coalesce((a ->> 'sortOrder')::integer, 0),
    (a ->> 'storagePath')
  from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) as a;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.publish_tenant_config(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slug citext := (p_config ->> 'slug')::citext;
  v_tenant_id uuid;
  v_status public.tenant_status;
  v_requested_status text := coalesce(p_config ->> 'status', 'preview');
  v_services integer := 0;
  v_resources integer := 0;
  v_hours integer := 0;
  v_assets integer := 0;
  v_bookings bigint := 0;
  v_owner_assets bigint := 0;
  v_service_count integer;
  v_resource_count integer;
  v_hours_count integer;
  v_item jsonb;
begin
  if v_slug is null then
    raise exception 'BK010: config.slug is required' using errcode = 'BK010';
  end if;

  if v_requested_status not in ('preview', 'live', 'suspended') then
    raise exception 'BK010: unknown status %', v_requested_status using errcode = 'BK010';
  end if;

  v_status := v_requested_status::public.tenant_status;

  -- ----- tenant -----------------------------------------------------------
  insert into public.tenants (
    slug, name, tagline, description, timezone, locale, currency,
    accent_color, accent_foreground, contact_phone, contact_email,
    contact_whatsapp, contact_telegram, address, map_url,
    booking_lead_minutes, booking_horizon_days, slot_step_minutes,
    min_cancel_notice_minutes, ai_enabled, ai_persona,
    public_rate_limit_per_minute, ai_calls_per_day,
    published_config, published_config_hash, published_at
  )
  values (
    v_slug,
    p_config ->> 'name',
    p_config ->> 'tagline',
    p_config ->> 'description',
    coalesce(p_config ->> 'timezone', 'UTC'),
    coalesce(p_config ->> 'locale', 'ru-RU'),
    upper(coalesce(p_config ->> 'currency', 'RUB')),
    coalesce(p_config ->> 'accentColor', '#ff6a00'),
    coalesce(p_config ->> 'accentForeground', '#0b0b0c'),
    p_config #>> '{contacts,phone}',
    p_config #>> '{contacts,email}',
    p_config #>> '{contacts,whatsapp}',
    p_config #>> '{contacts,telegram}',
    p_config ->> 'address',
    p_config ->> 'mapUrl',
    coalesce((p_config #>> '{booking,leadMinutes}')::integer, 60),
    coalesce((p_config #>> '{booking,horizonDays}')::integer, 45),
    coalesce((p_config #>> '{booking,slotStepMinutes}')::integer, 30),
    coalesce((p_config #>> '{booking,minCancelNoticeMinutes}')::integer, 120),
    coalesce((p_config #>> '{ai,enabled}')::boolean, false),
    p_config #>> '{ai,persona}',
    coalesce((p_config #>> '{limits,publicRateLimitPerMinute}')::integer, 90),
    coalesce((p_config #>> '{limits,aiCallsPerDay}')::integer, 200),
    p_config,
    encode(digest(p_config::text, 'sha256'), 'hex'),
    now()
  )
  on conflict (slug) do update set
    name = excluded.name,
    tagline = excluded.tagline,
    description = excluded.description,
    timezone = excluded.timezone,
    locale = excluded.locale,
    currency = excluded.currency,
    accent_color = excluded.accent_color,
    accent_foreground = excluded.accent_foreground,
    contact_phone = excluded.contact_phone,
    contact_email = excluded.contact_email,
    contact_whatsapp = excluded.contact_whatsapp,
    contact_telegram = excluded.contact_telegram,
    address = excluded.address,
    map_url = excluded.map_url,
    booking_lead_minutes = excluded.booking_lead_minutes,
    booking_horizon_days = excluded.booking_horizon_days,
    slot_step_minutes = excluded.slot_step_minutes,
    min_cancel_notice_minutes = excluded.min_cancel_notice_minutes,
    ai_enabled = excluded.ai_enabled,
    ai_persona = excluded.ai_persona,
    public_rate_limit_per_minute = excluded.public_rate_limit_per_minute,
    ai_calls_per_day = excluded.ai_calls_per_day,
    published_config = excluded.published_config,
    published_config_hash = excluded.published_config_hash,
    published_at = excluded.published_at,
    -- status is only ever changed by an explicit configuration value
    status = excluded.status
  returning id into v_tenant_id;

  -- ----- resources --------------------------------------------------------
  for v_item in select * from jsonb_array_elements(coalesce(p_config -> 'resources', '[]'::jsonb))
  loop
    insert into public.resources (tenant_id, key, name, kind, description, sort_order, is_active)
    values (
      v_tenant_id,
      v_item ->> 'key',
      v_item ->> 'name',
      v_item ->> 'kind',
      v_item ->> 'description',
      coalesce((v_item ->> 'sortOrder')::integer, 0),
      coalesce((v_item ->> 'isActive')::boolean, true)
    )
    on conflict (tenant_id, key) do update set
      name = excluded.name,
      kind = excluded.kind,
      description = excluded.description,
      sort_order = excluded.sort_order,
      is_active = excluded.is_active;

    v_resources := v_resources + 1;
  end loop;

  -- ----- services ---------------------------------------------------------
  for v_item in select * from jsonb_array_elements(coalesce(p_config -> 'services', '[]'::jsonb))
  loop
    insert into public.services (
      tenant_id, key, name, description, duration_min, buffer_before_min,
      buffer_after_min, price_cents, currency, required_resource_kind,
      category, image_url, spans_days, sort_order, is_active
    )
    values (
      v_tenant_id,
      v_item ->> 'key',
      v_item ->> 'name',
      v_item ->> 'description',
      (v_item ->> 'durationMin')::integer,
      coalesce((v_item ->> 'bufferBeforeMin')::integer, 0),
      coalesce((v_item ->> 'bufferAfterMin')::integer, 0),
      (v_item ->> 'priceCents')::bigint,
      upper(coalesce(v_item ->> 'currency', p_config ->> 'currency', 'RUB')),
      v_item ->> 'requiredResourceKind',
      v_item ->> 'category',
      v_item ->> 'imageUrl',
      coalesce((v_item ->> 'spansDays')::boolean, false),
      coalesce((v_item ->> 'sortOrder')::integer, 0),
      coalesce((v_item ->> 'isActive')::boolean, true)
    )
    on conflict (tenant_id, key) do update set
      name = excluded.name,
      description = excluded.description,
      duration_min = excluded.duration_min,
      buffer_before_min = excluded.buffer_before_min,
      buffer_after_min = excluded.buffer_after_min,
      -- catalogue price only: already-created bookings keep their snapshot
      price_cents = excluded.price_cents,
      currency = excluded.currency,
      required_resource_kind = excluded.required_resource_kind,
      category = excluded.category,
      image_url = excluded.image_url,
      spans_days = excluded.spans_days,
      sort_order = excluded.sort_order,
      is_active = excluded.is_active;

    v_services := v_services + 1;
  end loop;

  -- services that disappeared from the config are deactivated, never deleted
  update public.services s
  set is_active = false
  where s.tenant_id = v_tenant_id
    and s.is_active
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_config -> 'services', '[]'::jsonb)) as c
      where c ->> 'key' = s.key
    );

  update public.resources r
  set is_active = false
  where r.tenant_id = v_tenant_id
    and r.is_active
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_config -> 'resources', '[]'::jsonb)) as c
      where c ->> 'key' = r.key
    );

  -- ----- working hours ----------------------------------------------------
  for v_item in select * from jsonb_array_elements(coalesce(p_config -> 'hours', '[]'::jsonb))
  loop
    insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, is_closed)
    values (
      v_tenant_id,
      (v_item ->> 'weekday')::smallint,
      coalesce((v_item ->> 'opensAt')::time, '09:00'::time),
      coalesce((v_item ->> 'closesAt')::time, '09:00'::time),
      coalesce((v_item ->> 'isClosed')::boolean, false)
    )
    on conflict (tenant_id, weekday) do update set
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      is_closed = excluded.is_closed;

    v_hours := v_hours + 1;
  end loop;

  -- ----- exceptions -------------------------------------------------------
  -- Upserted, not replaced: an exception added by the owner from the cabinet
  -- survives a re-publish.
  for v_item in select * from jsonb_array_elements(coalesce(p_config -> 'exceptions', '[]'::jsonb))
  loop
    insert into public.schedule_exceptions (tenant_id, on_date, is_closed, opens_at, closes_at, note)
    values (
      v_tenant_id,
      (v_item ->> 'onDate')::date,
      coalesce((v_item ->> 'isClosed')::boolean, true),
      (v_item ->> 'opensAt')::time,
      (v_item ->> 'closesAt')::time,
      v_item ->> 'note'
    )
    on conflict (tenant_id, on_date) do update set
      is_closed = excluded.is_closed,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      note = excluded.note;
  end loop;

  -- ----- assets -----------------------------------------------------------
  v_assets := public.replace_pipeline_assets(v_tenant_id, coalesce(p_config -> 'assets', '[]'::jsonb));

  select count(*) into v_owner_assets
  from public.tenant_assets a
  where a.tenant_id = v_tenant_id and a.origin = 'owner';

  select count(*) into v_bookings
  from public.bookings b
  where b.tenant_id = v_tenant_id;

  -- ----- going live is conditional ---------------------------------------
  if v_status = 'live' then
    select count(*) into v_service_count
    from public.services s where s.tenant_id = v_tenant_id and s.is_active;
    select count(*) into v_resource_count
    from public.resources r where r.tenant_id = v_tenant_id and r.is_active;
    select count(*) into v_hours_count
    from public.business_hours h where h.tenant_id = v_tenant_id and not h.is_closed;

    if v_service_count = 0 or v_resource_count = 0 or v_hours_count = 0 then
      update public.tenants set status = 'preview' where id = v_tenant_id;
      return jsonb_build_object(
        'tenantId', v_tenant_id,
        'slug', v_slug,
        'status', 'preview',
        'activated', false,
        'reason', 'services, resources and working hours are required before going live',
        'services', v_services,
        'resources', v_resources,
        'hours', v_hours,
        'assets', v_assets,
        'bookingsPreserved', v_bookings,
        'ownerAssetsPreserved', v_owner_assets
      );
    end if;
  end if;

  update public.tenants set status = v_status where id = v_tenant_id;

  return jsonb_build_object(
    'tenantId', v_tenant_id,
    'slug', v_slug,
    'status', v_status,
    'activated', v_status = 'live',
    'services', v_services,
    'resources', v_resources,
    'hours', v_hours,
    'assets', v_assets,
    'bookingsPreserved', v_bookings,
    'ownerAssetsPreserved', v_owner_assets
  );
end;
$$;
