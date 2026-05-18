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

insert into public.warehouse_item_stocks (
  warehouse_id,
  item_id,
  owner_id
)
select distinct
  warehouse_skus.warehouse_id,
  product_items.id,
  warehouse_skus.owner_id
from public.warehouse_skus
join public.product_items
  on product_items.product_id = warehouse_skus.product_id
on conflict (warehouse_id, item_id) do nothing;

grant select, insert, update, delete
on table public.warehouse_item_stocks
to authenticated;

drop trigger if exists warehouse_item_stocks_set_updated_at on public.warehouse_item_stocks;
create trigger warehouse_item_stocks_set_updated_at
before update on public.warehouse_item_stocks
for each row execute function public.set_updated_at();

alter table public.warehouse_item_stocks enable row level security;

drop policy if exists "warehouse_item_stocks_select_own" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_select_own"
on public.warehouse_item_stocks for select
using (auth.uid() = owner_id);

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
