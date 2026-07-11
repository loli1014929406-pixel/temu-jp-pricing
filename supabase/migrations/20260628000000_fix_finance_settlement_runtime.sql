alter table public.temu_orders
add column if not exists actual_shipping_fee_rmb numeric not null default 0;

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

alter table public.finance_settlement_files
add column if not exists imported_at timestamptz not null default now();

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

grant select, insert, update, delete on table public.finance_settlement_files to authenticated;
grant select, insert, update, delete on table public.finance_settlement_records to authenticated;

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
