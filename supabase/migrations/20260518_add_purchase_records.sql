create table if not exists public.purchase_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  warehouse_id uuid references public.warehouses(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  item_id uuid references public.product_items(id) on delete set null,
  warehouse_name text not null,
  product_code text not null,
  product_name_cn text not null,
  item_name text not null,
  item_spec text not null default '',
  purchase_url text not null default '',
  quantity integer not null check (quantity > 0),
  unit_price_rmb numeric not null default 0 check (unit_price_rmb >= 0),
  purchased_at date not null default current_date,
  alibaba_order_no text not null default '',
  tracking_no text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete
on table public.purchase_records
to authenticated;

drop trigger if exists purchase_records_set_updated_at on public.purchase_records;
create trigger purchase_records_set_updated_at
before update on public.purchase_records
for each row execute function public.set_updated_at();

alter table public.purchase_records enable row level security;

drop policy if exists "purchase_records_select_own" on public.purchase_records;
create policy "purchase_records_select_own"
on public.purchase_records for select
using (auth.uid() = owner_id);

drop policy if exists "purchase_records_insert_own" on public.purchase_records;
create policy "purchase_records_insert_own"
on public.purchase_records for insert
with check (
  auth.uid() = owner_id
  and (
    warehouse_id is null
    or exists (
      select 1
      from public.warehouses
      where warehouses.id = purchase_records.warehouse_id
        and warehouses.owner_id = auth.uid()
    )
  )
  and (
    product_id is null
    or exists (
      select 1
      from public.products
      where products.id = purchase_records.product_id
        and products.owner_id = auth.uid()
    )
  )
  and (
    item_id is null
    or exists (
      select 1
      from public.product_items
      where product_items.id = purchase_records.item_id
        and product_items.owner_id = auth.uid()
    )
  )
);

drop policy if exists "purchase_records_update_own" on public.purchase_records;
create policy "purchase_records_update_own"
on public.purchase_records for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "purchase_records_delete_own" on public.purchase_records;
create policy "purchase_records_delete_own"
on public.purchase_records for delete
using (auth.uid() = owner_id);
