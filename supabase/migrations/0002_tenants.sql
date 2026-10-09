-- =============================================================================
-- 0002_tenants.sql
-- Tenants, membership, published configuration, working hours and exceptions.
--
-- Invariant: business.json / generated SQL is only *input* for the pipeline.
-- The database is the runtime source of truth, which is what allows a studio
-- to keep editing prices, photos and hours after it has been published.
-- =============================================================================

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  name text not null,
  -- 'preview' tenants contain demo-only data and must never send real
  -- notifications. 'live' is only reached after business checks pass.
  status public.tenant_status not null default 'preview',
  tagline text,
  description text,
  timezone text not null default 'UTC',
  locale text not null default 'ru-RU',
  currency char(3) not null default 'RUB',
  accent_color text not null default '#ff6a00',
  accent_foreground text not null default '#0b0b0c',
  contact_phone text,
  contact_email text,
  contact_whatsapp text,
  contact_telegram text,
  address text,
  map_url text,
  booking_lead_minutes integer not null default 60,
  booking_horizon_days integer not null default 45,
  slot_step_minutes integer not null default 30,
  min_cancel_notice_minutes integer not null default 120,
  ai_enabled boolean not null default false,
  ai_persona text,
  -- shared atomic budgets (see 0008_limits.sql). They are per tenant so one
  -- studio can never exhaust another studio's allowance.
  public_rate_limit_per_minute integer not null default 90,
  ai_calls_per_day integer not null default 200,
  -- Denormalised copy of the published configuration, for auditing and for the
  -- "re-publish keeps owner data" check. Never read at request time.
  published_config jsonb,
  published_config_hash text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenants_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint tenants_slot_step check (slot_step_minutes between 5 and 480),
  constraint tenants_horizon check (booking_horizon_days between 1 and 730),
  constraint tenants_lead check (booking_lead_minutes between 0 and 43200),
  constraint tenants_accent check (accent_color ~* '^#[0-9a-f]{6}$'),
  constraint tenants_currency check (currency ~ '^[A-Z]{3}$'),
  constraint tenants_rate_limit check (public_rate_limit_per_minute between 1 and 100000),
  constraint tenants_ai_calls check (ai_calls_per_day between 0 and 100000)
);

comment on column public.tenants.published_config is
  'Last pipeline-published business.json snapshot. Runtime reads the live rows.';

create trigger tenants_touch
  before update on public.tenants
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Per-tenant atomic counters (human-readable booking numbers and similar).
-- ---------------------------------------------------------------------------
create table public.tenant_counters (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  value bigint not null default 0,
  primary key (tenant_id, name)
);

create or replace function app.next_counter(p_tenant_id uuid, p_name text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value bigint;
begin
  insert into public.tenant_counters (tenant_id, name, value)
  values (p_tenant_id, p_name, 1)
  on conflict (tenant_id, name)
    do update set value = public.tenant_counters.value + 1
  returning value into v_value;

  return v_value;
end;
$$;

revoke all on function app.next_counter(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Membership. Owner access is proven by a row here, checked on the server.
-- There is deliberately no public owner signup endpoint.
-- ---------------------------------------------------------------------------
create table public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'viewer',
  status public.member_status not null default 'invited',
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_members_unique unique (tenant_id, user_id),
  constraint tenant_members_tenant_id_key unique (tenant_id, id)
);

create index tenant_members_user_idx on public.tenant_members (user_id) where status = 'active';

create trigger tenant_members_touch
  before update on public.tenant_members
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Working hours: these define the moments at which a service may start.
-- weekday follows ISO-8601 (1 = Monday .. 7 = Sunday).
-- ---------------------------------------------------------------------------
create table public.business_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  weekday smallint not null,
  opens_at time not null,
  closes_at time not null,
  is_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint business_hours_weekday check (weekday between 1 and 7),
  -- a closed day may carry equal placeholder times; an open day may not
  constraint business_hours_range check (is_closed or closes_at > opens_at),
  constraint business_hours_unique unique (tenant_id, weekday),
  constraint business_hours_tenant_id_key unique (tenant_id, id)
);

create trigger business_hours_touch
  before update on public.business_hours
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Exceptions override working hours for one concrete calendar date in the
-- tenant timezone: a closed day, or a shortened/extended working window.
-- ---------------------------------------------------------------------------
create table public.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  on_date date not null,
  is_closed boolean not null default true,
  opens_at time,
  closes_at time,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint schedule_exceptions_unique unique (tenant_id, on_date),
  constraint schedule_exceptions_range check (
    is_closed
    or (opens_at is not null and closes_at is not null and closes_at > opens_at)
  ),
  constraint schedule_exceptions_tenant_id_key unique (tenant_id, id)
);

create trigger schedule_exceptions_touch
  before update on public.schedule_exceptions
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Per-tenant PWA / branding assets that the pipeline writes and the owner can
-- later override from the cabinet (so a re-publish keeps uploaded photos).
-- ---------------------------------------------------------------------------
create table public.tenant_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null,
  storage_path text,
  url text,
  -- 'pipeline' assets are replaced by `tenant:publish`;
  -- 'owner' assets are never deleted by a re-publish.
  origin text not null default 'pipeline',
  sort_order integer not null default 0,
  alt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_assets_origin check (origin in ('pipeline', 'owner')),
  constraint tenant_assets_kind check (
    kind in ('logo', 'hero', 'gallery', 'icon', 'maskable', 'apple-touch', 'startup', 'other')
  ),
  constraint tenant_assets_tenant_id_key unique (tenant_id, id)
);

create index tenant_assets_lookup_idx on public.tenant_assets (tenant_id, kind, sort_order);

create trigger tenant_assets_touch
  before update on public.tenant_assets
  for each row execute function app.touch_updated_at();
