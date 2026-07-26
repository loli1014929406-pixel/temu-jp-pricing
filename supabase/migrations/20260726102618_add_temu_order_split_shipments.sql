-- Split fulfillment into package-level shipments while keeping Temu order lines
-- as the commercial source of truth. Existing orders are backfilled as one
-- invisible package, so historical unsplit orders keep their current UI.

create table public.temu_order_shipments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_no text not null,
  package_sequence integer not null check (package_sequence > 0),
  order_status text not null default '',
  warehouse_id uuid references public.warehouses(id) on delete set null,
  warehouse_name text not null default '',
  logistics_method_id uuid references public.logistics_methods(id) on delete set null,
  logistics_method text not null default '',
  label_printed_at text not null default '',
  logistics_tracking_no text not null default '',
  logistics_status text not null default '',
  logistics_status_detail text not null default '',
  tracking_category text not null default 'pending' check (
    tracking_category in (
      'pending',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'available_for_pickup',
      'failed_attempt',
      'exception'
    )
  ),
  tracking_event_time timestamptz,
  tracking_last_checked_at timestamptz,
  tracking_last_query_error text not null default '',
  tracking_last_query_error_at timestamptz,
  tracking_is_exception boolean not null default false,
  tracking_exception_reason text not null default '',
  tracking_exception_fingerprint text not null default '',
  tracking_exception_handled_at timestamptz,
  tracking_exception_handled_by uuid references auth.users(id) on delete set null,
  actual_ship_time text not null default '',
  actual_signed_time text not null default '',
  actual_shipping_fee_rmb numeric not null default 0 check (actual_shipping_fee_rmb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index temu_order_shipments_order_package_uidx
  on public.temu_order_shipments (lower(btrim(order_no)), package_sequence);

create index temu_order_shipments_order_idx
  on public.temu_order_shipments (lower(btrim(order_no)), id);

create index temu_order_shipments_owner_idx
  on public.temu_order_shipments (owner_id);

create index temu_order_shipments_warehouse_idx
  on public.temu_order_shipments (warehouse_id)
  where warehouse_id is not null;

create index temu_order_shipments_logistics_method_idx
  on public.temu_order_shipments (logistics_method_id)
  where logistics_method_id is not null;

create index temu_order_shipments_handled_by_idx
  on public.temu_order_shipments (tracking_exception_handled_by)
  where tracking_exception_handled_by is not null;

create index temu_order_shipments_tracking_idx
  on public.temu_order_shipments (logistics_tracking_no)
  where btrim(logistics_tracking_no) <> '';

create index temu_order_shipments_exception_idx
  on public.temu_order_shipments (tracking_exception_handled_at, order_no)
  where tracking_is_exception = true;

create table public.temu_order_shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.temu_order_shipments(id) on delete cascade,
  order_id uuid not null references public.temu_orders(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shipment_id, order_id)
);

create index temu_order_shipment_items_order_idx
  on public.temu_order_shipment_items (order_id, shipment_id);

create index temu_order_shipment_items_owner_idx
  on public.temu_order_shipment_items (owner_id);

create table public.temu_order_split_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_no text not null,
  action text not null check (action in ('split', 'replace', 'cancel')),
  before_snapshot jsonb not null default '[]'::jsonb,
  after_snapshot jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index temu_order_split_events_order_idx
  on public.temu_order_split_events (lower(btrim(order_no)), created_at desc);

create index temu_order_split_events_owner_idx
  on public.temu_order_split_events (owner_id);

create index temu_order_split_events_created_by_idx
  on public.temu_order_split_events (created_by)
  where created_by is not null;

grant select, insert, update, delete
  on table public.temu_order_shipments
  to authenticated;

grant select, insert, update, delete
  on table public.temu_order_shipment_items
  to authenticated;

grant select, insert
  on table public.temu_order_split_events
  to authenticated;

alter table public.temu_order_shipments enable row level security;
alter table public.temu_order_shipment_items enable row level security;
alter table public.temu_order_split_events enable row level security;

create policy "temu_order_shipments_select_team"
  on public.temu_order_shipments for select to authenticated
  using ((select public.current_account_has_permission()));

create policy "temu_order_shipments_insert_team"
  on public.temu_order_shipments for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select public.current_account_can_edit())
  );

create policy "temu_order_shipments_update_team"
  on public.temu_order_shipments for update to authenticated
  using ((select public.current_account_can_edit()))
  with check ((select public.current_account_can_edit()));

create policy "temu_order_shipments_delete_team"
  on public.temu_order_shipments for delete to authenticated
  using ((select public.current_account_can_delete()));

create policy "temu_order_shipment_items_select_team"
  on public.temu_order_shipment_items for select to authenticated
  using ((select public.current_account_has_permission()));

create policy "temu_order_shipment_items_insert_team"
  on public.temu_order_shipment_items for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select public.current_account_can_edit())
  );

create policy "temu_order_shipment_items_update_team"
  on public.temu_order_shipment_items for update to authenticated
  using ((select public.current_account_can_edit()))
  with check ((select public.current_account_can_edit()));

create policy "temu_order_shipment_items_delete_team"
  on public.temu_order_shipment_items for delete to authenticated
  using ((select public.current_account_can_edit()));

create policy "temu_order_split_events_select_team"
  on public.temu_order_split_events for select to authenticated
  using ((select public.current_account_has_permission()));

create policy "temu_order_split_events_insert_team"
  on public.temu_order_split_events for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select public.current_account_can_edit())
  );

drop trigger if exists temu_order_shipments_set_updated_at on public.temu_order_shipments;
create trigger temu_order_shipments_set_updated_at
  before update on public.temu_order_shipments
  for each row execute function public.set_updated_at();

drop trigger if exists temu_order_shipment_items_set_updated_at on public.temu_order_shipment_items;
create trigger temu_order_shipment_items_set_updated_at
  before update on public.temu_order_shipment_items
  for each row execute function public.set_updated_at();

drop trigger if exists temu_order_shipments_prevent_owner_change on public.temu_order_shipments;
create trigger temu_order_shipments_prevent_owner_change
  before update on public.temu_order_shipments
  for each row execute function public.prevent_operational_owner_change();

drop trigger if exists temu_order_shipment_items_prevent_owner_change on public.temu_order_shipment_items;
create trigger temu_order_shipment_items_prevent_owner_change
  before update on public.temu_order_shipment_items
  for each row execute function public.prevent_operational_owner_change();

-- Backfill one shipment per existing original Temu order.
insert into public.temu_order_shipments (
  owner_id,
  order_no,
  package_sequence,
  order_status,
  warehouse_id,
  warehouse_name,
  logistics_method_id,
  logistics_method,
  label_printed_at,
  logistics_tracking_no,
  logistics_status,
  logistics_status_detail,
  tracking_category,
  tracking_event_time,
  tracking_last_checked_at,
  tracking_last_query_error,
  tracking_last_query_error_at,
  tracking_is_exception,
  tracking_exception_reason,
  tracking_exception_fingerprint,
  tracking_exception_handled_at,
  tracking_exception_handled_by,
  actual_ship_time,
  actual_signed_time,
  actual_shipping_fee_rmb,
  created_at,
  updated_at
)
select distinct on (lower(btrim(order_row.order_no)))
  order_row.owner_id,
  order_row.order_no,
  1,
  order_row.order_status,
  order_row.warehouse_id,
  order_row.warehouse_name,
  order_row.logistics_method_id,
  order_row.logistics_method,
  order_row.label_printed_at,
  order_row.logistics_tracking_no,
  order_row.logistics_status,
  order_row.logistics_status_detail,
  order_row.tracking_category,
  order_row.tracking_event_time,
  order_row.tracking_last_checked_at,
  order_row.tracking_last_query_error,
  order_row.tracking_last_query_error_at,
  order_row.tracking_is_exception,
  order_row.tracking_exception_reason,
  order_row.tracking_exception_fingerprint,
  order_row.tracking_exception_handled_at,
  order_row.tracking_exception_handled_by,
  order_row.actual_ship_time,
  order_row.actual_signed_time,
  order_row.actual_shipping_fee_rmb,
  order_row.created_at,
  order_row.updated_at
from public.temu_orders order_row
where btrim(order_row.order_no) <> ''
order by
  lower(btrim(order_row.order_no)),
  (
    case
      when btrim(order_row.actual_signed_time) <> '' then 6
      when lower(btrim(order_row.order_status)) in ('上传temu', '已上传temu') then 5
      when btrim(order_row.actual_ship_time) <> ''
        or btrim(order_row.logistics_tracking_no) <> '' then 4
      when btrim(order_row.label_printed_at) <> '' then 3
      when order_row.warehouse_id is not null
        and order_row.logistics_method_id is not null then 2
      else 1
    end
  ) desc,
  order_row.updated_at desc,
  order_row.id;

insert into public.temu_order_shipment_items (
  shipment_id,
  order_id,
  owner_id,
  quantity,
  created_at,
  updated_at
)
select
  shipment.id,
  order_row.id,
  order_row.owner_id,
  order_row.fulfillment_quantity,
  order_row.created_at,
  order_row.updated_at
from public.temu_orders order_row
join public.temu_order_shipments shipment
  on lower(btrim(shipment.order_no)) = lower(btrim(order_row.order_no))
 and shipment.package_sequence = 1
where order_row.fulfillment_quantity > 0;

alter table public.temu_order_sku_inventory_reservations
  add column shipment_item_id uuid;

update public.temu_order_sku_inventory_reservations reservation
set shipment_item_id = item.id
from public.temu_order_shipment_items item
where item.order_id = reservation.order_id
  and reservation.shipment_item_id is null;

alter table public.temu_order_sku_inventory_reservations
  add constraint temu_order_sku_inventory_reservations_shipment_item_fkey
  foreign key (shipment_item_id)
  references public.temu_order_shipment_items(id)
  on delete set null;

drop index if exists public.temu_order_sku_inventory_reservations_active_order_idx;

create unique index temu_order_sku_inventory_reservations_active_item_idx
  on public.temu_order_sku_inventory_reservations (shipment_item_id)
  where released_at is null and shipment_item_id is not null;

create index temu_order_sku_inventory_reservations_shipment_item_idx
  on public.temu_order_sku_inventory_reservations (shipment_item_id, released_at);

revoke execute on function public.reserve_order_sku_inventory(
  uuid,
  uuid,
  integer,
  text
) from authenticated;
revoke execute on function public.release_order_sku_inventory(
  uuid,
  text
) from authenticated;

create or replace function public.temu_order_shipment_stage(
  p_shipment public.temu_order_shipments
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when btrim(p_shipment.actual_signed_time) <> '' then 'completed'
    when lower(btrim(p_shipment.order_status)) in ('上传temu', '已上传temu') then 'uploaded_temu'
    when btrim(p_shipment.actual_ship_time) <> ''
      or btrim(p_shipment.logistics_tracking_no) <> '' then 'shipped'
    when btrim(p_shipment.label_printed_at) <> '' then 'pending_shipping'
    when (
      p_shipment.warehouse_id is not null
      or btrim(p_shipment.warehouse_name) <> ''
    ) and (
      p_shipment.logistics_method_id is not null
      or btrim(p_shipment.logistics_method) <> ''
    ) then 'new_order'
    else 'pending_assignment'
  end
$$;

revoke all on function public.temu_order_shipment_stage(public.temu_order_shipments) from public;
grant execute on function public.temu_order_shipment_stage(public.temu_order_shipments) to authenticated;

create or replace function public.sync_temu_order_shipment_logistics_method()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_method_name text;
begin
  if new.logistics_method_id is not null then
    select method.name
      into v_method_name
    from public.logistics_methods method
    where method.id = new.logistics_method_id;

    if not found then
      raise exception '物流方式不存在。' using errcode = '23503';
    end if;

    new.logistics_method := v_method_name;
  elsif btrim(new.logistics_method) <> '' then
    new.logistics_method_id := public.resolve_logistics_method_id(new.logistics_method);
    if new.logistics_method_id is not null then
      select method.name
        into new.logistics_method
      from public.logistics_methods method
      where method.id = new.logistics_method_id;
    end if;
  end if;

  return new;
end
$$;

revoke all on function public.sync_temu_order_shipment_logistics_method() from public;

create trigger temu_order_shipments_sync_logistics_method
  before insert or update of logistics_method_id, logistics_method
  on public.temu_order_shipments
  for each row execute function public.sync_temu_order_shipment_logistics_method();

create or replace function public.sync_new_temu_order_shipment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment_id uuid;
begin
  if new.fulfillment_quantity <= 0 or btrim(new.order_no) = '' then
    return new;
  end if;

  select shipment.id
    into v_shipment_id
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = lower(btrim(new.order_no))
  order by shipment.package_sequence, shipment.id
  limit 1;

  if v_shipment_id is null then
    insert into public.temu_order_shipments (
      owner_id,
      order_no,
      package_sequence,
      order_status,
      warehouse_id,
      warehouse_name,
      logistics_method_id,
      logistics_method,
      label_printed_at,
      logistics_tracking_no,
      logistics_status,
      logistics_status_detail,
      tracking_category,
      tracking_event_time,
      tracking_last_checked_at,
      tracking_last_query_error,
      tracking_last_query_error_at,
      tracking_is_exception,
      tracking_exception_reason,
      tracking_exception_fingerprint,
      tracking_exception_handled_at,
      tracking_exception_handled_by,
      actual_ship_time,
      actual_signed_time,
      actual_shipping_fee_rmb,
      created_at,
      updated_at
    )
    values (
      new.owner_id,
      new.order_no,
      1,
      new.order_status,
      new.warehouse_id,
      new.warehouse_name,
      new.logistics_method_id,
      new.logistics_method,
      new.label_printed_at,
      new.logistics_tracking_no,
      new.logistics_status,
      new.logistics_status_detail,
      new.tracking_category,
      new.tracking_event_time,
      new.tracking_last_checked_at,
      new.tracking_last_query_error,
      new.tracking_last_query_error_at,
      new.tracking_is_exception,
      new.tracking_exception_reason,
      new.tracking_exception_fingerprint,
      new.tracking_exception_handled_at,
      new.tracking_exception_handled_by,
      new.actual_ship_time,
      new.actual_signed_time,
      new.actual_shipping_fee_rmb,
      new.created_at,
      new.updated_at
    )
    returning id into v_shipment_id;
  end if;

  insert into public.temu_order_shipment_items (
    shipment_id,
    order_id,
    owner_id,
    quantity,
    created_at,
    updated_at
  )
  values (
    v_shipment_id,
    new.id,
    new.owner_id,
    new.fulfillment_quantity,
    new.created_at,
    new.updated_at
  );

  return new;
end
$$;

revoke all on function public.sync_new_temu_order_shipment() from public;

create trigger temu_orders_create_default_shipment
  after insert on public.temu_orders
  for each row execute function public.sync_new_temu_order_shipment();

create or replace function public.validate_temu_order_shipment_allocations()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment_id uuid;
  v_order_key text;
begin
  if tg_op = 'DELETE' then
    v_shipment_id := old.shipment_id;
  else
    v_shipment_id := new.shipment_id;
  end if;

  select lower(btrim(shipment.order_no))
    into v_order_key
  from public.temu_order_shipments shipment
  where shipment.id = v_shipment_id;

  -- The parent shipment may already have been deleted by an approved split or
  -- group-delete transaction.
  if v_order_key is null then
    return null;
  end if;

  if exists (
    select 1
    from public.temu_order_shipments shipment
    where lower(btrim(shipment.order_no)) = v_order_key
      and not exists (
        select 1
        from public.temu_order_shipment_items item
        where item.shipment_id = shipment.id
      )
  ) then
    raise exception '订单包裹不能为空。' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.temu_orders source
    left join (
      select item.order_id, sum(item.quantity) as allocated_quantity
      from public.temu_order_shipment_items item
      join public.temu_order_shipments shipment
        on shipment.id = item.shipment_id
      where lower(btrim(shipment.order_no)) = v_order_key
      group by item.order_id
    ) allocation on allocation.order_id = source.id
    where lower(btrim(source.order_no)) = v_order_key
      and coalesce(allocation.allocated_quantity, 0)
        <> source.fulfillment_quantity
  ) then
    raise exception '订单商品的包裹分配数量必须等于原订单数量。'
      using errcode = '23514';
  end if;

  return null;
end
$$;

revoke all on function public.validate_temu_order_shipment_allocations() from public;

create constraint trigger temu_order_shipment_items_validate_allocations
  after insert or update or delete
  on public.temu_order_shipment_items
  deferrable initially deferred
  for each row execute function public.validate_temu_order_shipment_allocations();

create or replace function public.validate_temu_order_source_quantity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_allocated_quantity integer;
begin
  select coalesce(sum(item.quantity), 0)::integer
    into v_allocated_quantity
  from public.temu_order_shipment_items item
  where item.order_id = new.id;

  if v_allocated_quantity <> new.fulfillment_quantity then
    raise exception '已有包裹分配与新的订单数量不一致，请先调整拆单。'
      using errcode = '23514';
  end if;

  return new;
end
$$;

revoke all on function public.validate_temu_order_source_quantity() from public;

create trigger temu_orders_validate_fulfillment_quantity
  after update of fulfillment_quantity on public.temu_orders
  for each row
  when (old.fulfillment_quantity is distinct from new.fulfillment_quantity)
  execute function public.validate_temu_order_source_quantity();

drop policy if exists "temu_order_shipments_delete_team" on public.temu_order_shipments;
create policy "temu_order_shipments_delete_team"
  on public.temu_order_shipments for delete to authenticated
  using ((select public.current_account_can_edit()));

create or replace function public.get_temu_order_shipment_snapshot(p_order_no text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'shipment_id', shipment.id,
        'package_sequence', shipment.package_sequence,
        'warehouse_id', shipment.warehouse_id,
        'warehouse_name', shipment.warehouse_name,
        'logistics_method_id', shipment.logistics_method_id,
        'logistics_method', shipment.logistics_method,
        'logistics_tracking_no', shipment.logistics_tracking_no,
        'items', coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'shipment_item_id', item.id,
                'order_id', item.order_id,
                'quantity', item.quantity
              )
              order by source.sub_order_no, source.id
            )
            from public.temu_order_shipment_items item
            join public.temu_orders source on source.id = item.order_id
            where item.shipment_id = shipment.id
          ),
          '[]'::jsonb
        )
      )
      order by shipment.package_sequence
    ),
    '[]'::jsonb
  )
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = lower(btrim(p_order_no))
$$;

revoke all on function public.get_temu_order_shipment_snapshot(text) from public;
grant execute on function public.get_temu_order_shipment_snapshot(text) to authenticated;

create or replace function public.save_temu_order_split(
  p_order_no text,
  p_packages jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_key text := lower(btrim(coalesce(p_order_no, '')));
  v_display_order_no text;
  v_owner_id uuid := auth.uid();
  v_package_count integer;
  v_previous_package_count integer;
  v_total_quantity integer;
  v_before jsonb;
  v_after jsonb;
  v_package record;
  v_item record;
  v_shipment_id uuid;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能拆分订单。'
      using errcode = '42501';
  end if;

  if v_order_key = '' then
    raise exception '订单号不能为空。' using errcode = '22023';
  end if;

  if jsonb_typeof(p_packages) <> 'array' then
    raise exception '拆单数据格式不正确。' using errcode = '22023';
  end if;

  v_package_count := jsonb_array_length(p_packages);
  if v_package_count < 2 then
    raise exception '拆单后至少需要 2 个包裹。' using errcode = '22023';
  end if;

  perform source.id
  from public.temu_orders source
  where lower(btrim(source.order_no)) = v_order_key
  order by source.id
  for update;

  select
    (array_agg(source.order_no order by source.created_at, source.id))[1],
    sum(source.fulfillment_quantity)
  into v_display_order_no, v_total_quantity
  from public.temu_orders source
  where lower(btrim(source.order_no)) = v_order_key;

  if v_display_order_no is null then
    raise exception '订单不存在，不能拆分。' using errcode = 'P0002';
  end if;

  if v_total_quantity <= 1 then
    raise exception '订单商品总数不足 2 件，不能拆单。' using errcode = '22023';
  end if;

  if v_package_count > v_total_quantity then
    raise exception '包裹数不能超过订单商品总件数 %。', v_total_quantity
      using errcode = '22023';
  end if;

  perform shipment.id
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key
  order by shipment.id
  for update;

  select count(*)
    into v_previous_package_count
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key;

  if v_previous_package_count = 0 then
    raise exception '订单包裹数据不存在，请先执行数据修复。'
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.temu_order_shipments shipment
    where lower(btrim(shipment.order_no)) = v_order_key
      and (
        public.temu_order_shipment_stage(shipment) <> 'pending_assignment'
        or btrim(shipment.label_printed_at) <> ''
        or btrim(shipment.logistics_tracking_no) <> ''
        or btrim(shipment.actual_ship_time) <> ''
        or btrim(shipment.actual_signed_time) <> ''
        or shipment.actual_shipping_fee_rmb > 0
      )
  ) then
    raise exception '只有全部仍在待分配、且没有面单、运单、发货或运费记录的订单才能拆分。'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    join public.temu_order_shipments shipment
      on shipment.id = item.shipment_id
    where lower(btrim(shipment.order_no)) = v_order_key
      and reservation.released_at is null
  ) then
    raise exception '订单已经占用库存，不能拆分。' using errcode = '55000';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_packages) with ordinality package(value, package_no)
    where jsonb_typeof(package.value) <> 'object'
       or jsonb_typeof(package.value -> 'items') <> 'array'
       or jsonb_array_length(package.value -> 'items') = 0
  ) then
    raise exception '每个包裹都必须至少包含 1 件商品。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_packages) with ordinality package(value, package_no)
    cross join lateral jsonb_array_elements(package.value -> 'items') item
    where jsonb_typeof(item) <> 'object'
       or coalesce(item ->> 'order_id', '') = ''
       or coalesce(item ->> 'quantity', '') !~ '^[0-9]+$'
       or (item ->> 'quantity')::integer <= 0
  ) then
    raise exception '包裹商品和数量格式不正确。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from (
      select package.package_no, item ->> 'order_id' as order_id, count(*) as item_count
      from jsonb_array_elements(p_packages) with ordinality package(value, package_no)
      cross join lateral jsonb_array_elements(package.value -> 'items') item
      group by package.package_no, item ->> 'order_id'
      having count(*) > 1
    ) duplicate
  ) then
    raise exception '同一个包裹内不能重复填写同一订单商品。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_packages) package
    cross join lateral jsonb_array_elements(package -> 'items') item
    left join public.temu_orders source
      on source.id = (item ->> 'order_id')::uuid
     and lower(btrim(source.order_no)) = v_order_key
    where source.id is null
  ) then
    raise exception '拆单数据中包含不属于该订单的商品。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.temu_orders source
    left join (
      select
        (item ->> 'order_id')::uuid as order_id,
        sum((item ->> 'quantity')::integer) as allocated_quantity
      from jsonb_array_elements(p_packages) package
      cross join lateral jsonb_array_elements(package -> 'items') item
      group by (item ->> 'order_id')::uuid
    ) allocation on allocation.order_id = source.id
    where lower(btrim(source.order_no)) = v_order_key
      and coalesce(allocation.allocated_quantity, 0) <> source.fulfillment_quantity
  ) then
    raise exception '每个 SKU 的拆分数量合计必须等于原订单数量。'
      using errcode = '22023';
  end if;

  v_before := public.get_temu_order_shipment_snapshot(v_display_order_no);

  delete from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key;

  for v_package in
    select value, ordinality::integer as package_sequence
    from jsonb_array_elements(p_packages) with ordinality
    order by ordinality
  loop
    insert into public.temu_order_shipments (
      owner_id,
      order_no,
      package_sequence
    )
    values (
      v_owner_id,
      v_display_order_no,
      v_package.package_sequence
    )
    returning id into v_shipment_id;

    for v_item in
      select
        (value ->> 'order_id')::uuid as order_id,
        (value ->> 'quantity')::integer as quantity
      from jsonb_array_elements(v_package.value -> 'items')
    loop
      insert into public.temu_order_shipment_items (
        shipment_id,
        order_id,
        owner_id,
        quantity
      )
      values (
        v_shipment_id,
        v_item.order_id,
        v_owner_id,
        v_item.quantity
      );
    end loop;
  end loop;

  v_after := public.get_temu_order_shipment_snapshot(v_display_order_no);

  insert into public.temu_order_split_events (
    owner_id,
    order_no,
    action,
    before_snapshot,
    after_snapshot,
    created_by
  )
  values (
    v_owner_id,
    v_display_order_no,
    case when v_previous_package_count > 1 then 'replace' else 'split' end,
    v_before,
    v_after,
    auth.uid()
  );

  return jsonb_build_object(
    'order_no', v_display_order_no,
    'package_count', v_package_count,
    'shipments', v_after
  );
end
$$;

revoke all on function public.save_temu_order_split(text, jsonb) from public;
grant execute on function public.save_temu_order_split(text, jsonb) to authenticated;

create or replace function public.cancel_temu_order_split(p_order_no text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_key text := lower(btrim(coalesce(p_order_no, '')));
  v_display_order_no text;
  v_owner_id uuid := auth.uid();
  v_previous_package_count integer;
  v_before jsonb;
  v_after jsonb;
  v_shipment_id uuid;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能取消拆单。'
      using errcode = '42501';
  end if;

  perform source.id
  from public.temu_orders source
  where lower(btrim(source.order_no)) = v_order_key
  order by source.id
  for update;

  select (array_agg(source.order_no order by source.created_at, source.id))[1]
    into v_display_order_no
  from public.temu_orders source
  where lower(btrim(source.order_no)) = v_order_key;

  if v_display_order_no is null then
    raise exception '订单不存在。' using errcode = 'P0002';
  end if;

  perform shipment.id
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key
  order by shipment.id
  for update;

  select count(*)
    into v_previous_package_count
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key;

  if v_previous_package_count <= 1 then
    raise exception '当前订单没有可取消的拆单记录。' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.temu_order_shipments shipment
    where lower(btrim(shipment.order_no)) = v_order_key
      and (
        public.temu_order_shipment_stage(shipment) <> 'pending_assignment'
        or btrim(shipment.label_printed_at) <> ''
        or btrim(shipment.logistics_tracking_no) <> ''
        or btrim(shipment.actual_ship_time) <> ''
        or btrim(shipment.actual_signed_time) <> ''
        or shipment.actual_shipping_fee_rmb > 0
      )
  ) or exists (
    select 1
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    join public.temu_order_shipments shipment
      on shipment.id = item.shipment_id
    where lower(btrim(shipment.order_no)) = v_order_key
      and reservation.released_at is null
  ) then
    raise exception '只有全部仍在待分配、且没有库存、面单、运单、发货或运费记录的拆单才能取消。'
      using errcode = '55000';
  end if;

  v_before := public.get_temu_order_shipment_snapshot(v_display_order_no);

  delete from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key;

  insert into public.temu_order_shipments (
    owner_id,
    order_no,
    package_sequence
  )
  values (
    v_owner_id,
    v_display_order_no,
    1
  )
  returning id into v_shipment_id;

  insert into public.temu_order_shipment_items (
    shipment_id,
    order_id,
    owner_id,
    quantity
  )
  select
    v_shipment_id,
    source.id,
    v_owner_id,
    source.fulfillment_quantity
  from public.temu_orders source
  where lower(btrim(source.order_no)) = v_order_key
    and source.fulfillment_quantity > 0;

  v_after := public.get_temu_order_shipment_snapshot(v_display_order_no);

  insert into public.temu_order_split_events (
    owner_id,
    order_no,
    action,
    before_snapshot,
    after_snapshot,
    created_by
  )
  values (
    v_owner_id,
    v_display_order_no,
    'cancel',
    v_before,
    v_after,
    auth.uid()
  );

  return jsonb_build_object(
    'order_no', v_display_order_no,
    'package_count', 1,
    'shipments', v_after
  );
end
$$;

revoke all on function public.cancel_temu_order_split(text) from public;
grant execute on function public.cancel_temu_order_split(text) to authenticated;

create or replace function public.assign_temu_order_shipment(
  p_shipment_id uuid,
  p_warehouse_id uuid,
  p_logistics_method_id uuid,
  p_reservations jsonb,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment public.temu_order_shipments%rowtype;
  v_warehouse public.warehouses%rowtype;
  v_method public.logistics_methods%rowtype;
  v_item_count integer;
  v_reason text;
  v_release record;
  v_allocation record;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_changes jsonb := '[]'::jsonb;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能分配包裹。'
      using errcode = '42501';
  end if;

  if p_warehouse_id is null or p_logistics_method_id is null then
    raise exception '仓库和尾程发货方式不能为空。' using errcode = '22023';
  end if;

  if jsonb_typeof(p_reservations) <> 'array' then
    raise exception '库存分配数据格式不正确。' using errcode = '22023';
  end if;

  select *
    into v_shipment
  from public.temu_order_shipments shipment
  where shipment.id = p_shipment_id
  for update;

  if not found then
    raise exception '包裹不存在。' using errcode = 'P0002';
  end if;

  if public.temu_order_shipment_stage(v_shipment) not in ('pending_assignment', 'new_order')
     or btrim(v_shipment.label_printed_at) <> ''
     or btrim(v_shipment.logistics_tracking_no) <> ''
     or btrim(v_shipment.actual_ship_time) <> ''
     or btrim(v_shipment.actual_signed_time) <> '' then
    raise exception '只有待分配或新订单阶段的包裹可以修改仓库和发货方式。'
      using errcode = '55000';
  end if;

  select *
    into v_warehouse
  from public.warehouses warehouse
  where warehouse.id = p_warehouse_id;

  if not found then
    raise exception '所选仓库不存在。' using errcode = '23503';
  end if;

  select *
    into v_method
  from public.logistics_methods method
  where method.id = p_logistics_method_id
    and method.is_active = true;

  if not found then
    raise exception '所选物流方式不存在或已停用。' using errcode = '23503';
  end if;

  if not exists (
    select 1
    from public.warehouse_logistics_methods mapping
    where mapping.warehouse_id = p_warehouse_id
      and mapping.logistics_method_id = p_logistics_method_id
  ) then
    raise exception '所选物流方式未绑定到该仓库。' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.pricing_settings setting
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(setting.last_leg_methods) = 'array'
          then setting.last_leg_methods
        else '[]'::jsonb
      end
    ) configured
    where lower(coalesce(configured ->> 'type', 'last_leg')) = 'last_leg'
      and lower(coalesce(configured ->> 'isActive', 'true')) <> 'false'
      and (
        configured ->> 'db_method_id' = p_logistics_method_id::text
        or public.logistics_method_match_key(configured ->> 'name')
          = public.logistics_method_match_key(v_method.name)
      )
  ) then
    raise exception '所选物流方式不是当前启用的尾程发货方式。'
      using errcode = '23514';
  end if;

  select count(*)
    into v_item_count
  from public.temu_order_shipment_items item
  where item.shipment_id = p_shipment_id;

  if v_item_count = 0 then
    raise exception '包裹没有商品，不能分配。' using errcode = '23514';
  end if;

  if jsonb_array_length(p_reservations) <> v_item_count then
    raise exception '库存分配必须覆盖包裹内的全部商品。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_reservations) allocation
    where jsonb_typeof(allocation) <> 'object'
       or coalesce(allocation ->> 'shipment_item_id', '') = ''
       or coalesce(allocation ->> 'warehouse_sku_id', '') = ''
  ) then
    raise exception '库存分配数据不完整。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from (
      select allocation ->> 'shipment_item_id' as shipment_item_id
      from jsonb_array_elements(p_reservations) allocation
      group by allocation ->> 'shipment_item_id'
      having count(*) > 1
    ) duplicate
  ) then
    raise exception '同一个包裹商品不能重复分配库存。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_reservations) allocation
    left join public.temu_order_shipment_items item
      on item.id = (allocation ->> 'shipment_item_id')::uuid
     and item.shipment_id = p_shipment_id
    left join public.warehouse_skus stock
      on stock.id = (allocation ->> 'warehouse_sku_id')::uuid
     and stock.warehouse_id = p_warehouse_id
    where item.id is null
       or stock.id is null
  ) then
    raise exception '库存分配与包裹商品或仓库不匹配。' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.temu_order_shipment_items item
    left join jsonb_array_elements(p_reservations) allocation
      on allocation ->> 'shipment_item_id' = item.id::text
    where item.shipment_id = p_shipment_id
      and allocation is null
  ) then
    raise exception '库存分配遗漏了包裹商品。' using errcode = '22023';
  end if;

  -- Lock every old and new stock row in a stable order before changing balances.
  perform stock.id
  from public.warehouse_skus stock
  where stock.id in (
    select reservation.warehouse_sku_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
    union
    select (allocation ->> 'warehouse_sku_id')::uuid
    from jsonb_array_elements(p_reservations) allocation
  )
  order by stock.id
  for update;

  v_reason := coalesce(
    nullif(btrim(p_reason), ''),
    '订单包裹库存占用：' || v_shipment.order_no
      || case
           when (
             select count(*)
             from public.temu_order_shipments sibling
             where lower(btrim(sibling.order_no)) = lower(btrim(v_shipment.order_no))
           ) > 1
             then ' 包裹' || v_shipment.package_sequence
           else ''
         end
  );

  -- Release current reservations first. Any later failure rolls the transaction back.
  for v_release in
    select
      reservation.*,
      stock.warehouse_id,
      stock.sku_id,
      stock.stock_quantity
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    join public.warehouse_skus stock
      on stock.id = reservation.warehouse_sku_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
    order by reservation.id
  loop
    select *
      into v_stock
    from public.warehouse_skus stock
    where stock.id = v_release.warehouse_sku_id;

    update public.warehouse_skus
    set
      stock_quantity = stock_quantity + v_release.quantity,
      updated_at = now()
    where id = v_release.warehouse_sku_id
    returning * into v_next_stock;

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      owner_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      purchase_order_id,
      purchase_package_id
    )
    values (
      v_release.warehouse_id,
      v_release.sku_id,
      v_release.owner_id,
      v_stock.stock_quantity,
      v_next_stock.stock_quantity,
      v_release.quantity,
      '订单包裹库存占用变更回补：' || v_shipment.order_no,
      null,
      null
    );

    update public.temu_order_sku_inventory_reservations
    set
      released_at = now(),
      released_reason = '订单包裹库存占用变更'
    where id = v_release.id;

    v_changes := v_changes || jsonb_build_object(
      'sku', to_jsonb(v_next_stock),
      'previous_quantity', v_stock.stock_quantity,
      'change_quantity', v_release.quantity
    );
  end loop;

  if exists (
    select 1
    from (
      select
        stock.id,
        stock.stock_quantity,
        sum(item.quantity) as required_quantity
      from jsonb_array_elements(p_reservations) allocation
      join public.temu_order_shipment_items item
        on item.id = (allocation ->> 'shipment_item_id')::uuid
      join public.warehouse_skus stock
        on stock.id = (allocation ->> 'warehouse_sku_id')::uuid
      group by stock.id, stock.stock_quantity
      having stock.stock_quantity < sum(item.quantity)
    ) insufficient
  ) then
    raise exception '所选仓库的 SKU 库存不足。' using errcode = '23514';
  end if;

  for v_allocation in
    select
      item.id as shipment_item_id,
      item.order_id,
      item.quantity,
      source.owner_id,
      (allocation ->> 'warehouse_sku_id')::uuid as warehouse_sku_id
    from jsonb_array_elements(p_reservations) allocation
    join public.temu_order_shipment_items item
      on item.id = (allocation ->> 'shipment_item_id')::uuid
    join public.temu_orders source
      on source.id = item.order_id
    order by item.id
  loop
    select *
      into v_stock
    from public.warehouse_skus stock
    where stock.id = v_allocation.warehouse_sku_id;

    update public.warehouse_skus
    set
      stock_quantity = stock_quantity - v_allocation.quantity,
      updated_at = now()
    where id = v_allocation.warehouse_sku_id
    returning * into v_next_stock;

    insert into public.temu_order_sku_inventory_reservations (
      order_id,
      shipment_item_id,
      warehouse_sku_id,
      owner_id,
      quantity,
      reason
    )
    values (
      v_allocation.order_id,
      v_allocation.shipment_item_id,
      v_allocation.warehouse_sku_id,
      v_allocation.owner_id,
      v_allocation.quantity,
      v_reason
    );

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      owner_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      purchase_order_id,
      purchase_package_id
    )
    values (
      v_stock.warehouse_id,
      v_stock.sku_id,
      v_allocation.owner_id,
      v_stock.stock_quantity,
      v_next_stock.stock_quantity,
      -v_allocation.quantity,
      v_reason,
      null,
      null
    );

    v_changes := v_changes || jsonb_build_object(
      'sku', to_jsonb(v_next_stock),
      'previous_quantity', v_stock.stock_quantity,
      'change_quantity', -v_allocation.quantity
    );
  end loop;

  update public.temu_order_shipments shipment
  set
    warehouse_id = p_warehouse_id,
    warehouse_name = v_warehouse.name,
    logistics_method_id = p_logistics_method_id,
    logistics_method = v_method.name,
    order_status = case
      when btrim(shipment.order_status) = '' then '新订单'
      else shipment.order_status
    end
  where shipment.id = p_shipment_id;

  return jsonb_build_object(
    'shipment_id', p_shipment_id,
    'status', 'assigned',
    'changes', v_changes
  );
end
$$;

revoke all on function public.assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text) from public;
grant execute on function public.assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text) to authenticated;

create or replace function public.release_temu_order_shipment_inventory(
  p_shipment_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment public.temu_order_shipments%rowtype;
  v_release record;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_reason text;
  v_changes jsonb := '[]'::jsonb;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能释放包裹库存。'
      using errcode = '42501';
  end if;

  select *
    into v_shipment
  from public.temu_order_shipments shipment
  where shipment.id = p_shipment_id
  for update;

  if not found then
    raise exception '包裹不存在。' using errcode = 'P0002';
  end if;

  if btrim(v_shipment.label_printed_at) <> ''
     or btrim(v_shipment.logistics_tracking_no) <> ''
     or btrim(v_shipment.actual_ship_time) <> ''
     or btrim(v_shipment.actual_signed_time) <> '' then
    raise exception '已有面单、运单或发货记录的包裹不能退回待分配。'
      using errcode = '55000';
  end if;

  perform stock.id
  from public.warehouse_skus stock
  where stock.id in (
    select reservation.warehouse_sku_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
  )
  order by stock.id
  for update;

  v_reason := coalesce(
    nullif(btrim(p_reason), ''),
    '订单包裹退回待分配：' || v_shipment.order_no
  );

  for v_release in
    select
      reservation.*,
      stock.warehouse_id,
      stock.sku_id,
      stock.stock_quantity
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    join public.warehouse_skus stock
      on stock.id = reservation.warehouse_sku_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
    order by reservation.id
  loop
    select *
      into v_stock
    from public.warehouse_skus stock
    where stock.id = v_release.warehouse_sku_id;

    update public.warehouse_skus
    set
      stock_quantity = stock_quantity + v_release.quantity,
      updated_at = now()
    where id = v_release.warehouse_sku_id
    returning * into v_next_stock;

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      owner_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      purchase_order_id,
      purchase_package_id
    )
    values (
      v_release.warehouse_id,
      v_release.sku_id,
      v_release.owner_id,
      v_stock.stock_quantity,
      v_next_stock.stock_quantity,
      v_release.quantity,
      v_reason,
      null,
      null
    );

    update public.temu_order_sku_inventory_reservations
    set
      released_at = now(),
      released_reason = v_reason
    where id = v_release.id;

    v_changes := v_changes || jsonb_build_object(
      'sku', to_jsonb(v_next_stock),
      'previous_quantity', v_stock.stock_quantity,
      'change_quantity', v_release.quantity
    );
  end loop;

  update public.temu_order_shipments
  set
    warehouse_id = null,
    warehouse_name = '',
    logistics_method_id = null,
    logistics_method = ''
  where id = p_shipment_id;

  return jsonb_build_object(
    'shipment_id', p_shipment_id,
    'status', 'released',
    'changes', v_changes
  );
end
$$;

revoke all on function public.release_temu_order_shipment_inventory(uuid, text) from public;
grant execute on function public.release_temu_order_shipment_inventory(uuid, text) to authenticated;

create or replace function public.update_temu_order_shipment(
  p_shipment_item_id uuid,
  p_updates jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment_id uuid;
  v_shipment public.temu_order_shipments%rowtype;
  v_actual_fee numeric;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能更新包裹。'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_updates) <> 'object' then
    raise exception '包裹更新数据格式不正确。' using errcode = '22023';
  end if;

  if p_updates ?| array[
    'warehouse_id',
    'warehouse_name',
    'logistics_method_id',
    'logistics_method'
  ] then
    raise exception '仓库和尾程发货方式必须通过包裹分配事务修改。'
      using errcode = '22023';
  end if;

  select item.shipment_id
    into v_shipment_id
  from public.temu_order_shipment_items item
  where item.id = p_shipment_item_id;

  if v_shipment_id is null then
    raise exception '包裹商品不存在。' using errcode = 'P0002';
  end if;

  if p_updates ? 'actual_shipping_fee_rmb' then
    v_actual_fee := (p_updates ->> 'actual_shipping_fee_rmb')::numeric;
    if v_actual_fee < 0 then
      raise exception '实际运费不能小于 0。' using errcode = '22023';
    end if;
  end if;

  update public.temu_order_shipments shipment
  set
    order_status = case
      when p_updates ? 'order_status'
        then coalesce(p_updates ->> 'order_status', '')
      else shipment.order_status
    end,
    label_printed_at = case
      when p_updates ? 'label_printed_at'
        then coalesce(p_updates ->> 'label_printed_at', '')
      else shipment.label_printed_at
    end,
    logistics_tracking_no = case
      when p_updates ? 'logistics_tracking_no'
        then coalesce(p_updates ->> 'logistics_tracking_no', '')
      else shipment.logistics_tracking_no
    end,
    logistics_status = case
      when p_updates ? 'logistics_status'
        then coalesce(p_updates ->> 'logistics_status', '')
      else shipment.logistics_status
    end,
    actual_ship_time = case
      when p_updates ? 'actual_ship_time'
        then coalesce(p_updates ->> 'actual_ship_time', '')
      else shipment.actual_ship_time
    end,
    actual_signed_time = case
      when p_updates ? 'actual_signed_time'
        then coalesce(p_updates ->> 'actual_signed_time', '')
      else shipment.actual_signed_time
    end,
    actual_shipping_fee_rmb = case
      when p_updates ? 'actual_shipping_fee_rmb'
        then v_actual_fee
      else shipment.actual_shipping_fee_rmb
    end
  where shipment.id = v_shipment_id
  returning * into v_shipment;

  return to_jsonb(v_shipment);
end
$$;

revoke all on function public.update_temu_order_shipment(uuid, jsonb) from public;
grant execute on function public.update_temu_order_shipment(uuid, jsonb) to authenticated;

create or replace function public.correct_temu_order_shipment_logistics_method(
  p_shipment_item_id uuid,
  p_logistics_method_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment public.temu_order_shipments%rowtype;
  v_method public.logistics_methods%rowtype;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能修正物流方式。'
      using errcode = '42501';
  end if;

  select shipment.*
    into v_shipment
  from public.temu_order_shipment_items item
  join public.temu_order_shipments shipment on shipment.id = item.shipment_id
  where item.id = p_shipment_item_id
  for update of shipment;

  if not found then
    raise exception '包裹不存在。' using errcode = 'P0002';
  end if;

  select *
    into v_method
  from public.logistics_methods method
  where method.id = p_logistics_method_id
    and method.is_active = true;

  if not found then
    raise exception '物流方式不存在或已停用。' using errcode = '23503';
  end if;

  if v_shipment.warehouse_id is null or not exists (
    select 1
    from public.warehouse_logistics_methods mapping
    where mapping.warehouse_id = v_shipment.warehouse_id
      and mapping.logistics_method_id = p_logistics_method_id
  ) then
    raise exception '该物流方式没有绑定到包裹当前仓库。' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.pricing_settings setting
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(setting.last_leg_methods) = 'array'
          then setting.last_leg_methods
        else '[]'::jsonb
      end
    ) configured
    where lower(coalesce(configured ->> 'type', 'last_leg')) = 'last_leg'
      and lower(coalesce(configured ->> 'isActive', 'true')) <> 'false'
      and (
        configured ->> 'db_method_id' = p_logistics_method_id::text
        or public.logistics_method_match_key(configured ->> 'name')
          = public.logistics_method_match_key(v_method.name)
      )
  ) then
    raise exception '所选物流方式不是当前启用的尾程发货方式。'
      using errcode = '23514';
  end if;

  update public.temu_order_shipments
  set
    logistics_method_id = v_method.id,
    logistics_method = v_method.name
  where id = v_shipment.id
  returning * into v_shipment;

  return to_jsonb(v_shipment);
end
$$;

revoke all on function public.correct_temu_order_shipment_logistics_method(uuid, uuid) from public;
grant execute on function public.correct_temu_order_shipment_logistics_method(uuid, uuid) to authenticated;

create or replace view public.temu_order_fulfillment_lines
with (security_invoker = true)
as
select
  item.id,
  source.owner_id,
  source.order_no,
  source.sub_order_no,
  shipment.order_status,
  source.sku_code,
  shipment.warehouse_id,
  shipment.warehouse_name,
  shipment.logistics_method_id,
  shipment.logistics_method,
  shipment.label_printed_at,
  shipment.logistics_tracking_no,
  shipment.logistics_status,
  shipment.logistics_status_detail,
  shipment.tracking_category,
  shipment.tracking_event_time,
  shipment.tracking_last_checked_at,
  shipment.tracking_last_query_error,
  shipment.tracking_last_query_error_at,
  shipment.tracking_is_exception,
  shipment.tracking_exception_reason,
  shipment.tracking_exception_fingerprint,
  shipment.tracking_exception_handled_at,
  shipment.tracking_exception_handled_by,
  item.quantity as fulfillment_quantity,
  source.product_attributes,
  source.recipient_name,
  source.recipient_phone,
  source.email,
  source.province,
  source.city,
  source.district,
  source.address_line1,
  source.address_line2,
  source.postal_code,
  source.latest_ship_time,
  shipment.actual_ship_time,
  source.estimated_delivery_time,
  shipment.actual_signed_time,
  shipment.actual_shipping_fee_rmb,
  source.created_at,
  greatest(source.updated_at, shipment.updated_at, item.updated_at) as updated_at,
  source.id as source_order_id,
  shipment.id as shipment_id,
  item.id as shipment_item_id,
  shipment.package_sequence,
  package_summary.package_count,
  package_summary.package_count > 1 as is_split,
  public.temu_order_shipment_stage(shipment) as shipment_stage
from public.temu_order_shipment_items item
join public.temu_order_shipments shipment
  on shipment.id = item.shipment_id
join public.temu_orders source
  on source.id = item.order_id
join lateral (
  select count(*)::integer as package_count
  from public.temu_order_shipments sibling
  where lower(btrim(sibling.order_no)) = lower(btrim(shipment.order_no))
) package_summary on true;

grant select on table public.temu_order_fulfillment_lines to authenticated;

create or replace function public.sync_temu_order_source_fulfillment_summary()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_no text;
  v_order_key text;
  v_label_printed_at text;
  v_actual_ship_time text;
  v_actual_signed_time text;
begin
  if tg_op = 'DELETE' then
    v_order_no := old.order_no;
  else
    v_order_no := new.order_no;
  end if;
  v_order_key := lower(btrim(coalesce(v_order_no, '')));

  if v_order_key = '' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select
    coalesce(min(nullif(btrim(shipment.label_printed_at), '')), ''),
    coalesce(min(nullif(btrim(shipment.actual_ship_time), '')), ''),
    case
      when count(*) > 0
        and bool_and(btrim(shipment.actual_signed_time) <> '')
        then coalesce(max(nullif(btrim(shipment.actual_signed_time), '')), '')
      else ''
    end
  into
    v_label_printed_at,
    v_actual_ship_time,
    v_actual_signed_time
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key;

  update public.temu_orders source
  set
    label_printed_at = v_label_printed_at,
    actual_ship_time = v_actual_ship_time,
    actual_signed_time = v_actual_signed_time
  where lower(btrim(source.order_no)) = v_order_key
    and (
      source.label_printed_at is distinct from v_label_printed_at
      or source.actual_ship_time is distinct from v_actual_ship_time
      or source.actual_signed_time is distinct from v_actual_signed_time
    );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function public.sync_temu_order_source_fulfillment_summary() from public;

create trigger temu_order_shipments_sync_source_summary
  after insert or update of label_printed_at, actual_ship_time, actual_signed_time
    or delete
  on public.temu_order_shipments
  for each row execute function public.sync_temu_order_source_fulfillment_summary();

create or replace function public.delete_temu_order_group(
  p_shipment_item_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_no text;
  v_order_key text;
  v_release record;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_changes jsonb := '[]'::jsonb;
begin
  if not public.current_account_can_delete() then
    raise exception '当前账号没有删除权限。' using errcode = '42501';
  end if;

  select shipment.order_no
    into v_order_no
  from public.temu_order_shipment_items item
  join public.temu_order_shipments shipment on shipment.id = item.shipment_id
  where item.id = p_shipment_item_id;

  if v_order_no is null then
    raise exception '订单不存在。' using errcode = 'P0002';
  end if;
  v_order_key := lower(btrim(v_order_no));

  perform source.id
  from public.temu_orders source
  where lower(btrim(source.order_no)) = v_order_key
  order by source.id
  for update;

  perform shipment.id
  from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key
  order by shipment.id
  for update;

  if exists (
    select 1
    from public.temu_order_shipments shipment
    where lower(btrim(shipment.order_no)) = v_order_key
      and public.temu_order_shipment_stage(shipment) = 'completed'
  ) then
    raise exception '已完成订单不能删除。' using errcode = '55000';
  end if;

  perform stock.id
  from public.warehouse_skus stock
  where stock.id in (
    select reservation.warehouse_sku_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    join public.temu_order_shipments shipment
      on shipment.id = item.shipment_id
    where lower(btrim(shipment.order_no)) = v_order_key
      and reservation.released_at is null
  )
  order by stock.id
  for update;

  for v_release in
    select
      reservation.*,
      stock.warehouse_id,
      stock.sku_id,
      stock.stock_quantity
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    join public.temu_order_shipments shipment
      on shipment.id = item.shipment_id
    join public.warehouse_skus stock
      on stock.id = reservation.warehouse_sku_id
    where lower(btrim(shipment.order_no)) = v_order_key
      and reservation.released_at is null
    order by reservation.id
  loop
    select *
      into v_stock
    from public.warehouse_skus stock
    where stock.id = v_release.warehouse_sku_id;

    update public.warehouse_skus
    set
      stock_quantity = stock_quantity + v_release.quantity,
      updated_at = now()
    where id = v_release.warehouse_sku_id
    returning * into v_next_stock;

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      owner_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      purchase_order_id,
      purchase_package_id
    )
    values (
      v_release.warehouse_id,
      v_release.sku_id,
      v_release.owner_id,
      v_stock.stock_quantity,
      v_next_stock.stock_quantity,
      v_release.quantity,
      '删除订单释放库存：' || v_order_no,
      null,
      null
    );

    update public.temu_order_sku_inventory_reservations
    set
      released_at = now(),
      released_reason = '删除订单释放库存'
    where id = v_release.id;

    v_changes := v_changes || jsonb_build_object(
      'sku', to_jsonb(v_next_stock),
      'previous_quantity', v_stock.stock_quantity,
      'change_quantity', v_release.quantity
    );
  end loop;

  delete from public.temu_order_shipments shipment
  where lower(btrim(shipment.order_no)) = v_order_key;

  delete from public.temu_orders source
  where lower(btrim(source.order_no)) = v_order_key;

  return jsonb_build_object(
    'deleted_order_no', v_order_no,
    'released_changes', v_changes
  );
end
$$;

revoke all on function public.delete_temu_order_group(uuid) from public;
grant execute on function public.delete_temu_order_group(uuid) to authenticated;
