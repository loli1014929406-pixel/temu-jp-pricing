create table if not exists public.account_permissions (
  email text primary key,
  permission_level text not null
    check (permission_level in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete
on table public.account_permissions
to authenticated;

drop trigger if exists account_permissions_set_updated_at on public.account_permissions;
create trigger account_permissions_set_updated_at
before update on public.account_permissions
for each row execute function public.set_updated_at();

create or replace function public.current_account_permission()
returns text
language sql
stable
security definer
set search_path = public
as 'select coalesce(
  (
    select account_permissions.permission_level
    from public.account_permissions
    where lower(account_permissions.email) =
      lower(coalesce(auth.jwt() ->> ''email'', ''''))
    limit 1
  ),
  case
    when exists (select 1 from public.account_permissions) then ''viewer''
    else ''admin''
  end
)';

create or replace function public.current_account_can_edit()
returns boolean
language sql
stable
security definer
set search_path = public
as 'select public.current_account_permission() in (''admin'', ''editor'')';

create or replace function public.current_account_can_delete()
returns boolean
language sql
stable
security definer
set search_path = public
as 'select public.current_account_permission() = ''admin''';

grant execute on function public.current_account_permission() to authenticated;
grant execute on function public.current_account_can_edit() to authenticated;
grant execute on function public.current_account_can_delete() to authenticated;

alter table public.account_permissions enable row level security;

drop policy if exists "account_permissions_select_self_or_admin" on public.account_permissions;
create policy "account_permissions_select_self_or_admin"
on public.account_permissions for select
using (
  lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  or public.current_account_can_delete()
);

drop policy if exists "account_permissions_insert_admin" on public.account_permissions;
create policy "account_permissions_insert_admin"
on public.account_permissions for insert
with check (public.current_account_can_delete());

drop policy if exists "account_permissions_update_admin" on public.account_permissions;
create policy "account_permissions_update_admin"
on public.account_permissions for update
using (public.current_account_can_delete())
with check (public.current_account_can_delete());

drop policy if exists "account_permissions_delete_admin" on public.account_permissions;
create policy "account_permissions_delete_admin"
on public.account_permissions for delete
using (public.current_account_can_delete());

