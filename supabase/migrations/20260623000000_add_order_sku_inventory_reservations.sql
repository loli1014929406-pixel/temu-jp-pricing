create table if not exists public.temu_order_sku_inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.temu_orders(id) on delete cascade,
  warehouse_sku_id uuid not null references public.warehouse_skus(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  reason text not null default '',
  released_reason text not null default '',
  created_at timestamptz not null default now(),
  released_at timestamptz
);

create unique index if not exists temu_order_sku_inventory_reservations_active_order_idx
on public.temu_order_sku_inventory_reservations(order_id)
where released_at is null;

create index if not exists temu_order_sku_inventory_reservations_order_idx
on public.temu_order_sku_inventory_reservations(order_id);

grant select, insert, update, delete
on table public.temu_order_sku_inventory_reservations
to authenticated;

alter table public.temu_order_sku_inventory_reservations enable row level security;

drop policy if exists "temu_order_sku_inventory_reservations_select" on public.temu_order_sku_inventory_reservations;
create policy "temu_order_sku_inventory_reservations_select"
on public.temu_order_sku_inventory_reservations for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "temu_order_sku_inventory_reservations_insert_edit" on public.temu_order_sku_inventory_reservations;
create policy "temu_order_sku_inventory_reservations_insert_edit"
on public.temu_order_sku_inventory_reservations for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "temu_order_sku_inventory_reservations_update_edit" on public.temu_order_sku_inventory_reservations;
create policy "temu_order_sku_inventory_reservations_update_edit"
on public.temu_order_sku_inventory_reservations for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "temu_order_sku_inventory_reservations_delete_admin" on public.temu_order_sku_inventory_reservations;
create policy "temu_order_sku_inventory_reservations_delete_admin"
on public.temu_order_sku_inventory_reservations for delete to authenticated
using (public.current_account_can_delete());

with matched_existing_orders as (
  select distinct on (temu_orders.id)
    temu_orders.id as order_id,
    warehouse_skus.id as warehouse_sku_id,
    temu_orders.owner_id,
    greatest(1, temu_orders.fulfillment_quantity) as quantity
  from public.temu_orders
  join public.product_skus
    on lower(trim(product_skus.sku_code)) = lower(trim(temu_orders.sku_code))
  join public.warehouse_skus
    on warehouse_skus.warehouse_id = temu_orders.warehouse_id
   and warehouse_skus.sku_id = product_skus.id
  where temu_orders.warehouse_id is not null
    and trim(temu_orders.sku_code) <> ''
    and not exists (
      select 1
      from public.temu_order_sku_inventory_reservations existing
      where existing.order_id = temu_orders.id
        and existing.released_at is null
    )
  order by temu_orders.id, product_skus.created_at desc, product_skus.id
)
insert into public.temu_order_sku_inventory_reservations (
  order_id,
  warehouse_sku_id,
  owner_id,
  quantity,
  reason
)
select
  order_id,
  warehouse_sku_id,
  owner_id,
  quantity,
  '历史订单库存占用迁移'
from matched_existing_orders;

create or replace function public.reserve_order_sku_inventory(
  p_order_id uuid,
  p_warehouse_sku_id uuid,
  p_quantity integer,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_order public.temu_orders%rowtype;
  v_existing public.temu_order_sku_inventory_reservations%rowtype;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_existing_stock public.warehouse_skus%rowtype;
  v_changes jsonb := '[]'::jsonb;
  v_reason text := coalesce(nullif(trim(p_reason), ''), '订单库存占用');
begin
  if not public.current_account_can_edit() then
    raise exception '权限不足，无法占用订单库存';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception '订单库存占用数量必须大于 0';
  end if;

  select *
  into v_order
  from public.temu_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception '订单不存在，无法占用库存';
  end if;

  select *
  into v_existing
  from public.temu_order_sku_inventory_reservations
  where order_id = p_order_id
    and released_at is null
  for update;

  if found and v_existing.warehouse_sku_id = p_warehouse_sku_id and v_existing.quantity = p_quantity then
    return jsonb_build_object('changes', v_changes, 'status', 'already_reserved');
  end if;

  if found then
    perform id
    from public.warehouse_skus
    where id in (v_existing.warehouse_sku_id, p_warehouse_sku_id)
    order by id
    for update;

    select *
    into v_existing_stock
    from public.warehouse_skus
    where id = v_existing.warehouse_sku_id;

    if not found then
      raise exception '原订单 SKU 库存不存在，无法调整库存占用';
    end if;

    update public.warehouse_skus
    set stock_quantity = stock_quantity + v_existing.quantity,
        updated_at = now()
    where id = v_existing_stock.id
    returning * into v_next_stock;

    update public.temu_order_sku_inventory_reservations
    set released_at = now(),
        released_reason = '订单库存占用变更'
    where id = v_existing.id;

    v_changes := v_changes || jsonb_build_object(
      'sku', to_jsonb(v_next_stock),
      'previous_quantity', v_existing_stock.stock_quantity,
      'change_quantity', v_existing.quantity
    );
  else
    perform id
    from public.warehouse_skus
    where id = p_warehouse_sku_id
    for update;
  end if;

  select *
  into v_stock
  from public.warehouse_skus
  where id = p_warehouse_sku_id;

  if not found then
    raise exception '仓库 SKU 库存不存在，无法占用库存';
  end if;

  if v_stock.stock_quantity < p_quantity then
    raise exception '仓库 SKU 库存不足：当前 %，需要 %', v_stock.stock_quantity, p_quantity;
  end if;

  update public.warehouse_skus
  set stock_quantity = stock_quantity - p_quantity,
      updated_at = now()
  where id = v_stock.id
  returning * into v_next_stock;

  insert into public.temu_order_sku_inventory_reservations (
    order_id,
    warehouse_sku_id,
    owner_id,
    quantity,
    reason
  )
  values (
    p_order_id,
    p_warehouse_sku_id,
    v_order.owner_id,
    p_quantity,
    v_reason
  );

  v_changes := v_changes || jsonb_build_object(
    'sku', to_jsonb(v_next_stock),
    'previous_quantity', v_stock.stock_quantity,
    'change_quantity', -p_quantity
  );

  return jsonb_build_object('changes', v_changes, 'status', 'reserved');
end;
$$;

grant execute on function public.reserve_order_sku_inventory(uuid, uuid, integer, text) to authenticated;

create or replace function public.release_order_sku_inventory(
  p_order_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_order public.temu_orders%rowtype;
  v_existing public.temu_order_sku_inventory_reservations%rowtype;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_changes jsonb := '[]'::jsonb;
  v_reason text := coalesce(nullif(trim(p_reason), ''), '订单库存释放');
begin
  if not public.current_account_can_edit() then
    raise exception '权限不足，无法释放订单库存';
  end if;

  select *
  into v_order
  from public.temu_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception '订单不存在，无法释放库存';
  end if;

  select *
  into v_existing
  from public.temu_order_sku_inventory_reservations
  where order_id = p_order_id
    and released_at is null
  for update;

  if not found then
    return jsonb_build_object('changes', v_changes, 'status', 'not_reserved');
  end if;

  select *
  into v_stock
  from public.warehouse_skus
  where id = v_existing.warehouse_sku_id
  for update;

  if not found then
    raise exception '仓库 SKU 库存不存在，无法释放库存';
  end if;

  update public.warehouse_skus
  set stock_quantity = stock_quantity + v_existing.quantity,
      updated_at = now()
  where id = v_stock.id
  returning * into v_next_stock;

  update public.temu_order_sku_inventory_reservations
  set released_at = now(),
      released_reason = v_reason
  where id = v_existing.id;

  v_changes := v_changes || jsonb_build_object(
    'sku', to_jsonb(v_next_stock),
    'previous_quantity', v_stock.stock_quantity,
    'change_quantity', v_existing.quantity
  );

  return jsonb_build_object('changes', v_changes, 'status', 'released');
end;
$$;

grant execute on function public.release_order_sku_inventory(uuid, text) to authenticated;
