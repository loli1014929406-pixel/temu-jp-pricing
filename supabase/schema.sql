create extension if not exists "pgcrypto";

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_code text not null,
  product_name_cn text not null,
  combo_name text not null,
  combo_description text not null,
  title_jp text not null,
  package_length_cm numeric not null default 0,
  package_width_cm numeric not null default 0,
  package_height_cm numeric not null default 0,
  package_weight_g numeric not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_name text not null,
  quantity integer not null default 1,
  item_length_cm numeric not null default 0,
  item_width_cm numeric not null default 0,
  item_height_cm numeric not null default 0,
  item_weight_g numeric not null default 0,
  purchase_price_rmb numeric not null default 0,
  purchase_shipping_fee_per_500g_rmb numeric not null default 0,
  purchase_url text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.pricing_settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  packaging_cost_rmb numeric not null default 0.2,
  exchange_rate_rmb_per_jpy numeric not null default 0.0425,
  temu_shipping_subsidy_jpy numeric not null default 410,
  sf_first_weight_kg numeric not null default 1,
  sf_first_price_rmb numeric not null default 8,
  sf_extra_price_per_kg_rmb numeric not null default 2,
  huaian_air_price_per_kg_rmb numeric not null default 25,
  ocs_price_per_kg_rmb numeric not null default 20,
  ocs_tariff_rate numeric not null default 0,
  osaka_lastmile_jpy numeric not null default 260,
  fukuoka_lastmile_jpy numeric not null default 220,
  target_profit_rate numeric not null default 0.3,
  updated_at timestamptz not null default now()
);

create table if not exists public.pricing_results (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  purchase_cost_rmb numeric not null default 0,
  purchase_shipping_cost_rmb numeric not null default 0,
  packaging_cost_rmb numeric not null default 0,
  sf_allocated_cost_rmb numeric not null default 0,
  plan_a_cost_rmb numeric not null default 0,
  plan_b_cost_rmb numeric not null default 0,
  plan_c_cost_rmb numeric not null default 0,
  plan_d_cost_rmb numeric not null default 0,
  selected_logistics_cost_rmb numeric not null default 0,
  total_cost_rmb numeric not null default 0,
  shipping_subsidy_rmb numeric not null default 0,
  minimum_temu_price_rmb numeric not null default 0,
  estimated_profit_rmb numeric not null default 0,
  estimated_profit_rate numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products
alter column owner_id set default auth.uid();

alter table public.product_items
alter column owner_id set default auth.uid();

alter table public.pricing_settings
alter column owner_id set default auth.uid();

alter table public.pricing_results
alter column owner_id set default auth.uid();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
before update on public.products
for each row execute function public.set_updated_at();

drop trigger if exists pricing_settings_set_updated_at on public.pricing_settings;
create trigger pricing_settings_set_updated_at
before update on public.pricing_settings
for each row execute function public.set_updated_at();

drop trigger if exists pricing_results_set_updated_at on public.pricing_results;
create trigger pricing_results_set_updated_at
before update on public.pricing_results
for each row execute function public.set_updated_at();

alter table public.products enable row level security;
alter table public.product_items enable row level security;
alter table public.pricing_settings enable row level security;
alter table public.pricing_results enable row level security;

drop policy if exists "products_select_own" on public.products;
create policy "products_select_own"
on public.products for select
using (auth.uid() = owner_id);

drop policy if exists "products_insert_own" on public.products;
create policy "products_insert_own"
on public.products for insert
with check (auth.uid() = owner_id);

drop policy if exists "products_update_own" on public.products;
create policy "products_update_own"
on public.products for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "products_delete_own" on public.products;
create policy "products_delete_own"
on public.products for delete
using (auth.uid() = owner_id);

drop policy if exists "product_items_select_own" on public.product_items;
create policy "product_items_select_own"
on public.product_items for select
using (auth.uid() = owner_id);

drop policy if exists "product_items_insert_own" on public.product_items;
create policy "product_items_insert_own"
on public.product_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.products
    where products.id = product_items.product_id
      and products.owner_id = auth.uid()
  )
);

drop policy if exists "product_items_update_own" on public.product_items;
create policy "product_items_update_own"
on public.product_items for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "product_items_delete_own" on public.product_items;
create policy "product_items_delete_own"
on public.product_items for delete
using (auth.uid() = owner_id);

drop policy if exists "pricing_settings_select_own" on public.pricing_settings;
create policy "pricing_settings_select_own"
on public.pricing_settings for select
using (auth.uid() = owner_id);

drop policy if exists "pricing_settings_insert_own" on public.pricing_settings;
create policy "pricing_settings_insert_own"
on public.pricing_settings for insert
with check (auth.uid() = owner_id);

drop policy if exists "pricing_settings_update_own" on public.pricing_settings;
create policy "pricing_settings_update_own"
on public.pricing_settings for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "pricing_results_select_own" on public.pricing_results;
create policy "pricing_results_select_own"
on public.pricing_results for select
using (auth.uid() = owner_id);

drop policy if exists "pricing_results_insert_own" on public.pricing_results;
create policy "pricing_results_insert_own"
on public.pricing_results for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.products
    where products.id = pricing_results.product_id
      and products.owner_id = auth.uid()
  )
);

drop policy if exists "pricing_results_update_own" on public.pricing_results;
create policy "pricing_results_update_own"
on public.pricing_results for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "pricing_results_delete_own" on public.pricing_results;
create policy "pricing_results_delete_own"
on public.pricing_results for delete
using (auth.uid() = owner_id);
