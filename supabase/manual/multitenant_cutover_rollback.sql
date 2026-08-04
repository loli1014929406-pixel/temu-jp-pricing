-- Emergency rollback for the atomic tenant-mode cutover. Run this entire file
-- in one transaction before the legacy constraints retirement migration.

begin;

update private.multitenant_runtime_state
set permission_mode = 'legacy',
    updated_at = now()
where id = true;

drop index if exists public.pricing_settings_shop_unique;

insert into public.pricing_settings
select (jsonb_populate_record(
  null::public.pricing_settings,
  backup.source_row || jsonb_build_object(
    'enterprise_id', canonical.enterprise_id,
    'shop_id', canonical.shop_id
  )
)).*
from private.pricing_settings_legacy_user_backup backup
cross join lateral (
  select settings.enterprise_id, settings.shop_id
  from public.pricing_settings settings
  order by settings.created_at, settings.id
  limit 1
) canonical
where not exists (
  select 1
  from public.pricing_settings current_settings
  where current_settings.id = backup.source_id
);

do $rollback_validation$
begin
  if not exists (
    select 1
    from private.multitenant_runtime_state state
    where state.id = true
      and state.permission_mode = 'legacy'
  ) then
    raise exception 'permission mode rollback failed';
  end if;

  if exists (
    select 1
    from private.pricing_settings_legacy_user_backup backup
    where not exists (
      select 1
      from public.pricing_settings settings
      where settings.id = backup.source_id
    )
  ) then
    raise exception 'legacy pricing settings restoration failed';
  end if;
end
$rollback_validation$;

commit;
