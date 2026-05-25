create table if not exists public.temu_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_no text not null,
  sub_order_no text not null default '',
  order_status text not null default '',
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
