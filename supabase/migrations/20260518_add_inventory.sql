create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  shipping_method text not null default '顺丰',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

grant select, insert, update, delete
on table public.warehouses
to authenticated;

grant select, insert, update, delete
on table public.warehouse_skus
to authenticated;

drop trigger if exists warehouses_set_updated_at on public.warehouses;
create trigger warehouses_set_updated_at
before update on public.warehouses
for each row execute function public.set_updated_at();

drop trigger if exists warehouse_skus_set_updated_at on public.warehouse_skus;
create trigger warehouse_skus_set_updated_at
before update on public.warehouse_skus
for each row execute function public.set_updated_at();

alter table public.warehouses enable row level security;
alter table public.warehouse_skus enable row level security;

drop policy if exists "warehouses_select_own" on public.warehouses;
create policy "warehouses_select_own"
on public.warehouses for select
using (auth.uid() = owner_id);

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
create policy "warehouse_skus_select_own"
on public.warehouse_skus for select
using (auth.uid() = owner_id);

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
