-- =============================================================================
-- 0013_storage.sql
-- Storage bucket for studio branding and photos uploaded by the owner.
--
-- Object layout is `<tenant_id>/<kind>/<filename>`, so the tenant that owns an
-- object can be recovered from its path and used directly in the policy. That
-- keeps the Storage rules aligned with the table rules instead of inventing a
-- second access model.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tenant-assets',
  'tenant-assets',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Branding must be readable to render the public page and the PWA icons.
create policy tenant_assets_storage_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'tenant-assets');

-- A safe uuid extraction: a malformed folder name yields null, and
-- app.is_tenant_member(null) is false.
create or replace function app.storage_tenant_id(p_name text)
returns uuid
language sql
stable
as $$
  select case
    when (storage.foldername(p_name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((storage.foldername(p_name))[1])::uuid
    else null
  end;
$$;

grant execute on function app.storage_tenant_id(text) to authenticated;

create policy tenant_assets_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-assets'
    and app.is_tenant_member(
      app.storage_tenant_id(name),
      array['owner', 'manager']::public.member_role[]
    )
  );

create policy tenant_assets_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'tenant-assets'
    and app.is_tenant_member(
      app.storage_tenant_id(name),
      array['owner', 'manager']::public.member_role[]
    )
  );

create policy tenant_assets_storage_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tenant-assets'
    and app.is_tenant_member(
      app.storage_tenant_id(name),
      array['owner', 'manager']::public.member_role[]
    )
  );
