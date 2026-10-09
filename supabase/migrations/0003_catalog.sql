-- =============================================================================
-- 0003_catalog.sql
-- Resources (posts / bays / lifts / masters) and services.
--
-- Every table carries `tenant_id` and exposes a composite unique key
-- `(tenant_id, id)` so that child tables can use composite foreign keys.
-- That makes cross-tenant references structurally impossible, not merely
-- forbidden by a policy.
-- =============================================================================

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null,
  name text not null,
  -- The resource kind is what makes a service eligible for a concrete unit.
  kind text not null,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint resources_key_format check (key ~ '^[a-z0-9][a-z0-9_-]{1,48}$'),
  constraint resources_kind_format check (kind ~ '^[a-z][a-z0-9_]{1,32}$'),
  constraint resources_tenant_key unique (tenant_id, key),
  constraint resources_tenant_id_key unique (tenant_id, id)
);

create index resources_active_idx on public.resources (tenant_id, kind, sort_order)
  where is_active;

create trigger resources_touch
  before update on public.resources
  for each row execute function app.touch_updated_at();

create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  -- Occupancy is duration + both buffers, always contiguous.
  duration_min integer not null,
  buffer_before_min integer not null default 0,
  buffer_after_min integer not null default 0,
  price_cents bigint not null,
  currency char(3) not null,
  -- Which resource kind may serve this service. The concrete resource is chosen
  -- server-side from the eligible, currently free units.
  required_resource_kind text not null,
  category text,
  image_url text,
  -- false: the whole occupancy (duration + buffers) must fit inside one
  --        working window of the day;
  -- true : the service occupies the resource continuously across several days.
  --        In that case working hours define the admissible *acceptance
  --        moments* (when the car may be dropped off), not the whole span.
  spans_days boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint services_key_format check (key ~ '^[a-z0-9][a-z0-9_-]{1,48}$'),
  constraint services_duration check (duration_min between 5 and 43200),
  constraint services_buffers check (
    buffer_before_min between 0 and 2880 and buffer_after_min between 0 and 2880
  ),
  constraint services_price check (price_cents >= 0),
  constraint services_currency check (currency ~ '^[A-Z]{3}$'),
  constraint services_tenant_key unique (tenant_id, key),
  constraint services_tenant_id_key unique (tenant_id, id)
);

create index services_active_idx on public.services (tenant_id, is_active, sort_order);

create trigger services_touch
  before update on public.services
  for each row execute function app.touch_updated_at();

-- Optional explicit allow-list. When a service has no rows here, eligibility
-- falls back to matching `required_resource_kind`. When rows exist, the
-- service may only be served by the listed resources.
create table public.service_resources (
  tenant_id uuid not null,
  service_id uuid not null,
  resource_id uuid not null,
  created_at timestamptz not null default now(),

  primary key (service_id, resource_id),
  constraint service_resources_service_fk
    foreign key (tenant_id, service_id)
    references public.services (tenant_id, id) on delete cascade,
  constraint service_resources_resource_fk
    foreign key (tenant_id, resource_id)
    references public.resources (tenant_id, id) on delete cascade
);

create index service_resources_resource_idx on public.service_resources (tenant_id, resource_id);
