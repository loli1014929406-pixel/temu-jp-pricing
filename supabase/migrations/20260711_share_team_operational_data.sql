-- All permitted accounts belong to one operating team. Operational records are
-- shared across that team; finance/user-owned tables remain isolated.

create or replace function public.prevent_operational_owner_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_operational_owner_change() from public;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'temu_orders',
    'purchase_orders',
    'purchase_order_sources',
    'purchase_order_items',
    'purchase_packages',
    'purchase_package_items'
  ]
  loop
    execute format('drop trigger if exists %I on public.%I', v_table || '_prevent_owner_change', v_table);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.prevent_operational_owner_change()',
      v_table || '_prevent_owner_change',
      v_table
    );
  end loop;
end;
$$;

-- Temu orders
drop policy if exists "temu_orders_select_own" on public.temu_orders;
drop policy if exists "temu_orders_insert_own" on public.temu_orders;
drop policy if exists "temu_orders_update_own" on public.temu_orders;
drop policy if exists "temu_orders_delete_own" on public.temu_orders;

create policy "temu_orders_select_team"
on public.temu_orders for select to authenticated
using (public.current_account_has_permission());

create policy "temu_orders_insert_team"
on public.temu_orders for insert to authenticated
with check (
  owner_id = auth.uid()
  and public.current_account_can_edit()
);

create policy "temu_orders_update_team"
on public.temu_orders for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

create policy "temu_orders_delete_team"
on public.temu_orders for delete to authenticated
using (public.current_account_can_delete());

-- Purchase management tables
drop policy if exists "purchase_orders_select_own" on public.purchase_orders;
drop policy if exists "purchase_orders_insert_own" on public.purchase_orders;
drop policy if exists "purchase_orders_update_own" on public.purchase_orders;
drop policy if exists "purchase_orders_delete_own" on public.purchase_orders;

create policy "purchase_orders_select_team"
on public.purchase_orders for select to authenticated
using (public.current_account_has_permission());
create policy "purchase_orders_insert_team"
on public.purchase_orders for insert to authenticated
with check (owner_id = auth.uid() and public.current_account_can_edit());
create policy "purchase_orders_update_team"
on public.purchase_orders for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "purchase_orders_delete_team"
on public.purchase_orders for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "purchase_order_sources_select_own" on public.purchase_order_sources;
drop policy if exists "purchase_order_sources_insert_own" on public.purchase_order_sources;
drop policy if exists "purchase_order_sources_update_own" on public.purchase_order_sources;
drop policy if exists "purchase_order_sources_delete_own" on public.purchase_order_sources;

create policy "purchase_order_sources_select_team"
on public.purchase_order_sources for select to authenticated
using (public.current_account_has_permission());
create policy "purchase_order_sources_insert_team"
on public.purchase_order_sources for insert to authenticated
with check (owner_id = auth.uid() and public.current_account_can_edit());
create policy "purchase_order_sources_update_team"
on public.purchase_order_sources for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "purchase_order_sources_delete_team"
on public.purchase_order_sources for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "purchase_order_items_select_own" on public.purchase_order_items;
drop policy if exists "purchase_order_items_insert_own" on public.purchase_order_items;
drop policy if exists "purchase_order_items_update_own" on public.purchase_order_items;
drop policy if exists "purchase_order_items_delete_own" on public.purchase_order_items;

create policy "purchase_order_items_select_team"
on public.purchase_order_items for select to authenticated
using (public.current_account_has_permission());
create policy "purchase_order_items_insert_team"
on public.purchase_order_items for insert to authenticated
with check (owner_id = auth.uid() and public.current_account_can_edit());
create policy "purchase_order_items_update_team"
on public.purchase_order_items for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "purchase_order_items_delete_team"
on public.purchase_order_items for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "purchase_packages_select_own" on public.purchase_packages;
drop policy if exists "purchase_packages_insert_own" on public.purchase_packages;
drop policy if exists "purchase_packages_update_own" on public.purchase_packages;
drop policy if exists "purchase_packages_delete_own" on public.purchase_packages;

create policy "purchase_packages_select_team"
on public.purchase_packages for select to authenticated
using (public.current_account_has_permission());
create policy "purchase_packages_insert_team"
on public.purchase_packages for insert to authenticated
with check (
  owner_id = auth.uid()
  and public.current_account_can_edit()
  and exists (
    select 1
    from public.purchase_orders purchase_order
    where purchase_order.id = purchase_packages.order_id
  )
  and exists (
    select 1
    from public.purchase_order_sources source
    where source.id = purchase_packages.source_id
      and source.order_id = purchase_packages.order_id
  )
);
create policy "purchase_packages_update_team"
on public.purchase_packages for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "purchase_packages_delete_team"
on public.purchase_packages for delete to authenticated
using (public.current_account_can_delete() and status = 'pending');

drop policy if exists "purchase_package_items_select_own" on public.purchase_package_items;
drop policy if exists "purchase_package_items_insert_own" on public.purchase_package_items;
drop policy if exists "purchase_package_items_update_own" on public.purchase_package_items;
drop policy if exists "purchase_package_items_delete_own" on public.purchase_package_items;

create policy "purchase_package_items_select_team"
on public.purchase_package_items for select to authenticated
using (public.current_account_has_permission());
create policy "purchase_package_items_insert_team"
on public.purchase_package_items for insert to authenticated
with check (
  owner_id = auth.uid()
  and public.current_account_can_edit()
  and exists (
    select 1
    from public.purchase_packages package
    join public.purchase_order_items order_item
      on order_item.id = purchase_package_items.order_item_id
    where package.id = purchase_package_items.package_id
      and package.order_id = order_item.order_id
  )
);
create policy "purchase_package_items_update_team"
on public.purchase_package_items for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "purchase_package_items_delete_team"
on public.purchase_package_items for delete to authenticated
using (public.current_account_can_delete());

-- A package created by one editor may belong to a purchase order created by
-- another team member. The invoker policies above remain the authorization layer.
create or replace function public.create_purchase_package(
  p_order_id uuid,
  p_source_id uuid,
  p_tracking_no text,
  p_items jsonb
)
returns table (
  id uuid,
  order_id uuid,
  owner_id uuid,
  source_id uuid,
  tracking_no text,
  status text,
  received_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_owner_id uuid := auth.uid();
  v_package_id uuid := gen_random_uuid();
begin
  if v_owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  if p_order_id is null or p_source_id is null or btrim(coalesce(p_tracking_no, '')) = '' then
    raise exception 'Order, source and tracking number are required' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one package item is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.purchase_orders where purchase_orders.id = p_order_id) then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1
    from public.purchase_order_sources source
    where source.id = p_source_id
      and source.order_id = p_order_id
  ) then
    raise exception 'Purchase source not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where not exists (
      select 1
      from public.purchase_order_items order_item
      where order_item.id = (item ->> 'order_item_id')::uuid
        and order_item.order_id = p_order_id
        and (item ->> 'quantity')::integer > 0
    )
  ) then
    raise exception 'Package items must belong to the purchase order and have positive quantities'
      using errcode = '22023';
  end if;

  insert into public.purchase_packages (
    id, order_id, owner_id, source_id, tracking_no
  ) values (
    v_package_id, p_order_id, v_owner_id, p_source_id, btrim(p_tracking_no)
  );

  insert into public.purchase_package_items (
    package_id, order_item_id, owner_id, quantity
  )
  select
    v_package_id,
    (item ->> 'order_item_id')::uuid,
    v_owner_id,
    (item ->> 'quantity')::integer
  from jsonb_array_elements(p_items) item;

  return query
  select
    package.id,
    package.order_id,
    package.owner_id,
    package.source_id,
    package.tracking_no,
    package.status,
    package.received_at,
    package.created_at,
    package.updated_at
  from public.purchase_packages package
  where package.id = v_package_id;
end;
$$;

revoke all on function public.create_purchase_package(uuid, uuid, text, jsonb) from public;
grant execute on function public.create_purchase_package(uuid, uuid, text, jsonb) to authenticated;

create or replace function public.update_purchase_source_atomic(
  p_source_id uuid,
  p_alibaba_order_no text,
  p_freight_rmb numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source public.purchase_order_sources%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  if p_freight_rmb is null or p_freight_rmb < 0 then
    raise exception 'Freight must be zero or greater' using errcode = '22023';
  end if;

  update public.purchase_order_sources
  set
    alibaba_order_no = coalesce(p_alibaba_order_no, ''),
    freight_rmb = p_freight_rmb
  where id = p_source_id
  returning * into v_source;

  if not found then
    raise exception 'Purchase source not found' using errcode = 'P0002';
  end if;

  update public.purchase_orders purchase_order
  set total_cost_rmb = purchase_order.items_total_rmb + (
    select coalesce(sum(source.freight_rmb), 0)
    from public.purchase_order_sources source
    where source.order_id = v_source.order_id
  )
  where purchase_order.id = v_source.order_id;

  return to_jsonb(v_source);
end;
$$;

revoke all on function public.update_purchase_source_atomic(uuid, text, numeric) from public;
grant execute on function public.update_purchase_source_atomic(uuid, text, numeric) to authenticated;

-- Team-scoped list queries no longer begin with owner_id.
create unique index if not exists idx_temu_orders_team_order_line
on public.temu_orders(order_no, sub_order_no);

create index if not exists idx_temu_orders_team_ship_created
on public.temu_orders(latest_ship_time, created_at desc, id);

create index if not exists idx_temu_orders_team_status_created
on public.temu_orders(order_status, created_at desc, id);

create index if not exists idx_purchase_orders_team_created
on public.purchase_orders(created_at desc, id);

create index if not exists idx_purchase_sources_team_order
on public.purchase_order_sources(order_id, id);

create index if not exists idx_purchase_items_team_order
on public.purchase_order_items(order_id, id);

create index if not exists idx_purchase_packages_team_order
on public.purchase_packages(order_id, id);

create index if not exists idx_purchase_package_items_team_package
on public.purchase_package_items(package_id, order_item_id);
