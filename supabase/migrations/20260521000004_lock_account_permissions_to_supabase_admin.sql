grant select
on table public.account_permissions
to authenticated;

revoke insert, update, delete
on table public.account_permissions
from authenticated;

drop policy if exists "account_permissions_select_self_or_admin" on public.account_permissions;
drop policy if exists "account_permissions_select_self" on public.account_permissions;
create policy "account_permissions_select_self"
on public.account_permissions for select
using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

drop policy if exists "account_permissions_insert_admin" on public.account_permissions;
drop policy if exists "account_permissions_update_admin" on public.account_permissions;
drop policy if exists "account_permissions_delete_admin" on public.account_permissions;
