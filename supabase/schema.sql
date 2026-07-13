create extension if not exists "pgcrypto";

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_code text not null,
  product_name_cn text not null,
  product_name_en text not null default '',
  material_en text not null default '',
  material_cn text not null default '',
  combo_name text not null,
  combo_description text not null,
  title_jp text not null,
  package_length_cm numeric not null default 0,
  package_width_cm numeric not null default 0,
  package_height_cm numeric not null default 0,
  package_weight_g numeric not null default 0,
  max_units_per_parcel integer not null default 1 check (max_units_per_parcel >= 1),
  is_selling boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_skus (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sku_code text not null,
  temu_image_url text not null default '',
  attributes jsonb not null default '{}'::jsonb,
  notes text not null default '',
  created_at timestamptz not null default now()
);

grant select, insert, update, delete
on table public.product_skus
to authenticated;

create table if not exists public.product_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_name text not null,
  item_spec text not null default '',
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

create table if not exists public.product_sku_items (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.product_skus(id) on delete cascade,
  item_id uuid not null references public.product_items(id) on delete cascade,
  quantity integer not null default 1,
  unique (sku_id, item_id)
);

grant select, insert, update, delete
on table public.product_sku_items
to authenticated;

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
  test_ocs_3cm_first_price_rmb numeric not null default 16.5,
  test_ocs_3cm_extra_price_per_100g_rmb numeric not null default 1.5,
  test_ocs_small_parcel_first_price_rmb numeric not null default 36.5,
  test_ocs_small_parcel_extra_price_per_500g_rmb numeric not null default 6,
  target_profit_rate numeric not null default 0.3,
  target_post_ad_profit_rate numeric not null default 0.25,
  first_leg_methods jsonb,
  last_leg_methods jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.pricing_results (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  sku_id uuid not null references public.product_skus(id) on delete cascade,
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

create table if not exists public.profit_calculations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  sku_id uuid not null unique references public.product_skus(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  temu_price_rmb numeric not null default 0,
  traffic_discount_rate numeric not null default 1,
  activity_discount_rate numeric not null default 1,
  coupon_discount_rate numeric not null default 10,
  result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists public.warehouse_skus (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  sku_id uuid not null references public.product_skus(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (warehouse_id, sku_id)
);

create table if not exists public.warehouse_item_stocks (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  item_id uuid not null references public.product_items(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (warehouse_id, item_id)
);

create table if not exists public.warehouse_item_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  item_id uuid not null references public.product_items(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  previous_quantity integer not null check (previous_quantity >= 0),
  next_quantity integer not null check (next_quantity >= 0),
  change_quantity integer not null,
  reason text not null,
  purchase_order_id uuid,
  purchase_package_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  order_code text not null default ('PO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))) unique,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  warehouse_name text not null,
  purchased_at date not null default current_date,
  items_total_rmb numeric not null default 0 check (items_total_rmb >= 0),
  total_cost_rmb numeric not null default 0 check (total_cost_rmb >= 0),
  notes text not null default '',
  status text not null default 'pending' check (status in ('pending', 'partially_received', 'received')),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchase_order_sources (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  purchase_url text not null,
  alibaba_order_no text not null,
  freight_rmb numeric not null default 0 check (freight_rmb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, purchase_url)
);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  item_id uuid references public.product_items(id) on delete set null,
  sku_id uuid references public.product_skus(id) on delete set null,
  sku_quantity integer check (sku_quantity is null or sku_quantity > 0),
  source_id uuid not null references public.purchase_order_sources(id) on delete cascade,
  product_code text not null,
  product_name_cn text not null,
  item_name text not null,
  item_spec text not null default '',
  purchase_url text not null default '',
  quantity integer not null check (quantity > 0),
  unit_price_rmb numeric not null default 0 check (unit_price_rmb >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_packages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source_id uuid not null references public.purchase_order_sources(id) on delete cascade,
  tracking_no text not null,
  status text not null default 'pending' check (status in ('pending', 'received')),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchase_package_items (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.purchase_packages(id) on delete cascade,
  order_item_id uuid not null references public.purchase_order_items(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

grant select, insert, update, delete
on table public.profit_calculations
to authenticated;

grant select, insert, update, delete
on table public.warehouses
to authenticated;

grant select, insert, update, delete
on table public.logistics_methods
to authenticated;

grant select, insert, update, delete
on table public.warehouse_logistics_methods
to authenticated;

grant select, insert, update, delete
on table public.warehouse_skus
to authenticated;

grant select, insert, update, delete
on table public.warehouse_item_stocks
to authenticated;

grant select, insert, delete
on table public.warehouse_item_stock_adjustments
to authenticated;

grant select, insert, update, delete
on table public.purchase_orders
to authenticated;

grant select, insert, update, delete
on table public.purchase_order_sources
to authenticated;

grant select, insert, update, delete
on table public.purchase_order_items
to authenticated;

grant select, insert, update, delete
on table public.purchase_packages
to authenticated;

grant select, insert, update, delete
on table public.purchase_package_items
to authenticated;

alter table public.products
alter column owner_id set default auth.uid();

alter table public.product_items
alter column owner_id set default auth.uid();

alter table public.product_items
add column if not exists item_spec text not null default '';

alter table public.product_skus
add column if not exists attributes jsonb not null default '{}'::jsonb;

alter table public.product_skus
drop column if exists color;

alter table public.product_skus
drop column if exists size;

alter table public.product_skus
alter column owner_id set default auth.uid();

alter table public.pricing_settings
alter column owner_id set default auth.uid();

alter table public.pricing_settings
add column if not exists target_post_ad_profit_rate numeric not null default 0.25;

alter table public.pricing_settings
add column if not exists test_ocs_3cm_first_price_rmb numeric not null default 16.5;

alter table public.pricing_settings
add column if not exists test_ocs_3cm_extra_price_per_100g_rmb numeric not null default 1.5;

alter table public.pricing_settings
add column if not exists test_ocs_small_parcel_first_price_rmb numeric not null default 36.5;

alter table public.pricing_settings
add column if not exists test_ocs_small_parcel_extra_price_per_500g_rmb numeric not null default 6;

alter table public.pricing_settings
add column if not exists first_leg_methods jsonb;

alter table public.pricing_settings
add column if not exists last_leg_methods jsonb;

alter table public.pricing_results
alter column owner_id set default auth.uid();

alter table public.pricing_results
add column if not exists sku_id uuid references public.product_skus(id) on delete cascade;

alter table public.profit_calculations
alter column owner_id set default auth.uid();

alter table public.profit_calculations
add column if not exists coupon_discount_rate numeric not null default 10;

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

drop trigger if exists profit_calculations_set_updated_at on public.profit_calculations;
create trigger profit_calculations_set_updated_at
before update on public.profit_calculations
for each row execute function public.set_updated_at();

drop trigger if exists warehouses_set_updated_at on public.warehouses;
create trigger warehouses_set_updated_at
before update on public.warehouses
for each row execute function public.set_updated_at();

drop trigger if exists logistics_methods_set_updated_at on public.logistics_methods;
create trigger logistics_methods_set_updated_at
before update on public.logistics_methods
for each row execute function public.set_updated_at();

drop trigger if exists warehouse_logistics_methods_set_updated_at on public.warehouse_logistics_methods;
create trigger warehouse_logistics_methods_set_updated_at
before update on public.warehouse_logistics_methods
for each row execute function public.set_updated_at();

drop trigger if exists warehouse_skus_set_updated_at on public.warehouse_skus;
create trigger warehouse_skus_set_updated_at
before update on public.warehouse_skus
for each row execute function public.set_updated_at();

drop trigger if exists warehouse_item_stocks_set_updated_at on public.warehouse_item_stocks;
create trigger warehouse_item_stocks_set_updated_at
before update on public.warehouse_item_stocks
for each row execute function public.set_updated_at();

drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at
before update on public.purchase_orders
for each row execute function public.set_updated_at();

drop trigger if exists purchase_packages_set_updated_at on public.purchase_packages;
create trigger purchase_packages_set_updated_at
before update on public.purchase_packages
for each row execute function public.set_updated_at();

drop trigger if exists purchase_order_sources_set_updated_at on public.purchase_order_sources;
create trigger purchase_order_sources_set_updated_at
before update on public.purchase_order_sources
for each row execute function public.set_updated_at();

alter table public.products enable row level security;
alter table public.product_items enable row level security;
alter table public.product_skus enable row level security;
alter table public.product_sku_items enable row level security;
alter table public.pricing_settings enable row level security;
alter table public.pricing_results enable row level security;
alter table public.profit_calculations enable row level security;
alter table public.warehouses enable row level security;
alter table public.logistics_methods enable row level security;
alter table public.warehouse_logistics_methods enable row level security;
alter table public.warehouse_skus enable row level security;
alter table public.warehouse_item_stocks enable row level security;
alter table public.warehouse_item_stock_adjustments enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_sources enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_packages enable row level security;
alter table public.purchase_package_items enable row level security;

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

drop policy if exists "product_skus_select_own" on public.product_skus;
create policy "product_skus_select_own"
on public.product_skus for select
using (auth.uid() = owner_id);

drop policy if exists "product_skus_insert_own" on public.product_skus;
create policy "product_skus_insert_own"
on public.product_skus for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.products
    where products.id = product_skus.product_id
      and products.owner_id = auth.uid()
  )
);

drop policy if exists "product_skus_update_own" on public.product_skus;
create policy "product_skus_update_own"
on public.product_skus for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "product_skus_delete_own" on public.product_skus;
create policy "product_skus_delete_own"
on public.product_skus for delete
using (auth.uid() = owner_id);

drop policy if exists "product_sku_items_select_own" on public.product_sku_items;
create policy "product_sku_items_select_own"
on public.product_sku_items for select
using (
  exists (
    select 1
    from public.product_skus
    where product_skus.id = product_sku_items.sku_id
      and product_skus.owner_id = auth.uid()
  )
);

drop policy if exists "product_sku_items_insert_own" on public.product_sku_items;
create policy "product_sku_items_insert_own"
on public.product_sku_items for insert
with check (
  exists (
    select 1
    from public.product_skus
    join public.product_items
      on product_items.id = product_sku_items.item_id
    where product_skus.id = product_sku_items.sku_id
      and product_skus.owner_id = auth.uid()
      and product_items.owner_id = auth.uid()
      and product_items.product_id = product_skus.product_id
  )
);

drop policy if exists "product_sku_items_update_own" on public.product_sku_items;
create policy "product_sku_items_update_own"
on public.product_sku_items for update
using (
  exists (
    select 1
    from public.product_skus
    where product_skus.id = product_sku_items.sku_id
      and product_skus.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.product_skus
    join public.product_items
      on product_items.id = product_sku_items.item_id
    where product_skus.id = product_sku_items.sku_id
      and product_skus.owner_id = auth.uid()
      and product_items.owner_id = auth.uid()
      and product_items.product_id = product_skus.product_id
  )
);

drop policy if exists "product_sku_items_delete_own" on public.product_sku_items;
create policy "product_sku_items_delete_own"
on public.product_sku_items for delete
using (
  exists (
    select 1
    from public.product_skus
    where product_skus.id = product_sku_items.sku_id
      and product_skus.owner_id = auth.uid()
  )
);

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
    from public.product_skus
    where product_skus.id = pricing_results.sku_id
      and product_skus.product_id = pricing_results.product_id
      and product_skus.owner_id = auth.uid()
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

drop policy if exists "profit_calculations_select_own" on public.profit_calculations;
create policy "profit_calculations_select_own"
on public.profit_calculations for select
using (auth.uid() = owner_id);

drop policy if exists "profit_calculations_insert_own" on public.profit_calculations;
create policy "profit_calculations_insert_own"
on public.profit_calculations for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.product_skus
    where product_skus.id = profit_calculations.sku_id
      and product_skus.product_id = profit_calculations.product_id
      and product_skus.owner_id = auth.uid()
  )
);

drop policy if exists "profit_calculations_update_own" on public.profit_calculations;
create policy "profit_calculations_update_own"
on public.profit_calculations for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "profit_calculations_delete_own" on public.profit_calculations;
create policy "profit_calculations_delete_own"
on public.profit_calculations for delete
using (auth.uid() = owner_id);

drop policy if exists "warehouses_select_own" on public.warehouses;
drop policy if exists "warehouses_select_authenticated" on public.warehouses;
create policy "warehouses_select_authenticated"
on public.warehouses for select to authenticated
using (true);

drop policy if exists "warehouses_insert_own" on public.warehouses;
create policy "warehouses_insert_own"
on public.warehouses for insert
with check (auth.uid() = owner_id);

drop policy if exists "warehouses_update_own" on public.warehouses;
create policy "warehouses_update_own"
on public.warehouses for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "warehouses_delete_own" on public.warehouses;
create policy "warehouses_delete_own"
on public.warehouses for delete
using (auth.uid() = owner_id);

drop policy if exists "warehouse_skus_select_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_select_authenticated" on public.warehouse_skus;
create policy "warehouse_skus_select_authenticated"
on public.warehouse_skus for select to authenticated
using (true);

drop policy if exists "warehouse_skus_insert_own" on public.warehouse_skus;
create policy "warehouse_skus_insert_own"
on public.warehouse_skus for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.warehouses
    where warehouses.id = warehouse_skus.warehouse_id
      and warehouses.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.products
    where products.id = warehouse_skus.product_id
      and products.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.product_skus
    where product_skus.id = warehouse_skus.sku_id
      and product_skus.product_id = warehouse_skus.product_id
      and product_skus.owner_id = auth.uid()
  )
);

drop policy if exists "warehouse_skus_update_own" on public.warehouse_skus;
create policy "warehouse_skus_update_own"
on public.warehouse_skus for update
using (auth.uid() = owner_id)
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.warehouses
    where warehouses.id = warehouse_skus.warehouse_id
      and warehouses.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.products
    where products.id = warehouse_skus.product_id
      and products.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.product_skus
    where product_skus.id = warehouse_skus.sku_id
      and product_skus.product_id = warehouse_skus.product_id
      and product_skus.owner_id = auth.uid()
  )
);

drop policy if exists "warehouse_skus_delete_own" on public.warehouse_skus;
create policy "warehouse_skus_delete_own"
on public.warehouse_skus for delete
using (auth.uid() = owner_id);

drop policy if exists "warehouse_item_stocks_select_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_select_authenticated" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_select_authenticated"
on public.warehouse_item_stocks for select to authenticated
using (true);

drop policy if exists "warehouse_item_stocks_insert_own" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_insert_own"
on public.warehouse_item_stocks for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.warehouses
    where warehouses.id = warehouse_item_stocks.warehouse_id
      and warehouses.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.product_items
    where product_items.id = warehouse_item_stocks.item_id
      and product_items.owner_id = auth.uid()
  )
);

drop policy if exists "warehouse_item_stocks_update_own" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_update_own"
on public.warehouse_item_stocks for update
using (auth.uid() = owner_id)
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.warehouses
    where warehouses.id = warehouse_item_stocks.warehouse_id
      and warehouses.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.product_items
    where product_items.id = warehouse_item_stocks.item_id
      and product_items.owner_id = auth.uid()
  )
);

drop policy if exists "warehouse_item_stocks_delete_own" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_delete_own"
on public.warehouse_item_stocks for delete
using (auth.uid() = owner_id);

drop policy if exists "warehouse_item_stock_adjustments_select_own" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_select_authenticated" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_select_authenticated"
on public.warehouse_item_stock_adjustments for select to authenticated
using (true);

drop policy if exists "warehouse_item_stock_adjustments_insert_own" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_insert_own"
on public.warehouse_item_stock_adjustments for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.warehouses
    where warehouses.id = warehouse_item_stock_adjustments.warehouse_id
      and warehouses.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.product_items
    where product_items.id = warehouse_item_stock_adjustments.item_id
      and product_items.owner_id = auth.uid()
  )
);

drop policy if exists "warehouse_item_stock_adjustments_delete_own" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_delete_own"
on public.warehouse_item_stock_adjustments for delete
using (auth.uid() = owner_id);

drop policy if exists "purchase_orders_select_own" on public.purchase_orders;
create policy "purchase_orders_select_own"
on public.purchase_orders for select
using (auth.uid() = owner_id);

drop policy if exists "purchase_orders_insert_own" on public.purchase_orders;
create policy "purchase_orders_insert_own"
on public.purchase_orders for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.warehouses
    where warehouses.id = purchase_orders.warehouse_id
      and warehouses.owner_id = auth.uid()
  )
);

drop policy if exists "purchase_orders_update_own" on public.purchase_orders;
create policy "purchase_orders_update_own"
on public.purchase_orders for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "purchase_orders_delete_own" on public.purchase_orders;
create policy "purchase_orders_delete_own"
on public.purchase_orders for delete
using (auth.uid() = owner_id);

drop policy if exists "purchase_order_items_select_own" on public.purchase_order_items;
create policy "purchase_order_items_select_own"
on public.purchase_order_items for select
using (auth.uid() = owner_id);

drop policy if exists "purchase_order_sources_select_own" on public.purchase_order_sources;
create policy "purchase_order_sources_select_own"
on public.purchase_order_sources for select
using (auth.uid() = owner_id);

drop policy if exists "purchase_order_sources_insert_own" on public.purchase_order_sources;
create policy "purchase_order_sources_insert_own"
on public.purchase_order_sources for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_orders
    where purchase_orders.id = purchase_order_sources.order_id
      and purchase_orders.owner_id = auth.uid()
  )
);

drop policy if exists "purchase_order_sources_update_own" on public.purchase_order_sources;
create policy "purchase_order_sources_update_own"
on public.purchase_order_sources for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "purchase_order_items_insert_own" on public.purchase_order_items;
create policy "purchase_order_items_insert_own"
on public.purchase_order_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_orders
    where purchase_orders.id = purchase_order_items.order_id
      and purchase_orders.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.purchase_order_sources
    where purchase_order_sources.id = purchase_order_items.source_id
      and purchase_order_sources.order_id = purchase_order_items.order_id
      and purchase_order_sources.owner_id = auth.uid()
  )
);

drop policy if exists "purchase_order_items_update_own" on public.purchase_order_items;
create policy "purchase_order_items_update_own"
on public.purchase_order_items for update
using (auth.uid() = owner_id)
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_orders
    where purchase_orders.id = purchase_order_items.order_id
      and purchase_orders.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.purchase_order_sources
    where purchase_order_sources.id = purchase_order_items.source_id
      and purchase_order_sources.order_id = purchase_order_items.order_id
      and purchase_order_sources.owner_id = auth.uid()
  )
);

drop policy if exists "purchase_order_items_delete_own" on public.purchase_order_items;
create policy "purchase_order_items_delete_own"
on public.purchase_order_items for delete
using (auth.uid() = owner_id);

drop policy if exists "purchase_packages_select_own" on public.purchase_packages;
create policy "purchase_packages_select_own"
on public.purchase_packages for select
using (auth.uid() = owner_id);

drop policy if exists "purchase_packages_insert_own" on public.purchase_packages;
create policy "purchase_packages_insert_own"
on public.purchase_packages for insert
with check (auth.uid() = owner_id);

drop policy if exists "purchase_packages_update_own" on public.purchase_packages;
create policy "purchase_packages_update_own"
on public.purchase_packages for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "purchase_packages_delete_own" on public.purchase_packages;
create policy "purchase_packages_delete_own"
on public.purchase_packages for delete
using (auth.uid() = owner_id and status = 'pending');

drop policy if exists "purchase_package_items_select_own" on public.purchase_package_items;
create policy "purchase_package_items_select_own"
on public.purchase_package_items for select
using (auth.uid() = owner_id);

drop policy if exists "purchase_package_items_insert_own" on public.purchase_package_items;
create policy "purchase_package_items_insert_own"
on public.purchase_package_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_packages
    where purchase_packages.id = purchase_package_items.package_id
      and purchase_packages.owner_id = auth.uid()
  )
);

create table if not exists public.account_permissions (
  email text primary key,
  permission_level text not null
    check (permission_level in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select
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
  ''viewer''
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
drop policy if exists "account_permissions_select_self" on public.account_permissions;
create policy "account_permissions_select_self"
on public.account_permissions for select
using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

drop policy if exists "account_permissions_insert_admin" on public.account_permissions;
drop policy if exists "account_permissions_update_admin" on public.account_permissions;
drop policy if exists "account_permissions_delete_admin" on public.account_permissions;

revoke insert, update, delete
on table public.account_permissions
from authenticated;

drop trigger if exists products_enforce_account_edit on public.products;
drop trigger if exists product_items_enforce_account_edit on public.product_items;
drop trigger if exists product_skus_enforce_account_edit on public.product_skus;
drop trigger if exists product_sku_items_enforce_account_edit on public.product_sku_items;
drop trigger if exists pricing_settings_enforce_account_edit on public.pricing_settings;
drop trigger if exists pricing_results_enforce_account_edit on public.pricing_results;
drop trigger if exists profit_calculations_enforce_account_edit on public.profit_calculations;
drop trigger if exists warehouses_enforce_account_edit on public.warehouses;
drop trigger if exists warehouse_skus_enforce_account_edit on public.warehouse_skus;
drop trigger if exists warehouse_item_stocks_enforce_account_edit on public.warehouse_item_stocks;
drop trigger if exists warehouse_item_stock_adjustments_enforce_account_edit on public.warehouse_item_stock_adjustments;
drop trigger if exists purchase_orders_enforce_account_edit on public.purchase_orders;
drop trigger if exists purchase_order_sources_enforce_account_edit on public.purchase_order_sources;
drop trigger if exists purchase_order_items_enforce_account_edit on public.purchase_order_items;
drop trigger if exists purchase_packages_enforce_account_edit on public.purchase_packages;
drop trigger if exists purchase_package_items_enforce_account_edit on public.purchase_package_items;
drop trigger if exists products_enforce_account_delete on public.products;
drop trigger if exists warehouses_enforce_account_delete on public.warehouses;
drop trigger if exists purchase_orders_enforce_account_delete on public.purchase_orders;
drop trigger if exists purchase_packages_enforce_account_delete on public.purchase_packages;

drop function if exists public.enforce_account_edit_permission();
drop function if exists public.enforce_account_delete_permission();

drop policy if exists "products_account_insert_edit" on public.products;
create policy "products_account_insert_edit" on public.products
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "products_account_update_edit" on public.products;
create policy "products_account_update_edit" on public.products
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "products_account_delete_admin" on public.products;
create policy "products_account_delete_admin" on public.products
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "product_items_account_insert_edit" on public.product_items;
create policy "product_items_account_insert_edit" on public.product_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "product_items_account_update_edit" on public.product_items;
create policy "product_items_account_update_edit" on public.product_items
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "product_skus_account_insert_edit" on public.product_skus;
create policy "product_skus_account_insert_edit" on public.product_skus
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "product_skus_account_update_edit" on public.product_skus;
create policy "product_skus_account_update_edit" on public.product_skus
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "product_sku_items_account_insert_edit" on public.product_sku_items;
create policy "product_sku_items_account_insert_edit" on public.product_sku_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "product_sku_items_account_update_edit" on public.product_sku_items;
create policy "product_sku_items_account_update_edit" on public.product_sku_items
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "pricing_settings_account_insert_edit" on public.pricing_settings;
create policy "pricing_settings_account_insert_edit" on public.pricing_settings
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "pricing_settings_account_update_edit" on public.pricing_settings;
create policy "pricing_settings_account_update_edit" on public.pricing_settings
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "pricing_results_account_insert_edit" on public.pricing_results;
create policy "pricing_results_account_insert_edit" on public.pricing_results
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "pricing_results_account_update_edit" on public.pricing_results;
create policy "pricing_results_account_update_edit" on public.pricing_results
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "profit_calculations_account_insert_edit" on public.profit_calculations;
create policy "profit_calculations_account_insert_edit" on public.profit_calculations
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "profit_calculations_account_update_edit" on public.profit_calculations;
create policy "profit_calculations_account_update_edit" on public.profit_calculations
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouses_account_insert_edit" on public.warehouses;
create policy "warehouses_account_insert_edit" on public.warehouses
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "warehouses_account_update_edit" on public.warehouses;
create policy "warehouses_account_update_edit" on public.warehouses
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouses_account_delete_admin" on public.warehouses;
create policy "warehouses_account_delete_admin" on public.warehouses
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_skus_account_insert_edit" on public.warehouse_skus;
create policy "warehouse_skus_account_insert_edit" on public.warehouse_skus
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "warehouse_skus_account_update_edit" on public.warehouse_skus;
create policy "warehouse_skus_account_update_edit" on public.warehouse_skus
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouse_skus_account_delete_admin" on public.warehouse_skus;
create policy "warehouse_skus_account_delete_admin" on public.warehouse_skus
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stocks_account_insert_edit" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_account_insert_edit" on public.warehouse_item_stocks
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "warehouse_item_stocks_account_update_edit" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_account_update_edit" on public.warehouse_item_stocks
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouse_item_stocks_account_delete_admin" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_account_delete_admin" on public.warehouse_item_stocks
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stock_adjustments_account_insert_edit" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_account_insert_edit" on public.warehouse_item_stock_adjustments
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_orders_account_insert_edit" on public.purchase_orders;
create policy "purchase_orders_account_insert_edit" on public.purchase_orders
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_orders_account_update_edit" on public.purchase_orders;
create policy "purchase_orders_account_update_edit" on public.purchase_orders
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "purchase_orders_account_delete_admin" on public.purchase_orders;
create policy "purchase_orders_account_delete_admin" on public.purchase_orders
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "purchase_order_sources_account_insert_edit" on public.purchase_order_sources;
create policy "purchase_order_sources_account_insert_edit" on public.purchase_order_sources
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_order_sources_account_update_edit" on public.purchase_order_sources;
create policy "purchase_order_sources_account_update_edit" on public.purchase_order_sources
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "purchase_order_items_account_insert_edit" on public.purchase_order_items;
create policy "purchase_order_items_account_insert_edit" on public.purchase_order_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_order_items_account_update_edit" on public.purchase_order_items;
create policy "purchase_order_items_account_update_edit" on public.purchase_order_items
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "purchase_packages_account_insert_edit" on public.purchase_packages;
create policy "purchase_packages_account_insert_edit" on public.purchase_packages
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_packages_account_update_edit" on public.purchase_packages;
create policy "purchase_packages_account_update_edit" on public.purchase_packages
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "purchase_packages_account_delete_admin" on public.purchase_packages;
create policy "purchase_packages_account_delete_admin" on public.purchase_packages
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "purchase_package_items_account_insert_edit" on public.purchase_package_items;
create policy "purchase_package_items_account_insert_edit" on public.purchase_package_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

create table if not exists public.temu_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_no text not null,
  sub_order_no text not null default '',
  order_status text not null default '',
  sku_code text not null default '',
  warehouse_id uuid references public.warehouses(id) on delete set null,
  warehouse_name text not null default '',
  logistics_method text not null default '',
  label_printed_at text not null default '',
  logistics_tracking_no text not null default '',
  logistics_status text not null default '',
  fulfillment_quantity integer not null default 0 check (fulfillment_quantity >= 0),
  product_attributes text not null default '',
  recipient_name text not null default '',
  recipient_phone text not null default '',
  email text not null default '',
  province text not null default '',
  city text not null default '',
  district text not null default '',
  address_line1 text not null default '',
  address_line2 text not null default '',
  postal_code text not null default '',
  latest_ship_time text not null default '',
  actual_ship_time text not null default '',
  estimated_delivery_time text not null default '',
  actual_signed_time text not null default '',
  actual_shipping_fee_rmb numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, order_no, sub_order_no)
);

grant select, insert, update, delete
on table public.temu_orders
to authenticated;

drop trigger if exists temu_orders_set_updated_at on public.temu_orders;
create trigger temu_orders_set_updated_at
before update on public.temu_orders
for each row execute function public.set_updated_at();

alter table public.temu_orders enable row level security;

drop policy if exists "temu_orders_select_own" on public.temu_orders;
create policy "temu_orders_select_own"
on public.temu_orders for select
using (auth.uid() = owner_id);

drop policy if exists "temu_orders_insert_own" on public.temu_orders;
create policy "temu_orders_insert_own"
on public.temu_orders for insert
with check (auth.uid() = owner_id);

drop policy if exists "temu_orders_update_own" on public.temu_orders;
create policy "temu_orders_update_own"
on public.temu_orders for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "temu_orders_delete_own" on public.temu_orders;
create policy "temu_orders_delete_own"
on public.temu_orders for delete
using (auth.uid() = owner_id);

drop policy if exists "temu_orders_account_insert_edit" on public.temu_orders;
create policy "temu_orders_account_insert_edit" on public.temu_orders
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "temu_orders_account_update_edit" on public.temu_orders;
create policy "temu_orders_account_update_edit" on public.temu_orders
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "temu_orders_account_delete_admin" on public.temu_orders;
create policy "temu_orders_account_delete_admin" on public.temu_orders
as restrictive for delete to authenticated
using (public.current_account_can_delete());

create table if not exists public.finance_settlement_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  date_range_start text not null default '',
  date_range_end text not null default '',
  total_sales_revenue numeric(12,2) not null default 0,
  total_freight_revenue numeric(12,2) not null default 0,
  total_revenue numeric(12,2) not null default 0,
  record_count integer not null default 0,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finance_settlement_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_id uuid not null references public.finance_settlement_files(id) on delete cascade,
  po_number text not null,
  sku_id text not null default '',
  sku_name text not null default '',
  sku_code text not null default '',
  quantity integer not null default 0,
  declared_price numeric(12,2) not null default 0,
  is_promotion_price boolean not null default false,
  currency text not null default 'CNY',
  sales_revenue numeric(12,2) not null default 0,
  sales_discount_deducted numeric(12,2) not null default 0,
  sales_reversal numeric(12,2) not null default 0,
  freight_revenue numeric(12,2) not null default 0,
  freight_discount_deducted numeric(12,2) not null default 0,
  freight_reversal numeric(12,2) not null default 0,
  total_revenue numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete
on table public.finance_settlement_files
to authenticated;

grant select, insert, update, delete
on table public.finance_settlement_records
to authenticated;

drop trigger if exists finance_settlement_files_set_updated_at on public.finance_settlement_files;
create trigger finance_settlement_files_set_updated_at
before update on public.finance_settlement_files
for each row execute function public.set_updated_at();

drop trigger if exists finance_settlement_records_set_updated_at on public.finance_settlement_records;
create trigger finance_settlement_records_set_updated_at
before update on public.finance_settlement_records
for each row execute function public.set_updated_at();

alter table public.finance_settlement_files enable row level security;
alter table public.finance_settlement_records enable row level security;

drop policy if exists "finance_settlement_files_select_own" on public.finance_settlement_files;
create policy "finance_settlement_files_select_own"
on public.finance_settlement_files for select
using (auth.uid() = user_id);

drop policy if exists "finance_settlement_files_insert_own" on public.finance_settlement_files;
create policy "finance_settlement_files_insert_own"
on public.finance_settlement_files for insert
with check (auth.uid() = user_id);

drop policy if exists "finance_settlement_files_update_own" on public.finance_settlement_files;
create policy "finance_settlement_files_update_own"
on public.finance_settlement_files for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "finance_settlement_files_delete_own" on public.finance_settlement_files;
create policy "finance_settlement_files_delete_own"
on public.finance_settlement_files for delete
using (auth.uid() = user_id);

drop policy if exists "finance_settlement_records_select_own" on public.finance_settlement_records;
create policy "finance_settlement_records_select_own"
on public.finance_settlement_records for select
using (auth.uid() = user_id);

drop policy if exists "finance_settlement_records_insert_own" on public.finance_settlement_records;
create policy "finance_settlement_records_insert_own"
on public.finance_settlement_records for insert
with check (auth.uid() = user_id);

drop policy if exists "finance_settlement_records_update_own" on public.finance_settlement_records;
create policy "finance_settlement_records_update_own"
on public.finance_settlement_records for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "finance_settlement_records_delete_own" on public.finance_settlement_records;
create policy "finance_settlement_records_delete_own"
on public.finance_settlement_records for delete
using (auth.uid() = user_id);

create index if not exists idx_finance_settlement_files_user on public.finance_settlement_files(user_id);
create index if not exists idx_finance_settlement_records_file on public.finance_settlement_records(file_id);
create index if not exists idx_finance_settlement_records_po on public.finance_settlement_records(po_number);
create index if not exists idx_finance_settlement_records_sku on public.finance_settlement_records(sku_code);

create or replace function public.current_account_has_permission()
returns boolean
language sql
stable
security definer
set search_path = public
as 'select case
  when auth.uid() is null then false
  else exists (
    select 1
    from public.account_permissions
    where lower(account_permissions.email) =
      lower(coalesce(auth.jwt() ->> ''email'', ''''))
  )
end';

grant execute on function public.current_account_has_permission() to authenticated;

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated"
on public.products for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "product_items_select_authenticated" on public.product_items;
create policy "product_items_select_authenticated"
on public.product_items for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "product_skus_select_authenticated" on public.product_skus;
create policy "product_skus_select_authenticated"
on public.product_skus for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "product_sku_items_select_authenticated" on public.product_sku_items;
create policy "product_sku_items_select_authenticated"
on public.product_sku_items for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "pricing_results_select_authenticated" on public.pricing_results;
create policy "pricing_results_select_authenticated"
on public.pricing_results for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "profit_calculations_select_authenticated" on public.profit_calculations;
create policy "profit_calculations_select_authenticated"
on public.profit_calculations for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouses_select_authenticated" on public.warehouses;
create policy "warehouses_select_authenticated"
on public.warehouses for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "logistics_methods_select_authenticated" on public.logistics_methods;
create policy "logistics_methods_select_authenticated"
on public.logistics_methods for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_logistics_methods_select_authenticated" on public.warehouse_logistics_methods;
create policy "warehouse_logistics_methods_select_authenticated"
on public.warehouse_logistics_methods for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_skus_select_authenticated" on public.warehouse_skus;
create policy "warehouse_skus_select_authenticated"
on public.warehouse_skus for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_item_stocks_select_authenticated" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_select_authenticated"
on public.warehouse_item_stocks for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_item_stock_adjustments_select_authenticated" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_select_authenticated"
on public.warehouse_item_stock_adjustments for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouses_insert_own" on public.warehouses;
drop policy if exists "warehouses_update_own" on public.warehouses;
drop policy if exists "warehouses_delete_own" on public.warehouses;
drop policy if exists "warehouses_insert_editor" on public.warehouses;
drop policy if exists "warehouses_update_editor" on public.warehouses;
drop policy if exists "warehouses_delete_admin" on public.warehouses;
create policy "warehouses_insert_editor"
on public.warehouses for insert to authenticated
with check (public.current_account_can_edit());
create policy "warehouses_update_editor"
on public.warehouses for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "warehouses_delete_admin"
on public.warehouses for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "logistics_methods_insert_editor" on public.logistics_methods;
drop policy if exists "logistics_methods_update_editor" on public.logistics_methods;
drop policy if exists "logistics_methods_delete_admin" on public.logistics_methods;
create policy "logistics_methods_insert_editor"
on public.logistics_methods for insert to authenticated
with check (public.current_account_can_edit());
create policy "logistics_methods_update_editor"
on public.logistics_methods for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "logistics_methods_delete_admin"
on public.logistics_methods for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_logistics_methods_insert_editor" on public.warehouse_logistics_methods;
drop policy if exists "warehouse_logistics_methods_update_editor" on public.warehouse_logistics_methods;
drop policy if exists "warehouse_logistics_methods_delete_editor" on public.warehouse_logistics_methods;
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
create policy "warehouse_logistics_methods_update_editor"
on public.warehouse_logistics_methods for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "warehouse_logistics_methods_delete_editor"
on public.warehouse_logistics_methods for delete to authenticated
using (public.current_account_can_edit());

drop policy if exists "warehouse_skus_insert_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_update_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_delete_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_insert_editor" on public.warehouse_skus;
drop policy if exists "warehouse_skus_update_editor" on public.warehouse_skus;
drop policy if exists "warehouse_skus_delete_admin" on public.warehouse_skus;
create policy "warehouse_skus_insert_editor"
on public.warehouse_skus for insert to authenticated
with check (
  public.current_account_can_edit()
  and exists (
    select 1 from public.warehouses
    where warehouses.id = warehouse_skus.warehouse_id
  )
  and exists (
    select 1 from public.products
    where products.id = warehouse_skus.product_id
  )
  and exists (
    select 1 from public.product_skus
    where product_skus.id = warehouse_skus.sku_id
      and product_skus.product_id = warehouse_skus.product_id
  )
);
create policy "warehouse_skus_update_editor"
on public.warehouse_skus for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "warehouse_skus_delete_admin"
on public.warehouse_skus for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stocks_insert_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_update_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_delete_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_insert_editor" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_update_editor" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_delete_admin" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_insert_editor"
on public.warehouse_item_stocks for insert to authenticated
with check (
  public.current_account_can_edit()
  and exists (
    select 1 from public.warehouses
    where warehouses.id = warehouse_item_stocks.warehouse_id
  )
  and exists (
    select 1 from public.product_items
    where product_items.id = warehouse_item_stocks.item_id
  )
);
create policy "warehouse_item_stocks_update_editor"
on public.warehouse_item_stocks for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "warehouse_item_stocks_delete_admin"
on public.warehouse_item_stocks for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stock_adjustments_insert_own" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_delete_own" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_insert_editor" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_delete_admin" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_insert_editor"
on public.warehouse_item_stock_adjustments for insert to authenticated
with check (
  public.current_account_can_edit()
  and exists (
    select 1 from public.warehouses
    where warehouses.id = warehouse_item_stock_adjustments.warehouse_id
  )
  and exists (
    select 1 from public.product_items
    where product_items.id = warehouse_item_stock_adjustments.item_id
  )
);
create policy "warehouse_item_stock_adjustments_delete_admin"
on public.warehouse_item_stock_adjustments for delete to authenticated
using (public.current_account_can_delete());
