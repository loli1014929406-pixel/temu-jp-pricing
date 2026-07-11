alter table public.pricing_settings
add column if not exists target_post_ad_profit_rate numeric not null default 0.25;

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

grant select, insert, update, delete
on table public.profit_calculations
to authenticated;

alter table public.profit_calculations
alter column owner_id set default auth.uid();

alter table public.profit_calculations
add column if not exists coupon_discount_rate numeric not null default 10;

drop trigger if exists profit_calculations_set_updated_at on public.profit_calculations;
create trigger profit_calculations_set_updated_at
before update on public.profit_calculations
for each row execute function public.set_updated_at();

alter table public.profit_calculations enable row level security;

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
