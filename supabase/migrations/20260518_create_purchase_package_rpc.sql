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
security definer
set search_path = public
as $$
declare
  v_owner_id uuid := auth.uid();
  v_package_id uuid := gen_random_uuid();
begin
  if v_owner_id is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1
    from public.purchase_orders
    where purchase_orders.id = p_order_id
      and purchase_orders.owner_id = v_owner_id
  ) then
    raise exception 'purchase order not found';
  end if;

  if not exists (
    select 1
    from public.purchase_order_sources
    where purchase_order_sources.id = p_source_id
      and purchase_order_sources.order_id = p_order_id
      and purchase_order_sources.owner_id = v_owner_id
  ) then
    raise exception 'purchase source not found';
  end if;

  insert into public.purchase_packages (
    id,
    order_id,
    owner_id,
    source_id,
    tracking_no
  )
  values (
    v_package_id,
    p_order_id,
    v_owner_id,
    p_source_id,
    p_tracking_no
  );

  insert into public.purchase_package_items (
    package_id,
    order_item_id,
    owner_id,
    quantity
  )
  select
    v_package_id,
    (item ->> 'order_item_id')::uuid,
    v_owner_id,
    (item ->> 'quantity')::integer
  from jsonb_array_elements(p_items) as item
  where exists (
    select 1
    from public.purchase_order_items
    where purchase_order_items.id = (item ->> 'order_item_id')::uuid
      and purchase_order_items.order_id = p_order_id
      and purchase_order_items.owner_id = v_owner_id
  );

  return query
  select
    purchase_packages.id,
    purchase_packages.order_id,
    purchase_packages.owner_id,
    purchase_packages.source_id,
    purchase_packages.tracking_no,
    purchase_packages.status,
    purchase_packages.received_at,
    purchase_packages.created_at,
    purchase_packages.updated_at
  from public.purchase_packages
  where purchase_packages.id = v_package_id;
end;
$$;

grant execute on function public.create_purchase_package(uuid, uuid, text, jsonb) to authenticated;
