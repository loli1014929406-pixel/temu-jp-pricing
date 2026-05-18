create table if not exists public.warehouse_item_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  item_id uuid not null references public.product_items(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  previous_quantity integer not null check (previous_quantity >= 0),
  next_quantity integer not null check (next_quantity >= 0),
  change_quantity integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

grant select, insert, delete
on table public.warehouse_item_stock_adjustments
to authenticated;

alter table public.warehouse_item_stock_adjustments enable row level security;

drop policy if exists "warehouse_item_stock_adjustments_select_own" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_select_own"
on public.warehouse_item_stock_adjustments for select
using (auth.uid() = owner_id);

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
