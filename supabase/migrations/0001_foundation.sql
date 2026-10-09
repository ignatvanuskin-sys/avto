-- =============================================================================
-- 0001_foundation.sql
-- Extensions, internal schema, enum types and shared helper functions.
--
-- Design notes
--  * everything domain-related lives in the exposed `public` schema;
--  * helper/predicate logic lives in the unexposed `app` schema so it can never
--    be reached through PostgREST (only `public` is exposed);
--  * tenant isolation is enforced on three independent levels:
--      1. composite (tenant_id, id) foreign keys  -> structural guarantee;
--      2. RLS policies                            -> row level guarantee;
--      3. GRANTs                                  -> column/object guarantee.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "btree_gist";
create extension if not exists "citext";

create schema if not exists app;

comment on schema app is
  'Internal helpers. Not exposed through PostgREST. Never grant usage to anon.';

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
create type public.tenant_status as enum ('preview', 'live', 'suspended');
create type public.member_role as enum ('owner', 'manager', 'master', 'viewer');
create type public.member_status as enum ('invited', 'active', 'revoked');
create type public.occupancy_kind as enum ('booking', 'block');
create type public.booking_status as enum (
  'pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'
);
create type public.payment_method as enum ('cash', 'card', 'transfer', 'online');
create type public.payment_status as enum ('pending', 'paid', 'refunded', 'failed');
create type public.job_kind as enum (
  'booking_created', 'booking_rescheduled', 'booking_cancelled',
  'reminder_24h', 'reminder_2h'
);
create type public.job_channel as enum ('push', 'ics', 'email');
create type public.job_status as enum ('pending', 'processing', 'sent', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Membership predicate.
-- SECURITY DEFINER + STABLE so that RLS policies can call it without the
-- caller needing SELECT on tenant_members (which would recurse).
-- ---------------------------------------------------------------------------
create or replace function app.is_tenant_member(
  p_tenant_id uuid,
  p_roles public.member_role[] default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (p_roles is null or m.role = any (p_roles))
  );
$$;

revoke all on function app.is_tenant_member(uuid, public.member_role[]) from public;

-- ---------------------------------------------------------------------------
-- Timezone helpers. A tenant timezone is the single source of truth for
-- working hours, exception dates and every reported period.
-- ---------------------------------------------------------------------------
create or replace function app.tenant_timezone(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.timezone from public.tenants t where t.id = p_tenant_id;
$$;

revoke all on function app.tenant_timezone(uuid) from public;

-- Convert a wall-clock timestamp in the tenant timezone into timestamptz.
create or replace function app.tenant_local_to_utc(p_tenant_id uuid, p_local timestamp)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (p_local at time zone app.tenant_timezone(p_tenant_id));
$$;

revoke all on function app.tenant_local_to_utc(uuid, timestamp) from public;

-- NOTE: `app.next_counter` and its backing table `public.tenant_counters` are
-- created in 0002, because the table references public.tenants.
