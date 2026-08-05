create table public.simple_product_sku_infos (
  id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null,
  shop_id uuid not null default private.current_write_shop_id(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  product_code text not null,
  sku_code text not null,
  product_name_cn text not null,
  product_name_en text not null,
  material text not null,
  purchase_price_rmb numeric(20, 6) not null,
  purchase_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint simple_product_sku_infos_product_code_not_blank check (btrim(product_code) <> ''),
  constraint simple_product_sku_infos_sku_code_not_blank check (btrim(sku_code) <> ''),
  constraint simple_product_sku_infos_name_cn_not_blank check (btrim(product_name_cn) <> ''),
  constraint simple_product_sku_infos_name_en_not_blank check (btrim(product_name_en) <> ''),
  constraint simple_product_sku_infos_material_not_blank check (btrim(material) <> ''),
  constraint simple_product_sku_infos_purchase_price_nonnegative check (purchase_price_rmb >= 0),
  constraint simple_product_sku_infos_shop_scope_fkey
    foreign key (enterprise_id, shop_id)
    references public.shops(enterprise_id, id)
    on delete restrict
);

create unique index simple_product_sku_infos_shop_sku_unique
  on public.simple_product_sku_infos (shop_id, sku_code);
create index simple_product_sku_infos_shop_product_code_idx
  on public.simple_product_sku_infos (shop_id, product_code);
create index simple_product_sku_infos_shop_updated_at_idx
  on public.simple_product_sku_infos (shop_id, updated_at desc);

drop trigger if exists simple_product_sku_infos_set_updated_at on public.simple_product_sku_infos;
create trigger simple_product_sku_infos_set_updated_at
before update on public.simple_product_sku_infos
for each row execute function public.set_updated_at();

drop trigger if exists multitenant_fill_shop_scope on public.simple_product_sku_infos;
create trigger multitenant_fill_shop_scope
before insert or update of enterprise_id, shop_id on public.simple_product_sku_infos
for each row execute function private.enforce_row_shop_scope();

alter table public.simple_product_sku_infos enable row level security;

create policy simple_product_sku_infos_select
on public.simple_product_sku_infos for select to authenticated
using (private.current_user_can_read_shop(shop_id, 'products'));

create policy simple_product_sku_infos_insert
on public.simple_product_sku_infos for insert to authenticated
with check (private.current_user_has_shop_action(shop_id, 'products', 'update'));

create policy simple_product_sku_infos_update
on public.simple_product_sku_infos for update to authenticated
using (private.current_user_has_shop_action(shop_id, 'products', 'update'))
with check (private.current_user_has_shop_action(shop_id, 'products', 'update'));

create policy simple_product_sku_infos_delete
on public.simple_product_sku_infos for delete to authenticated
using (private.current_user_has_shop_action(shop_id, 'products', 'delete'));

grant select on public.simple_product_sku_infos to authenticated;
  grant insert, update, delete on public.simple_product_sku_infos to authenticated;
