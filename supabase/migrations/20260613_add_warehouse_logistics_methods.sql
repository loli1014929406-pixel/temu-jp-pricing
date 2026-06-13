create or replace function public.current_account_has_permission()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
select case
  when auth.uid() is null then false
  when not exists (select 1 from public.account_permissions) then true
  else exists (
    select 1
    from public.account_permissions
    where lower(account_permissions.email) =
      lower(coalesce(auth.jwt() ->> 'email', ''))
  )
end
$$;

grant execute on function public.current_account_has_permission() to authenticated;

create or replace function public.current_account_permission()
returns text
language sql
stable
security definer
set search_path = public
as $$
select coalesce(
  (
    select account_permissions.permission_level
    from public.account_permissions
    where lower(account_permissions.email) =
      lower(coalesce(auth.jwt() ->> 'email', ''))
    limit 1
  ),
  case
    when exists (select 1 from public.account_permissions) then 'viewer'
    else 'admin'
  end
)
$$;

create or replace function public.current_account_can_edit()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
select public.current_account_permission() in ('admin', 'editor')
$$;

create or replace function public.current_account_can_delete()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
select public.current_account_permission() = 'admin'
$$;

grant execute on function public.current_account_permission() to authenticated;
grant execute on function public.current_account_can_edit() to authenticated;
grant execute on function public.current_account_can_delete() to authenticated;

create table if not exists public.logistics_methods (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists logistics_methods_name_unique
on public.logistics_methods (lower(btrim(name)));

create table if not exists public.warehouse_logistics_methods (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  logistics_method_id uuid not null references public.logistics_methods(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (warehouse_id, logistics_method_id)
);

create unique index if not exists warehouse_logistics_methods_one_default
on public.warehouse_logistics_methods (warehouse_id)
where is_default;

grant select, insert, update, delete
on table public.logistics_methods
to authenticated;

grant select, insert, update, delete
on table public.warehouse_logistics_methods
to authenticated;

drop trigger if exists logistics_methods_set_updated_at on public.logistics_methods;
create trigger logistics_methods_set_updated_at
before update on public.logistics_methods
for each row execute function public.set_updated_at();

drop trigger if exists warehouse_logistics_methods_set_updated_at on public.warehouse_logistics_methods;
create trigger warehouse_logistics_methods_set_updated_at
before update on public.warehouse_logistics_methods
for each row execute function public.set_updated_at();

alter table public.logistics_methods enable row level security;
alter table public.warehouse_logistics_methods enable row level security;

drop policy if exists "logistics_methods_select_authenticated" on public.logistics_methods;
create policy "logistics_methods_select_authenticated"
on public.logistics_methods for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "logistics_methods_insert_editor" on public.logistics_methods;
create policy "logistics_methods_insert_editor"
on public.logistics_methods for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "logistics_methods_update_editor" on public.logistics_methods;
create policy "logistics_methods_update_editor"
on public.logistics_methods for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "logistics_methods_delete_admin" on public.logistics_methods;
create policy "logistics_methods_delete_admin"
on public.logistics_methods for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_logistics_methods_select_authenticated" on public.warehouse_logistics_methods;
create policy "warehouse_logistics_methods_select_authenticated"
on public.warehouse_logistics_methods for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_logistics_methods_insert_editor" on public.warehouse_logistics_methods;
create policy "warehouse_logistics_methods_insert_editor"
on public.warehouse_logistics_methods for insert to authenticated
with check (
  public.current_account_can_edit()
  and exists (
    select 1 from public.warehouses
    where warehouses.id = warehouse_logistics_methods.warehouse_id
  )
  and exists (
    select 1 from public.logistics_methods
    where logistics_methods.id = warehouse_logistics_methods.logistics_method_id
      and logistics_methods.is_active
  )
);

drop policy if exists "warehouse_logistics_methods_update_editor" on public.warehouse_logistics_methods;
create policy "warehouse_logistics_methods_update_editor"
on public.warehouse_logistics_methods for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouse_logistics_methods_delete_editor" on public.warehouse_logistics_methods;
create policy "warehouse_logistics_methods_delete_editor"
on public.warehouse_logistics_methods for delete to authenticated
using (public.current_account_can_edit());

with seed_owner(owner_id) as (
  select warehouses.owner_id
  from public.warehouses
  order by warehouses.created_at
  limit 1
),
seed_methods(name, sort_order) as (
  values
    ('OCS 3cm', 10),
    ('OCS 小包', 20),
    ('福冈尾程', 30),
    ('大阪尾程', 40)
)
insert into public.logistics_methods (owner_id, name, sort_order)
select seed_owner.owner_id, seed_methods.name, seed_methods.sort_order
from seed_methods
cross join seed_owner
where not exists (
  select 1
  from public.logistics_methods
  where lower(btrim(logistics_methods.name)) = lower(seed_methods.name)
);

with seed_links(warehouse_name_includes, method_name, sort_order, is_default) as (
  values
    ('苏州', 'OCS 3cm', 10, true),
    ('苏州', 'OCS 小包', 20, false),
    ('福冈', '福冈尾程', 10, true),
    ('福岡', '福冈尾程', 10, true),
    ('大阪', '大阪尾程', 10, true)
),
matched_links as (
  select
    warehouses.id as warehouse_id,
    logistics_methods.id as logistics_method_id,
    warehouses.owner_id,
    seed_links.sort_order,
    seed_links.is_default,
    row_number() over (
      partition by warehouses.id, logistics_methods.id
      order by seed_links.sort_order
    ) as method_match_rank,
    row_number() over (
      partition by warehouses.id
      order by case when seed_links.is_default then 0 else 1 end, seed_links.sort_order
    ) as warehouse_default_rank
  from public.warehouses
  join seed_links
    on warehouses.name like ('%' || seed_links.warehouse_name_includes || '%')
  join public.logistics_methods
    on lower(btrim(logistics_methods.name)) = lower(seed_links.method_name)
)
insert into public.warehouse_logistics_methods (
  warehouse_id,
  logistics_method_id,
  owner_id,
  sort_order,
  is_default
)
select
  matched_links.warehouse_id,
  matched_links.logistics_method_id,
  matched_links.owner_id,
  matched_links.sort_order,
  case
    when matched_links.is_default
      and matched_links.warehouse_default_rank = 1
      and not exists (
        select 1
        from public.warehouse_logistics_methods existing
        where existing.warehouse_id = matched_links.warehouse_id
          and existing.is_default
      )
    then true
    else false
  end
from matched_links
where matched_links.method_match_rank = 1
on conflict (warehouse_id, logistics_method_id) do nothing;
