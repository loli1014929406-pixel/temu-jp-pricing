create table if not exists public.account_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  username text not null default '',
  user_code text not null unique check (user_code ~ '^[A-Za-z0-9]{5}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists account_profiles_set_updated_at on public.account_profiles;
create trigger account_profiles_set_updated_at
before update on public.account_profiles
for each row execute function public.set_updated_at();

alter table public.account_profiles enable row level security;

drop policy if exists "account_profiles_select_authenticated" on public.account_profiles;
create policy "account_profiles_select_authenticated"
on public.account_profiles for select
to authenticated
using (true);

drop policy if exists "account_profiles_insert_self" on public.account_profiles;
create policy "account_profiles_insert_self"
on public.account_profiles for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "account_profiles_update_self" on public.account_profiles;
create policy "account_profiles_update_self"
on public.account_profiles for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

grant select, insert, update on public.account_profiles to authenticated;

create table if not exists public.product_warehouse_shipping_limits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  max_units_per_parcel integer not null default 1 check (max_units_per_parcel >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, warehouse_id)
);

drop trigger if exists product_warehouse_shipping_limits_set_updated_at on public.product_warehouse_shipping_limits;
create trigger product_warehouse_shipping_limits_set_updated_at
before update on public.product_warehouse_shipping_limits
for each row execute function public.set_updated_at();

alter table public.product_warehouse_shipping_limits enable row level security;

drop policy if exists "product_warehouse_shipping_limits_select_authenticated" on public.product_warehouse_shipping_limits;
create policy "product_warehouse_shipping_limits_select_authenticated"
on public.product_warehouse_shipping_limits for select
to authenticated
using (true);

drop policy if exists "product_warehouse_shipping_limits_insert_editors" on public.product_warehouse_shipping_limits;
create policy "product_warehouse_shipping_limits_insert_editors"
on public.product_warehouse_shipping_limits for insert
to authenticated
with check (
  owner_id = auth.uid()
  and public.current_account_can_edit()
);

drop policy if exists "product_warehouse_shipping_limits_update_editors" on public.product_warehouse_shipping_limits;
create policy "product_warehouse_shipping_limits_update_editors"
on public.product_warehouse_shipping_limits for update
to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "product_warehouse_shipping_limits_delete_editors" on public.product_warehouse_shipping_limits;
create policy "product_warehouse_shipping_limits_delete_editors"
on public.product_warehouse_shipping_limits for delete
to authenticated
using (public.current_account_can_edit());

grant select, insert, update, delete on public.product_warehouse_shipping_limits to authenticated;
