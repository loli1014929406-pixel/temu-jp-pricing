drop table if exists public.purchase_records cascade;

alter table public.warehouse_item_stock_adjustments
add column if not exists purchase_order_id uuid,
add column if not exists purchase_package_id uuid;

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  warehouse_name text not null,
  alibaba_order_no text not null unique,
  purchased_at date not null default current_date,
  freight_rmb numeric not null default 0 check (freight_rmb >= 0),
  items_total_rmb numeric not null default 0 check (items_total_rmb >= 0),
  total_cost_rmb numeric not null default 0 check (total_cost_rmb >= 0),
  notes text not null default '',
  status text not null default 'pending' check (status in ('pending', 'partially_received', 'received')),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  item_id uuid references public.product_items(id) on delete set null,
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

grant select, insert, update, delete on table public.purchase_orders to authenticated;
grant select, insert, update, delete on table public.purchase_order_items to authenticated;
grant select, insert, update, delete on table public.purchase_packages to authenticated;
grant select, insert, update, delete on table public.purchase_package_items to authenticated;

drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at
before update on public.purchase_orders
for each row execute function public.set_updated_at();

drop trigger if exists purchase_packages_set_updated_at on public.purchase_packages;
create trigger purchase_packages_set_updated_at
before update on public.purchase_packages
for each row execute function public.set_updated_at();

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_packages enable row level security;
alter table public.purchase_package_items enable row level security;

drop policy if exists "purchase_orders_select_own" on public.purchase_orders;
create policy "purchase_orders_select_own" on public.purchase_orders for select using (auth.uid() = owner_id);
drop policy if exists "purchase_orders_insert_own" on public.purchase_orders;
create policy "purchase_orders_insert_own" on public.purchase_orders for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1 from public.warehouses
    where warehouses.id = purchase_orders.warehouse_id
      and warehouses.owner_id = auth.uid()
  )
);
drop policy if exists "purchase_orders_update_own" on public.purchase_orders;
create policy "purchase_orders_update_own" on public.purchase_orders for update
using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "purchase_orders_delete_own" on public.purchase_orders;
create policy "purchase_orders_delete_own" on public.purchase_orders for delete using (auth.uid() = owner_id);

drop policy if exists "purchase_order_items_select_own" on public.purchase_order_items;
create policy "purchase_order_items_select_own" on public.purchase_order_items for select using (auth.uid() = owner_id);
drop policy if exists "purchase_order_items_insert_own" on public.purchase_order_items;
create policy "purchase_order_items_insert_own" on public.purchase_order_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1 from public.purchase_orders
    where purchase_orders.id = purchase_order_items.order_id
      and purchase_orders.owner_id = auth.uid()
  )
);
drop policy if exists "purchase_order_items_delete_own" on public.purchase_order_items;
create policy "purchase_order_items_delete_own" on public.purchase_order_items for delete using (auth.uid() = owner_id);

drop policy if exists "purchase_packages_select_own" on public.purchase_packages;
create policy "purchase_packages_select_own" on public.purchase_packages for select using (auth.uid() = owner_id);
drop policy if exists "purchase_packages_insert_own" on public.purchase_packages;
create policy "purchase_packages_insert_own" on public.purchase_packages for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1 from public.purchase_orders
    where purchase_orders.id = purchase_packages.order_id
      and purchase_orders.owner_id = auth.uid()
  )
);
drop policy if exists "purchase_packages_update_own" on public.purchase_packages;
create policy "purchase_packages_update_own" on public.purchase_packages for update
using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "purchase_package_items_select_own" on public.purchase_package_items;
create policy "purchase_package_items_select_own" on public.purchase_package_items for select using (auth.uid() = owner_id);
drop policy if exists "purchase_package_items_insert_own" on public.purchase_package_items;
create policy "purchase_package_items_insert_own" on public.purchase_package_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_packages
    join public.purchase_orders on purchase_orders.id = purchase_packages.order_id
    join public.purchase_order_items on purchase_order_items.id = purchase_package_items.order_item_id
    where purchase_packages.id = purchase_package_items.package_id
      and purchase_packages.owner_id = auth.uid()
      and purchase_orders.owner_id = auth.uid()
      and purchase_order_items.owner_id = auth.uid()
      and purchase_order_items.order_id = purchase_orders.id
  )
);
