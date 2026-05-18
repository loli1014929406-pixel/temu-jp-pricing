alter table public.purchase_orders
drop column if exists alibaba_order_no,
drop column if exists freight_rmb;

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

alter table public.purchase_order_items
add column if not exists source_id uuid references public.purchase_order_sources(id) on delete cascade;

alter table public.purchase_packages
add column if not exists source_id uuid references public.purchase_order_sources(id) on delete cascade;

grant select, insert, update, delete on table public.purchase_order_sources to authenticated;

drop trigger if exists purchase_order_sources_set_updated_at on public.purchase_order_sources;
create trigger purchase_order_sources_set_updated_at
before update on public.purchase_order_sources
for each row execute function public.set_updated_at();

alter table public.purchase_order_sources enable row level security;

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
    select 1 from public.purchase_orders
    where purchase_orders.id = purchase_order_sources.order_id
      and purchase_orders.owner_id = auth.uid()
  )
);

drop policy if exists "purchase_order_sources_update_own" on public.purchase_order_sources;
create policy "purchase_order_sources_update_own"
on public.purchase_order_sources for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);
