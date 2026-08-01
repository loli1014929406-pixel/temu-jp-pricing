-- Model combined delivery as a physical parcel that references multiple existing
-- unsplit Temu shipments. Original order and sub-order identities stay intact.

create table public.temu_order_combined_shipments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  combined_no text not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (combined_no)
);

create table public.temu_order_combined_shipment_members (
  id uuid primary key default gen_random_uuid(),
  combined_shipment_id uuid not null
    references public.temu_order_combined_shipments(id) on delete cascade,
  shipment_id uuid not null
    references public.temu_order_shipments(id) on delete restrict,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  member_sequence integer not null check (member_sequence > 0),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shipment_id),
  unique (combined_shipment_id, member_sequence)
);

create unique index temu_order_combined_shipments_no_key
  on public.temu_order_combined_shipments (lower(btrim(combined_no)));

create index temu_order_combined_shipments_owner_idx
  on public.temu_order_combined_shipments (owner_id, created_at desc);

create index temu_order_combined_members_group_idx
  on public.temu_order_combined_shipment_members (
    combined_shipment_id,
    member_sequence,
    shipment_id
  );

create index temu_order_combined_members_owner_idx
  on public.temu_order_combined_shipment_members (owner_id);

create unique index temu_order_combined_members_primary_uidx
  on public.temu_order_combined_shipment_members (combined_shipment_id)
  where is_primary = true;

grant select, insert, update, delete
  on table public.temu_order_combined_shipments
  to authenticated;

grant select, insert, update, delete
  on table public.temu_order_combined_shipment_members
  to authenticated;

alter table public.temu_order_combined_shipments enable row level security;
alter table public.temu_order_combined_shipment_members enable row level security;

create policy "temu_order_combined_shipments_select_team"
  on public.temu_order_combined_shipments for select to authenticated
  using ((select public.current_account_has_permission()));

create policy "temu_order_combined_shipments_insert_team"
  on public.temu_order_combined_shipments for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select public.current_account_can_edit())
  );

create policy "temu_order_combined_shipments_update_team"
  on public.temu_order_combined_shipments for update to authenticated
  using ((select public.current_account_can_edit()))
  with check ((select public.current_account_can_edit()));

create policy "temu_order_combined_shipments_delete_team"
  on public.temu_order_combined_shipments for delete to authenticated
  using ((select public.current_account_can_edit()));

create policy "temu_order_combined_members_select_team"
  on public.temu_order_combined_shipment_members for select to authenticated
  using ((select public.current_account_has_permission()));

create policy "temu_order_combined_members_insert_team"
  on public.temu_order_combined_shipment_members for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select public.current_account_can_edit())
  );

create policy "temu_order_combined_members_update_team"
  on public.temu_order_combined_shipment_members for update to authenticated
  using ((select public.current_account_can_edit()))
  with check ((select public.current_account_can_edit()));

create policy "temu_order_combined_members_delete_team"
  on public.temu_order_combined_shipment_members for delete to authenticated
  using ((select public.current_account_can_edit()));

create trigger temu_order_combined_shipments_set_updated_at
  before update on public.temu_order_combined_shipments
  for each row execute function public.set_updated_at();

create trigger temu_order_combined_members_set_updated_at
  before update on public.temu_order_combined_shipment_members
  for each row execute function public.set_updated_at();

create trigger temu_order_combined_shipments_prevent_owner_change
  before update on public.temu_order_combined_shipments
  for each row execute function public.prevent_operational_owner_change();

create trigger temu_order_combined_members_prevent_owner_change
  before update on public.temu_order_combined_shipment_members
  for each row execute function public.prevent_operational_owner_change();

create or replace function public.combine_temu_order_shipments(
  p_shipment_ids uuid[],
  p_primary_shipment_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment_ids uuid[];
  v_group_id uuid;
  v_combined_no text;
  v_member_count integer;
  v_address_count integer;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能合并包裹。'
      using errcode = '42501';
  end if;

  select array_agg(distinct shipment_id order by shipment_id)
    into v_shipment_ids
  from unnest(coalesce(p_shipment_ids, array[]::uuid[])) shipment_id;

  v_member_count := coalesce(array_length(v_shipment_ids, 1), 0);
  if v_member_count < 2 then
    raise exception '合并发货至少需要选择 2 个不同订单。'
      using errcode = '22023';
  end if;

  if p_primary_shipment_id is null
     or not (p_primary_shipment_id = any(v_shipment_ids)) then
    raise exception '主订单必须属于本次合并包裹。' using errcode = '22023';
  end if;

  perform shipment.id
  from public.temu_order_shipments shipment
  where shipment.id = any(v_shipment_ids)
  order by shipment.id
  for update;

  if (
    select count(*)
    from public.temu_order_shipments shipment
    where shipment.id = any(v_shipment_ids)
  ) <> v_member_count then
    raise exception '所选订单包裹不存在或已经变化，请刷新后重试。'
      using errcode = 'P0002';
  end if;

  if (
    select count(distinct lower(btrim(shipment.order_no)))
    from public.temu_order_shipments shipment
    where shipment.id = any(v_shipment_ids)
  ) <> v_member_count then
    raise exception '合并发货只能选择不同的原始订单。'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.temu_order_shipments shipment
    where shipment.id = any(v_shipment_ids)
      and (
        public.temu_order_shipment_stage(shipment) <> 'pending_assignment'
        or shipment.warehouse_id is not null
        or shipment.logistics_method_id is not null
        or btrim(shipment.warehouse_name) <> ''
        or btrim(shipment.logistics_method) <> ''
        or btrim(shipment.label_printed_at) <> ''
        or btrim(shipment.logistics_tracking_no) <> ''
        or btrim(shipment.actual_ship_time) <> ''
        or btrim(shipment.actual_signed_time) <> ''
        or shipment.actual_shipping_fee_rmb <> 0
      )
  ) then
    raise exception '只有待分配且未设置履约信息的订单可以合并发货。'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.temu_order_shipments shipment
    where shipment.id = any(v_shipment_ids)
      and (
        select count(*)
        from public.temu_order_shipments sibling
        where lower(btrim(sibling.order_no)) = lower(btrim(shipment.order_no))
      ) <> 1
  ) then
    raise exception '拆包订单不能参与合并发货。' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.temu_order_combined_shipment_members member
    where member.shipment_id = any(v_shipment_ids)
  ) then
    raise exception '所选订单已经属于其他合并包裹。' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    where item.shipment_id = any(v_shipment_ids)
      and reservation.released_at is null
  ) then
    raise exception '已有库存占用的订单不能合并发货。' using errcode = '55000';
  end if;

  select count(distinct jsonb_build_array(
    lower(btrim(source.recipient_name)),
    btrim(source.recipient_phone),
    btrim(source.postal_code),
    lower(btrim(source.province)),
    lower(btrim(source.city)),
    lower(btrim(source.district)),
    lower(btrim(source.address_line1)),
    lower(btrim(source.address_line2))
  ))
    into v_address_count
  from public.temu_order_shipment_items item
  join public.temu_orders source on source.id = item.order_id
  where item.shipment_id = any(v_shipment_ids);

  if v_address_count <> 1 then
    raise exception '合并发货要求收件人、电话、邮编和完整地址完全一致。'
      using errcode = '23514';
  end if;

  v_combined_no := 'MC-' || to_char(now(), 'YYYYMMDD') || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  insert into public.temu_order_combined_shipments (
    owner_id,
    combined_no,
    created_by
  )
  values (auth.uid(), v_combined_no, auth.uid())
  returning id into v_group_id;

  insert into public.temu_order_combined_shipment_members (
    combined_shipment_id,
    shipment_id,
    owner_id,
    member_sequence,
    is_primary
  )
  select
    v_group_id,
    shipment.id,
    auth.uid(),
    row_number() over (order by shipment.created_at, shipment.id),
    shipment.id = p_primary_shipment_id
  from public.temu_order_shipments shipment
  where shipment.id = any(v_shipment_ids)
  order by shipment.created_at, shipment.id;

  return jsonb_build_object(
    'combined_shipment_id', v_group_id,
    'combined_shipment_no', v_combined_no,
    'primary_shipment_id', p_primary_shipment_id,
    'member_count', v_member_count
  );
end
$$;

revoke all on function public.combine_temu_order_shipments(uuid[], uuid) from public;
grant execute on function public.combine_temu_order_shipments(uuid[], uuid) to authenticated;

create or replace function public.cancel_temu_combined_shipment(
  p_combined_shipment_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_combined_no text;
  v_shipment_ids uuid[];
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能取消合并包裹。'
      using errcode = '42501';
  end if;

  select combined.combined_no
    into v_combined_no
  from public.temu_order_combined_shipments combined
  where combined.id = p_combined_shipment_id
  for update;

  if not found then
    raise exception '合并包裹不存在。' using errcode = 'P0002';
  end if;

  select array_agg(member.shipment_id order by member.shipment_id)
    into v_shipment_ids
  from public.temu_order_combined_shipment_members member
  where member.combined_shipment_id = p_combined_shipment_id;

  perform shipment.id
  from public.temu_order_shipments shipment
  where shipment.id = any(v_shipment_ids)
  order by shipment.id
  for update;

  if exists (
    select 1
    from public.temu_order_shipments shipment
    where shipment.id = any(v_shipment_ids)
      and (
        public.temu_order_shipment_stage(shipment) <> 'pending_assignment'
        or shipment.warehouse_id is not null
        or shipment.logistics_method_id is not null
        or btrim(shipment.label_printed_at) <> ''
        or btrim(shipment.logistics_tracking_no) <> ''
        or btrim(shipment.actual_ship_time) <> ''
        or btrim(shipment.actual_signed_time) <> ''
        or shipment.actual_shipping_fee_rmb <> 0
      )
  ) or exists (
    select 1
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    where item.shipment_id = any(v_shipment_ids)
      and reservation.released_at is null
  ) then
    raise exception '合并包裹只有在全部成员仍为待分配时才能取消。'
      using errcode = '55000';
  end if;

  delete from public.temu_order_combined_shipments
  where id = p_combined_shipment_id;

  return jsonb_build_object(
    'combined_shipment_id', p_combined_shipment_id,
    'combined_shipment_no', v_combined_no,
    'shipment_ids', to_jsonb(v_shipment_ids)
  );
end
$$;

revoke all on function public.cancel_temu_combined_shipment(uuid) from public;
grant execute on function public.cancel_temu_combined_shipment(uuid) to authenticated;

create or replace function public.assign_temu_combined_shipment(
  p_combined_shipment_id uuid,
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
  v_member record;
  v_member_reservations jsonb;
  v_result jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_item_count integer;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能分配合并包裹。'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_reservations) <> 'array' then
    raise exception '库存分配数据格式不正确。' using errcode = '22023';
  end if;

  perform combined.id
  from public.temu_order_combined_shipments combined
  where combined.id = p_combined_shipment_id
  for update;

  if not found then
    raise exception '合并包裹不存在。' using errcode = 'P0002';
  end if;

  perform shipment.id
  from public.temu_order_combined_shipment_members member
  join public.temu_order_shipments shipment on shipment.id = member.shipment_id
  where member.combined_shipment_id = p_combined_shipment_id
  order by shipment.id
  for update of shipment;

  select count(*)
    into v_item_count
  from public.temu_order_combined_shipment_members member
  join public.temu_order_shipment_items item on item.shipment_id = member.shipment_id
  where member.combined_shipment_id = p_combined_shipment_id;

  if jsonb_array_length(p_reservations) <> v_item_count then
    raise exception '库存分配必须覆盖合并包裹内的全部商品。'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_reservations) allocation
    left join public.temu_order_shipment_items item
      on item.id = (allocation ->> 'shipment_item_id')::uuid
    left join public.temu_order_combined_shipment_members member
      on member.shipment_id = item.shipment_id
     and member.combined_shipment_id = p_combined_shipment_id
    where jsonb_typeof(allocation) <> 'object'
       or coalesce(allocation ->> 'shipment_item_id', '') = ''
       or coalesce(allocation ->> 'warehouse_sku_id', '') = ''
       or member.id is null
  ) or exists (
    select 1
    from jsonb_array_elements(p_reservations) allocation
    group by allocation ->> 'shipment_item_id'
    having count(*) > 1
  ) then
    raise exception '合并包裹库存分配数据不完整或重复。'
      using errcode = '22023';
  end if;

  for v_member in
    select member.shipment_id
    from public.temu_order_combined_shipment_members member
    where member.combined_shipment_id = p_combined_shipment_id
    order by member.shipment_id
  loop
    select coalesce(jsonb_agg(allocation), '[]'::jsonb)
      into v_member_reservations
    from jsonb_array_elements(p_reservations) allocation
    join public.temu_order_shipment_items item
      on item.id = (allocation ->> 'shipment_item_id')::uuid
    where item.shipment_id = v_member.shipment_id;

    v_result := public.assign_temu_order_shipment(
      v_member.shipment_id,
      p_warehouse_id,
      p_logistics_method_id,
      v_member_reservations,
      coalesce(nullif(btrim(p_reason), ''), '合并包裹库存占用')
    );
    v_changes := v_changes || coalesce(v_result -> 'changes', '[]'::jsonb);
  end loop;

  return jsonb_build_object(
    'combined_shipment_id', p_combined_shipment_id,
    'status', 'assigned',
    'changes', v_changes
  );
end
$$;

revoke all on function public.assign_temu_combined_shipment(uuid, uuid, uuid, jsonb, text) from public;
grant execute on function public.assign_temu_combined_shipment(uuid, uuid, uuid, jsonb, text) to authenticated;

create or replace function public.release_temu_combined_shipment_inventory(
  p_combined_shipment_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_member record;
  v_result jsonb;
  v_changes jsonb := '[]'::jsonb;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能释放合并包裹库存。'
      using errcode = '42501';
  end if;

  perform combined.id
  from public.temu_order_combined_shipments combined
  where combined.id = p_combined_shipment_id
  for update;

  if not found then
    raise exception '合并包裹不存在。' using errcode = 'P0002';
  end if;

  for v_member in
    select member.shipment_id
    from public.temu_order_combined_shipment_members member
    where member.combined_shipment_id = p_combined_shipment_id
    order by member.shipment_id
  loop
    v_result := public.release_temu_order_shipment_inventory(
      v_member.shipment_id,
      coalesce(nullif(btrim(p_reason), ''), '合并包裹退回待分配')
    );
    v_changes := v_changes || coalesce(v_result -> 'changes', '[]'::jsonb);
  end loop;

  return jsonb_build_object(
    'combined_shipment_id', p_combined_shipment_id,
    'status', 'released',
    'changes', v_changes
  );
end
$$;

revoke all on function public.release_temu_combined_shipment_inventory(uuid, text) from public;
grant execute on function public.release_temu_combined_shipment_inventory(uuid, text) to authenticated;

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
  v_combined_shipment_id uuid;
  v_primary_shipment_id uuid;
  v_actual_fee numeric;
  v_shipment public.temu_order_shipments%rowtype;
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

  select member.combined_shipment_id
    into v_combined_shipment_id
  from public.temu_order_combined_shipment_members member
  where member.shipment_id = v_shipment_id;

  if v_combined_shipment_id is not null then
    select member.shipment_id
      into v_primary_shipment_id
    from public.temu_order_combined_shipment_members member
    where member.combined_shipment_id = v_combined_shipment_id
      and member.is_primary = true;
  else
    v_primary_shipment_id := v_shipment_id;
  end if;

  if p_updates ? 'actual_shipping_fee_rmb' then
    v_actual_fee := (p_updates ->> 'actual_shipping_fee_rmb')::numeric;
    if v_actual_fee < 0 then
      raise exception '实际运费不能小于 0。' using errcode = '22023';
    end if;
  end if;

  perform shipment.id
  from public.temu_order_shipments shipment
  where shipment.id = v_shipment_id
     or shipment.id in (
       select member.shipment_id
       from public.temu_order_combined_shipment_members member
       where member.combined_shipment_id = v_combined_shipment_id
     )
  order by shipment.id
  for update;

  update public.temu_order_shipments shipment
  set
    order_status = case
      when p_updates ? 'order_status' then coalesce(p_updates ->> 'order_status', '')
      else shipment.order_status
    end,
    label_printed_at = case
      when p_updates ? 'label_printed_at' then coalesce(p_updates ->> 'label_printed_at', '')
      else shipment.label_printed_at
    end,
    logistics_tracking_no = case
      when p_updates ? 'logistics_tracking_no' then coalesce(p_updates ->> 'logistics_tracking_no', '')
      else shipment.logistics_tracking_no
    end,
    logistics_status = case
      when p_updates ? 'logistics_status' then coalesce(p_updates ->> 'logistics_status', '')
      else shipment.logistics_status
    end,
    actual_ship_time = case
      when p_updates ? 'actual_ship_time' then coalesce(p_updates ->> 'actual_ship_time', '')
      else shipment.actual_ship_time
    end,
    actual_signed_time = case
      when p_updates ? 'actual_signed_time' then coalesce(p_updates ->> 'actual_signed_time', '')
      else shipment.actual_signed_time
    end,
    actual_shipping_fee_rmb = case
      when p_updates ? 'actual_shipping_fee_rmb' and shipment.id = v_primary_shipment_id
        then v_actual_fee
      when p_updates ? 'actual_shipping_fee_rmb' then 0
      else shipment.actual_shipping_fee_rmb
    end
  where shipment.id = v_shipment_id
     or shipment.id in (
       select member.shipment_id
       from public.temu_order_combined_shipment_members member
       where member.combined_shipment_id = v_combined_shipment_id
     );

  select *
    into v_shipment
  from public.temu_order_shipments shipment
  where shipment.id = v_shipment_id;

  return to_jsonb(v_shipment);
end
$$;

revoke all on function public.update_temu_order_shipment(uuid, jsonb) from public;
grant execute on function public.update_temu_order_shipment(uuid, jsonb) to authenticated;

create or replace function public.validate_temu_order_tracking_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_combined_shipment_id uuid;
begin
  if new.logistics_method_id is null or btrim(new.logistics_tracking_no) = '' then
    return new;
  end if;

  select member.combined_shipment_id
    into v_combined_shipment_id
  from public.temu_order_combined_shipment_members member
  where member.shipment_id = new.id;

  if exists (
    select 1
    from public.temu_order_shipments other
    left join public.temu_order_combined_shipment_members other_member
      on other_member.shipment_id = other.id
    where other.id <> new.id
      and other.logistics_method_id = new.logistics_method_id
      and lower(btrim(other.logistics_tracking_no)) = lower(btrim(new.logistics_tracking_no))
      and (
        v_combined_shipment_id is null
        or other_member.combined_shipment_id is distinct from v_combined_shipment_id
      )
  ) then
    raise exception '相同物流方式和物流单号只能属于同一个已确认的合并包裹。'
      using errcode = '23505';
  end if;

  return new;
end
$$;

revoke all on function public.validate_temu_order_tracking_identity() from public;

create trigger temu_order_shipments_validate_tracking_identity
  before insert or update of logistics_method_id, logistics_tracking_no
  on public.temu_order_shipments
  for each row execute function public.validate_temu_order_tracking_identity();

create or replace function public.prevent_combined_shipment_member_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.temu_order_combined_shipment_members member
    where member.shipment_id = old.id
  ) then
    raise exception '该订单属于合并包裹，请先在待分配阶段取消合并。'
      using errcode = '55000';
  end if;
  return old;
end
$$;

revoke all on function public.prevent_combined_shipment_member_delete() from public;

create trigger temu_order_shipments_prevent_combined_member_delete
  before delete on public.temu_order_shipments
  for each row execute function public.prevent_combined_shipment_member_delete();

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
  greatest(
    source.updated_at,
    shipment.updated_at,
    item.updated_at,
    combined.updated_at,
    combined_member.updated_at
  ) as updated_at,
  source.id as source_order_id,
  shipment.id as shipment_id,
  item.id as shipment_item_id,
  shipment.package_sequence,
  package_summary.package_count,
  package_summary.package_count > 1 as is_split,
  public.temu_order_shipment_stage(shipment) as shipment_stage,
  combined.id as combined_shipment_id,
  coalesce(combined.combined_no, '') as combined_shipment_no,
  primary_member.shipment_id as combined_primary_shipment_id,
  coalesce(primary_shipment.order_no, '') as combined_primary_order_no,
  coalesce(combined_summary.member_count, 0) as combined_member_count,
  coalesce(combined_member.is_primary, false) as combined_is_primary,
  combined.id is not null as is_combined_shipment
from public.temu_order_shipment_items item
join public.temu_order_shipments shipment
  on shipment.id = item.shipment_id
join public.temu_orders source
  on source.id = item.order_id
left join public.temu_order_combined_shipment_members combined_member
  on combined_member.shipment_id = shipment.id
left join public.temu_order_combined_shipments combined
  on combined.id = combined_member.combined_shipment_id
left join public.temu_order_combined_shipment_members primary_member
  on primary_member.combined_shipment_id = combined.id
 and primary_member.is_primary = true
left join public.temu_order_shipments primary_shipment
  on primary_shipment.id = primary_member.shipment_id
left join lateral (
  select count(*)::integer as member_count
  from public.temu_order_combined_shipment_members sibling_member
  where sibling_member.combined_shipment_id = combined.id
) combined_summary on true
join lateral (
  select count(*)::integer as package_count
  from public.temu_order_shipments sibling
  where lower(btrim(sibling.order_no)) = lower(btrim(shipment.order_no))
) package_summary on true;

grant select on table public.temu_order_fulfillment_lines to authenticated;

-- Page a confirmed combined parcel as one fulfillment unit.
create or replace function public.get_temu_orders_page(
  p_page integer default 1,
  p_page_size integer default 20,
  p_search text default '',
  p_stage text default 'all',
  p_warehouse_id uuid default null,
  p_logistics_method text default '',
  p_urgent_only boolean default false,
  p_sort_key text default 'ship_deadline',
  p_sort_direction text default 'asc',
  p_now timestamptz default now()
)
returns table (
  orders jsonb,
  total_count bigint,
  total_line_count bigint,
  stage_counts jsonb,
  urgent_unuploaded_count bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_stage text := lower(btrim(coalesce(p_stage, 'all')));
  v_sort_key text := lower(btrim(coalesce(p_sort_key, 'ship_deadline')));
  v_sort_direction text := lower(btrim(coalesce(p_sort_direction, 'asc')));
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if v_stage not in (
    'all',
    'pending_assignment',
    'new_order',
    'pending_shipping',
    'shipped',
    'uploaded_temu',
    'completed'
  ) then
    raise exception 'Invalid order stage' using errcode = '22023';
  end if;

  if v_sort_key not in (
    'ship_deadline',
    'delivery_deadline',
    'product',
    'logistics_status'
  ) then
    raise exception 'Invalid order sort key' using errcode = '22023';
  end if;

  if v_sort_direction not in ('asc', 'desc') then
    raise exception 'Invalid order sort direction' using errcode = '22023';
  end if;

  return query
  with recursive
  customer_order_lines as (
    select
      source.*,
      coalesce(nullif(lower(btrim(source.order_no)), ''), source.id::text) as original_group_key,
      case
        when phone.phone_digits like '0081%' then
          case
            when substring(phone.phone_digits from 5 for 1) = '0'
              then substring(phone.phone_digits from 5)
            else '0' || substring(phone.phone_digits from 5)
          end
        when phone.phone_digits like '81%' then
          case
            when substring(phone.phone_digits from 3 for 1) = '0'
              then substring(phone.phone_digits from 3)
            else '0' || substring(phone.phone_digits from 3)
          end
        else phone.phone_digits
      end as normalized_phone,
      lower(
        regexp_replace(
          translate(
            concat_ws(
              '',
              source.province,
              source.city,
              source.district,
              source.address_line1,
              source.address_line2
            ),
            '０１２３４５６７８９',
            '0123456789'
          ),
          '[[:space:][:punct:]]+',
          '',
          'g'
        )
      ) as normalized_address
    from public.temu_orders source
    cross join lateral (
      select regexp_replace(
        translate(coalesce(source.recipient_phone, ''), '０１２３４５６７８９', '0123456789'),
        '[^0-9]',
        '',
        'g'
      ) as phone_digits
    ) phone
  ),
  customer_orders as (
    select distinct on (line.original_group_key)
      line.original_group_key,
      lower(btrim(line.order_no)) as order_key,
      line.normalized_phone,
      line.normalized_address
    from customer_order_lines line
    order by
      line.original_group_key,
      lower(btrim(line.sku_code)),
      lower(regexp_replace(line.product_attributes, '\s+', '', 'g')),
      lower(btrim(line.sub_order_no)),
      line.id
  ),
  customer_identities as (
    select customer.original_group_key, 'phone:' || customer.normalized_phone as identity_key
    from customer_orders customer
    where customer.normalized_phone <> ''

    union all

    select customer.original_group_key, 'address:' || customer.normalized_address as identity_key
    from customer_orders customer
    where customer.normalized_address <> ''
  ),
  customer_edges as (
    select distinct
      source.original_group_key as source_key,
      target.original_group_key as target_key
    from customer_identities source
    join customer_identities target
      on target.identity_key = source.identity_key
     and target.original_group_key <> source.original_group_key
  ),
  customer_reach (root_key, member_key) as (
    select customer.original_group_key, customer.original_group_key
    from customer_orders customer

    union

    select reach.root_key, edge.target_key
    from customer_reach reach
    join customer_edges edge on edge.source_key = reach.member_key
  ),
  customer_components as (
    select
      reach.member_key as original_group_key,
      min(reach.root_key) as customer_key
    from customer_reach reach
    group by reach.member_key
  ),
  refund_orders as (
    select
      lower(btrim(record.po_number)) as order_key,
      round(sum(coalesce(record.sales_reversal, 0)), 2) as sales_reversal,
      round(sum(coalesce(record.freight_reversal, 0)), 2) as freight_reversal
    from public.finance_settlement_records record
    where btrim(record.po_number) <> ''
      and (
        coalesce(record.sales_reversal, 0) <> 0
        or coalesce(record.freight_reversal, 0) <> 0
      )
    group by lower(btrim(record.po_number))
  ),
  customer_component_summary as (
    select
      component.customer_key,
      count(*)::bigint as order_count,
      bool_or(refund.order_key is not null) as has_refund_order
    from customer_components component
    join customer_orders customer
      on customer.original_group_key = component.original_group_key
    left join refund_orders refund
      on refund.order_key = customer.order_key
    group by component.customer_key
  ),
  customer_order_signals as (
    select
      customer.original_group_key,
      case
        when refund.order_key is not null then 'refund_order'
        when summary.has_refund_order then 'refund_customer'
        when summary.order_count > 1 then 'repeat_customer'
        else 'normal'
      end as customer_history_status,
      coalesce(refund.sales_reversal, 0) as customer_sales_reversal,
      coalesce(refund.freight_reversal, 0) as customer_freight_reversal
    from customer_orders customer
    join customer_components component
      on component.original_group_key = customer.original_group_key
    join customer_component_summary summary
      on summary.customer_key = component.customer_key
    left join refund_orders refund
      on refund.order_key = customer.order_key
  ),
  base_lines as (
    select
      line.*,
      coalesce(signal.customer_history_status, 'normal') as customer_history_status,
      coalesce(signal.customer_sales_reversal, 0) as customer_sales_reversal,
      coalesce(signal.customer_freight_reversal, 0) as customer_freight_reversal,
      coalesce(line.combined_shipment_id::text, line.shipment_id::text) as group_key,
      line.shipment_stage as computed_stage,
      public.try_parse_temu_order_time(line.latest_ship_time) as ship_deadline_at,
      public.try_parse_temu_order_time(line.estimated_delivery_time) as delivery_deadline_at
    from public.temu_order_fulfillment_lines line
    left join customer_order_signals signal
      on signal.original_group_key = coalesce(
        nullif(lower(btrim(line.order_no)), ''),
        line.source_order_id::text
      )
  ),
  fulfillment_lines as (
    select line.*
    from base_lines line
    where (
      p_warehouse_id is null
      or line.warehouse_id = p_warehouse_id
      or exists (
        select 1
        from public.warehouses warehouse
        where warehouse.id = p_warehouse_id
          and lower(btrim(line.warehouse_name)) = lower(btrim(warehouse.name))
      )
    )
      and (
        btrim(coalesce(p_logistics_method, '')) = ''
        or lower(btrim(line.logistics_method)) = lower(btrim(p_logistics_method))
      )
  ),
  stage_primary as (
    select distinct on (line.group_key)
      line.group_key,
      line.computed_stage
    from fulfillment_lines line
    order by line.group_key, line.combined_is_primary desc, line.package_sequence, line.id
  ),
  stage_summary as (
    select jsonb_build_object(
      'all', count(*)::bigint,
      'pending_assignment', count(*) filter (where primary_row.computed_stage = 'pending_assignment')::bigint,
      'new_order', count(*) filter (where primary_row.computed_stage = 'new_order')::bigint,
      'pending_shipping', count(*) filter (where primary_row.computed_stage = 'pending_shipping')::bigint,
      'shipped', count(*) filter (where primary_row.computed_stage = 'shipped')::bigint,
      'uploaded_temu', count(*) filter (where primary_row.computed_stage = 'uploaded_temu')::bigint,
      'completed', count(*) filter (where primary_row.computed_stage = 'completed')::bigint
    ) as counts
    from stage_primary primary_row
  ),
  query_lines as (
    select line.*
    from fulfillment_lines line
    where (v_stage = 'all' or line.computed_stage = v_stage)
      and (
        not coalesce(p_urgent_only, false)
        or (
          line.computed_stage not in ('uploaded_temu', 'completed')
          and line.ship_deadline_at is not null
          and line.ship_deadline_at >= p_now
          and line.ship_deadline_at <= p_now + interval '12 hours'
        )
      )
      and (
        btrim(coalesce(p_search, '')) = ''
        or lower(
          line.order_no || ' ' ||
          line.combined_shipment_no || ' ' ||
          line.sub_order_no || ' ' ||
          line.order_status || ' ' ||
          line.sku_code || ' ' ||
          line.warehouse_name || ' ' ||
          line.logistics_method || ' ' ||
          line.logistics_tracking_no || ' ' ||
          line.logistics_status || ' ' ||
          line.product_attributes || ' ' ||
          line.recipient_name || ' ' ||
          line.recipient_phone || ' ' ||
          line.email || ' ' ||
          line.province || ' ' ||
          line.city || ' ' ||
          line.district || ' ' ||
          line.address_line1 || ' ' ||
          line.address_line2 || ' ' ||
          line.postal_code
        ) like '%' || lower(btrim(p_search)) || '%'
      )
  ),
  query_primary as (
    select distinct on (line.group_key)
      line.group_key,
      line.ship_deadline_at,
      line.delivery_deadline_at,
      line.logistics_status,
      line.sku_code,
      line.package_sequence,
      coalesce(
        (
          select product.product_code
          from public.product_skus sku
          join public.products product on product.id = sku.product_id
          where lower(btrim(sku.sku_code)) = lower(btrim(line.sku_code))
          order by product.product_code, sku.id
          limit 1
        ),
        nullif(line.sku_code, ''),
        '\uffff'
      ) as product_sort_value,
      case
        when btrim(line.logistics_status) = ''
          or line.logistics_status like '%待查询%' then 0
        when line.logistics_status like '%暂无轨迹%'
          or line.logistics_status like '%伝票番号未登録%' then 1
        when line.logistics_status like '%查询失败%' then 2
        when line.logistics_status like '%引受%' then 10
        when line.logistics_status like '%発送%' then 20
        when line.logistics_status like '%通過%' then 30
        when line.logistics_status like '%到着%' then 40
        when line.logistics_status like '%保管%' then 45
        when line.logistics_status like '%ご不在%' then 50
        when line.logistics_status like '%持ち出し中%'
          or line.logistics_status like '%配達中%' then 60
        when line.logistics_status like '%お届け済み%'
          or line.logistics_status like '%配達完了%'
          or line.logistics_status like '%配達済み%'
          or lower(line.logistics_status) like '%delivered%' then 70
        else 80
      end as logistics_status_rank,
      line.order_no
    from query_lines line
    order by line.group_key, line.combined_is_primary desc, line.package_sequence, line.id
  ),
  ranked_groups as (
    select
      primary_row.*,
      row_number() over (
        order by
          case when v_sort_key = 'ship_deadline' and v_sort_direction = 'asc' then primary_row.ship_deadline_at end asc nulls last,
          case when v_sort_key = 'ship_deadline' and v_sort_direction = 'desc' then primary_row.ship_deadline_at end desc nulls last,
          case when v_sort_key = 'delivery_deadline' and v_sort_direction = 'asc' then primary_row.delivery_deadline_at end asc nulls last,
          case when v_sort_key = 'delivery_deadline' and v_sort_direction = 'desc' then primary_row.delivery_deadline_at end desc nulls last,
          case when v_sort_key = 'product' and v_sort_direction = 'asc' then lower(primary_row.product_sort_value) end asc nulls last,
          case when v_sort_key = 'product' and v_sort_direction = 'desc' then lower(primary_row.product_sort_value) end desc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'asc' then primary_row.logistics_status_rank end asc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'desc' then primary_row.logistics_status_rank end desc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'asc' then lower(primary_row.logistics_status) end asc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'desc' then lower(primary_row.logistics_status) end desc nulls last,
          lower(primary_row.order_no),
          primary_row.package_sequence,
          primary_row.group_key
      ) as page_position
    from query_primary primary_row
  ),
  paged_groups as (
    select ranked.*
    from ranked_groups ranked
    where ranked.page_position > (v_page - 1) * v_page_size
      and ranked.page_position <= v_page * v_page_size
  ),
  page_payload as (
    select coalesce(
      jsonb_agg(
        to_jsonb(line)
          - 'group_key'
          - 'computed_stage'
          - 'ship_deadline_at'
          - 'delivery_deadline_at'
          - 'shipment_stage'
        order by
          page_group.page_position,
          line.combined_is_primary desc,
          lower(btrim(line.sku_code)),
          lower(regexp_replace(line.product_attributes, '\s+', '', 'g')),
          lower(btrim(line.sub_order_no)),
          line.id
      ),
      '[]'::jsonb
    ) as rows
    from paged_groups page_group
    join query_lines line on line.group_key = page_group.group_key
  ),
  urgent_primary as (
    select distinct on (line.group_key) line.group_key
    from base_lines line
    where line.computed_stage not in ('uploaded_temu', 'completed')
      and line.ship_deadline_at is not null
      and line.ship_deadline_at >= p_now
      and line.ship_deadline_at <= p_now + interval '12 hours'
    order by line.group_key
  )
  select
    page_payload.rows,
    (select count(*)::bigint from query_primary),
    (select count(*)::bigint from query_lines),
    stage_summary.counts,
    (select count(*)::bigint from urgent_primary)
  from page_payload
  cross join stage_summary;
end;
$$;

revoke all on function public.get_temu_orders_page(
  integer,
  integer,
  text,
  text,
  uuid,
  text,
  boolean,
  text,
  text,
  timestamptz
) from public;

grant execute on function public.get_temu_orders_page(
  integer,
  integer,
  text,
  text,
  uuid,
  text,
  boolean,
  text,
  text,
  timestamptz
) to authenticated;
