-- =============================================================================
-- 0012_rls_grants.sql
-- Row level security and the final privilege surface.
--
-- The security model, in one paragraph:
--   * `anon` has **no** table privileges at all. It can only EXECUTE the seven
--     public RPCs, each of which is SECURITY DEFINER and returns a projection
--     that contains no personal data, no payments and no token hashes.
--   * `authenticated` may only SELECT tenant-scoped rows, and only for tenants
--     it is an active member of. There are deliberately no INSERT/UPDATE/DELETE
--     policies: every mutation is funnelled through a vetted RPC that re-checks
--     membership and snapshots server-side values.
--   * `service_role` is the only role that can publish tenant configuration,
--     drive the notification outbox or spend the LLM budget.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remove the permissive defaults. Supabase grants anon/authenticated a lot
--    on the public schema by default; none of it is wanted here.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Functions are revoked selectively: a blanket revoke would also strip EXECUTE
-- from extension functions (citext operators, pgcrypto) that normal queries
-- depend on. Extension-owned members are skipped via pg_depend.deptype = 'e'.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (
        select 1
        from pg_depend d
        where d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
  end loop;
end;
$$;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS everywhere. A table without RLS and without grants is safe,
--    but enabling it makes the intent explicit and survives a stray GRANT.
-- ---------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.tenant_counters enable row level security;
alter table public.business_hours enable row level security;
alter table public.schedule_exceptions enable row level security;
alter table public.tenant_assets enable row level security;
alter table public.resources enable row level security;
alter table public.services enable row level security;
alter table public.service_resources enable row level security;
alter table public.customers enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_events enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.payments enable row level security;
alter table public.resource_occupancies enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.api_counters enable row level security;
alter table public.ai_usage enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Read policies for studio staff. Row visibility is decided by the
--    membership table, never by anything the client sends.
-- ---------------------------------------------------------------------------
create policy tenants_member_read on public.tenants
  for select to authenticated
  using (app.is_tenant_member(id));

create policy tenant_members_member_read on public.tenant_members
  for select to authenticated
  using (user_id = auth.uid() or app.is_tenant_member(tenant_id));

create policy tenant_counters_member_read on public.tenant_counters
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy business_hours_member_read on public.business_hours
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy schedule_exceptions_member_read on public.schedule_exceptions
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy tenant_assets_member_read on public.tenant_assets
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy resources_member_read on public.resources
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy services_member_read on public.services
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy service_resources_member_read on public.service_resources
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy customers_member_read on public.customers
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy bookings_member_read on public.bookings
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy booking_events_member_read on public.booking_events
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy payments_member_read on public.payments
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy resource_occupancies_member_read on public.resource_occupancies
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy notification_jobs_member_read on public.notification_jobs
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

create policy ai_usage_member_read on public.ai_usage
  for select to authenticated
  using (app.is_tenant_member(tenant_id));

-- A customer-device subscription is bound to one booking; an owner device is
-- bound to the member who registered it.
create policy push_subscriptions_read on public.push_subscriptions
  for select to authenticated
  using (
    app.is_tenant_member(tenant_id)
    or (audience = 'owner' and owner_user_id = auth.uid())
  );

-- Deliberately NO policy on:
--   * public.idempotency_keys  — contains customer details in stored responses
--   * public.api_counters      — internal budget bookkeeping
-- With RLS enabled and no policy, these are readable by service_role only.

-- ---------------------------------------------------------------------------
-- 4. Grants. SELECT only, and only where a row policy exists.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant usage on schema app to authenticated;
grant execute on function app.is_tenant_member(uuid, public.member_role[]) to authenticated;

grant select on
  public.tenants,
  public.tenant_members,
  public.tenant_counters,
  public.business_hours,
  public.schedule_exceptions,
  public.tenant_assets,
  public.resources,
  public.services,
  public.service_resources,
  public.customers,
  public.bookings,
  public.booking_events,
  public.payments,
  public.resource_occupancies,
  public.push_subscriptions,
  public.notification_jobs,
  public.ai_usage
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Public RPCs: the entire anonymous surface.
-- ---------------------------------------------------------------------------
grant execute on function public.public_tenant_profile(citext) to anon, authenticated;
grant execute on function public.available_slots(citext, text, date, date) to anon, authenticated;
grant execute on function public.get_booking_by_token(bytea) to anon, authenticated;
grant execute on function public.cancel_booking(bytea, text, text, text) to anon, authenticated;
grant execute on function public.reschedule_booking(bytea, timestamptz, text, text) to anon, authenticated;
grant execute on function public.create_booking(
  citext, text, timestamptz, text, text, text, text, uuid, bytea, text, text, uuid
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Owner RPCs.
-- ---------------------------------------------------------------------------
grant execute on function public.owner_tenant_context() to authenticated;
grant execute on function public.owner_stats(uuid, date, date) to authenticated;
grant execute on function public.block_resource(uuid, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.release_occupancy(uuid, uuid) to authenticated;
grant execute on function public.set_service_price(uuid, text, bigint) to authenticated;
grant execute on function public.set_service_active(uuid, text, boolean) to authenticated;
grant execute on function public.set_business_hours(uuid, smallint, time, time, boolean) to authenticated;
grant execute on function public.set_schedule_exception(uuid, date, boolean, time, time, text) to authenticated;
grant execute on function public.set_tenant_status(uuid, public.tenant_status) to authenticated;
grant execute on function public.set_booking_status(uuid, uuid, public.booking_status) to authenticated;
grant execute on function public.record_payment(
  uuid, uuid, bigint, public.payment_method, public.payment_status, text, text
) to authenticated;
grant execute on function public.upsert_tenant_asset(uuid, text, text, text, text, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Service-role only. Publishing, outbox and budget accounting are server
--    side operations and are never reachable from a browser.
-- ---------------------------------------------------------------------------
grant execute on function public.publish_tenant_config(jsonb) to service_role;
grant execute on function public.replace_pipeline_assets(uuid, jsonb) to service_role;
grant execute on function public.claim_notification_jobs(integer, integer, text) to service_role;
grant execute on function public.complete_notification_job(uuid, boolean, text, integer) to service_role;
grant execute on function public.enqueue_due_reminders(integer) to service_role;
grant execute on function public.consume_quota(text, bigint, integer) to service_role;
grant execute on function public.consume_ai_budget(uuid, bigint, integer) to service_role;
grant execute on function public.record_ai_tokens(uuid, bigint, bigint) to service_role;
