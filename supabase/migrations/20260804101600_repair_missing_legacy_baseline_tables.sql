-- The checked-in bootstrap schema predates these five production tables.
-- Recreate them only when absent so a clean shadow database can faithfully
-- replay the full migration chain. Existing production relations are untouched.

create table if not exists public.product_strategy_states (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  stage text not null default '未开始',
  elapsed_hours numeric not null default 0,
  price_p numeric not null default 0,
  cost_c numeric not null default 0,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  add_to_cart numeric not null default 0,
  favorites numeric not null default 0,
  orders numeric not null default 0,
  ad_spend numeric not null default 0,
  ad_sales numeric not null default 0,
  ad_orders numeric not null default 0,
  normal_fast_discount numeric not null default 0,
  advanced_fast_discount numeric not null default 0,
  super_fast_discount numeric not null default 0,
  activity_discount_da numeric not null default 0.9,
  current_ad_budget numeric not null default 0,
  three_day_ad_profit_negative boolean not null default false,
  manual_status text not null default '待确认',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_strategy_states_owner_id_product_id_key
    unique (owner_id, product_id)
);

create table if not exists public.shipping_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  batch_code text not null,
  total_weight_g numeric(10,2) not null default 0,
  sf_total_cost_rmb numeric(10,4) not null default 0,
  created_at timestamptz not null default now(),
  constraint shipping_batches_owner_code_unique unique (owner_id, batch_code)
);

create table if not exists public.shipping_batch_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  batch_id uuid not null references public.shipping_batches(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity numeric(10,2) not null default 1,
  single_package_weight_g numeric(10,2) not null default 0,
  total_weight_g numeric(10,2) not null default 0,
  sf_allocated_cost_rmb numeric(10,4) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.strategy_rule_settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  phase text not null,
  target_profit_rate numeric not null default 0.10,
  max_loss_day_total numeric not null default 100,
  max_loss_sku numeric not null default 100,
  bmin numeric not null default 100,
  qstep numeric not null default 2.1,
  coupon_min_qty numeric not null default 200,
  ktarget numeric not null default 50,
  ad_learn_orders numeric not null default 10,
  activity_discount_min numeric not null default 0.5,
  activity_discount_max numeric not null default 0.9,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint strategy_rule_settings_owner_id_phase_key unique (owner_id, phase)
);

create table if not exists public.warehouse_products (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  owner_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouse_products_warehouse_id_product_id_key
    unique (warehouse_id, product_id)
);

alter table public.product_strategy_states enable row level security;
alter table public.shipping_batches enable row level security;
alter table public.shipping_batch_items enable row level security;
alter table public.strategy_rule_settings enable row level security;
alter table public.warehouse_products enable row level security;

do $block$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.product_strategy_states'::regclass
      and tgname = 'product_strategy_states_set_updated_at'
      and not tgisinternal
  ) then
    create trigger product_strategy_states_set_updated_at
    before update on public.product_strategy_states
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.strategy_rule_settings'::regclass
      and tgname = 'strategy_rule_settings_set_updated_at'
      and not tgisinternal
  ) then
    create trigger strategy_rule_settings_set_updated_at
    before update on public.strategy_rule_settings
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.warehouse_products'::regclass
      and tgname = 'warehouse_products_set_updated_at'
      and not tgisinternal
  ) then
    create trigger warehouse_products_set_updated_at
    before update on public.warehouse_products
    for each row execute function public.set_updated_at();
  end if;
end
$block$;
