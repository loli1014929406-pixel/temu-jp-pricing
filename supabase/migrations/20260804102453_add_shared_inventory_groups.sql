create table public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null
    references public.enterprises(id) on delete restrict,
  code text not null,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_locations_code_not_blank check (btrim(code) <> ''),
  constraint stock_locations_name_not_blank check (btrim(name) <> ''),
  constraint stock_locations_enterprise_code_unique
    unique (enterprise_id, code),
  constraint stock_locations_enterprise_id_id_unique
    unique (enterprise_id, id)
);

alter table public.warehouses
  add column stock_location_id uuid;

create table public.shared_inventory_groups (
  id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null
    references public.enterprises(id) on delete restrict,
  code text not null,
  name text not null,
  base_unit_name text not null default '件',
  status text not null default 'active'
    check (status in ('active', 'inactive', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_inventory_groups_code_not_blank check (btrim(code) <> ''),
  constraint shared_inventory_groups_name_not_blank check (btrim(name) <> ''),
  constraint shared_inventory_groups_base_unit_not_blank
    check (btrim(base_unit_name) <> ''),
  constraint shared_inventory_groups_enterprise_code_unique
    unique (enterprise_id, code),
  constraint shared_inventory_groups_enterprise_id_id_unique
    unique (enterprise_id, id)
);

create table public.shared_inventory_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null
    references public.shared_inventory_groups(id) on delete restrict,
  enterprise_id uuid not null,
  shop_id uuid not null,
  sku_id uuid not null references public.product_skus(id) on delete restrict,
  base_units_per_sale_unit numeric(20, 6) not null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  constraint shared_inventory_group_members_positive_ratio
    check (base_units_per_sale_unit > 0),
  constraint shared_inventory_group_members_scope_fkey
    foreign key (enterprise_id, shop_id)
    references public.shops(enterprise_id, id)
    on delete restrict,
  constraint shared_inventory_group_members_group_scope_fkey
    foreign key (enterprise_id, group_id)
    references public.shared_inventory_groups(enterprise_id, id)
    on delete restrict,
  constraint shared_inventory_group_members_leave_after_join
    check (left_at is null or left_at >= joined_at)
);

create unique index shared_inventory_group_members_active_sku_idx
  on public.shared_inventory_group_members (sku_id)
  where left_at is null;
create index shared_inventory_group_members_group_active_idx
  on public.shared_inventory_group_members (group_id, shop_id)
  where left_at is null;

create table public.shared_inventory_balances (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null
    references public.shared_inventory_groups(id) on delete restrict,
  enterprise_id uuid not null,
  stock_location_id uuid not null,
  quantity_base_units bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_inventory_balances_nonnegative
    check (quantity_base_units >= 0),
  constraint shared_inventory_balances_group_scope_fkey
    foreign key (enterprise_id, group_id)
    references public.shared_inventory_groups(enterprise_id, id)
    on delete restrict,
  constraint shared_inventory_balances_location_scope_fkey
    foreign key (enterprise_id, stock_location_id)
    references public.stock_locations(enterprise_id, id)
    on delete restrict,
  constraint shared_inventory_balances_group_location_unique
    unique (group_id, stock_location_id)
);

create table public.shared_inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null,
  shop_id uuid,
  group_id uuid not null,
  group_member_id uuid,
  balance_id uuid not null
    references public.shared_inventory_balances(id) on delete restrict,
  stock_location_id uuid not null,
  sku_id uuid references public.product_skus(id) on delete restrict,
  previous_quantity_base_units bigint not null,
  next_quantity_base_units bigint not null,
  change_quantity_base_units bigint not null,
  source_kind text not null,
  source_id uuid,
  source_ref text not null default '',
  reason text not null default '',
  request_key uuid,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint shared_inventory_adjustments_arithmetic check (
    previous_quantity_base_units + change_quantity_base_units
      = next_quantity_base_units
  ),
  constraint shared_inventory_adjustments_nonnegative_next
    check (next_quantity_base_units >= 0),
  constraint shared_inventory_adjustments_source_kind check (
    source_kind in (
      'group_join',
      'group_leave',
      'order_reserve',
      'order_release',
      'purchase_receive',
      'transfer_out',
      'transfer_in',
      'manual_adjustment'
    )
  ),
  constraint shared_inventory_adjustments_group_scope_fkey
    foreign key (enterprise_id, group_id)
    references public.shared_inventory_groups(enterprise_id, id)
    on delete restrict,
  constraint shared_inventory_adjustments_location_scope_fkey
    foreign key (enterprise_id, stock_location_id)
    references public.stock_locations(enterprise_id, id)
    on delete restrict,
  constraint shared_inventory_adjustments_shop_scope_fkey
    foreign key (enterprise_id, shop_id)
    references public.shops(enterprise_id, id)
    on delete restrict
);

create index shared_inventory_adjustments_balance_created_idx
  on public.shared_inventory_adjustments (balance_id, created_at desc);
create index shared_inventory_adjustments_shop_created_idx
  on public.shared_inventory_adjustments (shop_id, created_at desc);
create index shared_inventory_adjustments_source_idx
  on public.shared_inventory_adjustments (source_kind, source_id);

create table public.shared_inventory_membership_operations (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  operation_type text not null check (operation_type in ('join', 'leave')),
  enterprise_id uuid not null,
  shop_id uuid not null,
  group_id uuid not null,
  group_member_id uuid,
  sku_id uuid not null references public.product_skus(id) on delete restrict,
  base_units_per_sale_unit numeric(20, 6) not null,
  reason text not null default '',
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint shared_inventory_membership_operations_positive_ratio
    check (base_units_per_sale_unit > 0),
  constraint shared_inventory_membership_operations_group_scope_fkey
    foreign key (enterprise_id, group_id)
    references public.shared_inventory_groups(enterprise_id, id)
    on delete restrict,
  constraint shared_inventory_membership_operations_shop_scope_fkey
    foreign key (enterprise_id, shop_id)
    references public.shops(enterprise_id, id)
    on delete restrict
);

create table public.shared_inventory_membership_operation_lines (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null
    references public.shared_inventory_membership_operations(id)
    on delete restrict,
  warehouse_sku_id uuid not null
    references public.warehouse_skus(id) on delete restrict,
  stock_location_id uuid not null
    references public.stock_locations(id) on delete restrict,
  shared_balance_id uuid not null
    references public.shared_inventory_balances(id) on delete restrict,
  sku_quantity integer not null check (sku_quantity >= 0),
  quantity_base_units bigint not null check (quantity_base_units >= 0),
  created_at timestamptz not null default now(),
  constraint shared_inventory_membership_operation_line_unique
    unique (operation_id, warehouse_sku_id)
);

alter table public.temu_order_sku_inventory_reservations
  alter column warehouse_sku_id drop not null,
  add column shared_inventory_balance_id uuid
    references public.shared_inventory_balances(id) on delete restrict,
  add column shared_inventory_group_member_id uuid
    references public.shared_inventory_group_members(id) on delete restrict,
  add column quantity_base_units bigint;

alter table public.temu_order_sku_inventory_reservations
  add constraint temu_order_inventory_reservation_target_check
  check (
    (
      warehouse_sku_id is not null
      and shared_inventory_balance_id is null
      and shared_inventory_group_member_id is null
      and quantity_base_units is null
    )
    or
    (
      warehouse_sku_id is null
      and shared_inventory_balance_id is not null
      and shared_inventory_group_member_id is not null
      and quantity_base_units > 0
    )
  ) not valid;

create index temu_order_reservations_shared_balance_idx
  on public.temu_order_sku_inventory_reservations (
    shared_inventory_balance_id,
    released_at
  )
  where shared_inventory_balance_id is not null;

create index temu_order_reservations_shared_member_idx
  on public.temu_order_sku_inventory_reservations (
    shared_inventory_group_member_id,
    released_at
  )
  where shared_inventory_group_member_id is not null;

do $block$
declare
  v_warehouse record;
  v_location_id uuid;
begin
  for v_warehouse in
    select warehouse.id, warehouse.enterprise_id, warehouse.name, warehouse.owner_id
    from public.warehouses warehouse
    order by warehouse.id
  loop
    insert into public.stock_locations (
      enterprise_id,
      code,
      name,
      created_by
    ) values (
      v_warehouse.enterprise_id,
      'legacy-' || replace(v_warehouse.id::text, '-', ''),
      v_warehouse.name,
      v_warehouse.owner_id
    )
    on conflict (enterprise_id, code) do update
    set name = excluded.name
    returning id into v_location_id;

    update public.warehouses
    set stock_location_id = v_location_id
    where id = v_warehouse.id
      and stock_location_id is null;
  end loop;
end
$block$;

alter table public.warehouses
  add constraint warehouses_stock_location_fkey
  foreign key (enterprise_id, stock_location_id)
  references public.stock_locations(enterprise_id, id)
  on delete restrict
  not valid;

drop trigger if exists stock_locations_set_updated_at
  on public.stock_locations;
create trigger stock_locations_set_updated_at
before update on public.stock_locations
for each row execute function public.set_updated_at();

drop trigger if exists shared_inventory_groups_set_updated_at
  on public.shared_inventory_groups;
create trigger shared_inventory_groups_set_updated_at
before update on public.shared_inventory_groups
for each row execute function public.set_updated_at();

drop trigger if exists shared_inventory_balances_set_updated_at
  on public.shared_inventory_balances;
create trigger shared_inventory_balances_set_updated_at
before update on public.shared_inventory_balances
for each row execute function public.set_updated_at();

alter table public.stock_locations enable row level security;
alter table public.shared_inventory_groups enable row level security;
alter table public.shared_inventory_group_members enable row level security;
alter table public.shared_inventory_balances enable row level security;
alter table public.shared_inventory_adjustments enable row level security;
alter table public.shared_inventory_membership_operations enable row level security;
alter table public.shared_inventory_membership_operation_lines enable row level security;

create policy stock_locations_select_authorized
on public.stock_locations for select to authenticated
using (private.current_user_can_view_enterprise(enterprise_id));

create policy shared_inventory_groups_select_authorized
on public.shared_inventory_groups for select to authenticated
using (private.current_user_can_view_enterprise(enterprise_id));

create policy shared_inventory_group_members_select_authorized
on public.shared_inventory_group_members for select to authenticated
using (private.current_user_can_view_shop(shop_id));

create policy shared_inventory_balances_select_authorized
on public.shared_inventory_balances for select to authenticated
using (private.current_user_can_view_enterprise(enterprise_id));

create policy shared_inventory_adjustments_select_authorized
on public.shared_inventory_adjustments for select to authenticated
using (
  case
    when shop_id is null
      then private.current_user_can_view_enterprise(enterprise_id)
    else private.current_user_can_view_shop(shop_id)
  end
);

create policy shared_inventory_membership_operations_select_authorized
on public.shared_inventory_membership_operations for select to authenticated
using (private.current_user_can_view_shop(shop_id));

create policy shared_inventory_membership_operation_lines_select_authorized
on public.shared_inventory_membership_operation_lines for select to authenticated
using (
  exists (
    select 1
    from public.shared_inventory_membership_operations operation
    where operation.id = operation_id
      and private.current_user_can_view_shop(operation.shop_id)
  )
);

revoke all on table public.stock_locations from public, anon;
revoke all on table public.shared_inventory_groups from public, anon;
revoke all on table public.shared_inventory_group_members from public, anon;
revoke all on table public.shared_inventory_balances from public, anon;
revoke all on table public.shared_inventory_adjustments from public, anon;
revoke all on table public.shared_inventory_membership_operations
  from public, anon;
revoke all on table public.shared_inventory_membership_operation_lines
  from public, anon;

grant select on table public.stock_locations to authenticated;
grant select on table public.shared_inventory_groups to authenticated;
grant select on table public.shared_inventory_group_members to authenticated;
grant select on table public.shared_inventory_balances to authenticated;
grant select on table public.shared_inventory_adjustments to authenticated;
grant select on table public.shared_inventory_membership_operations
  to authenticated;
grant select on table public.shared_inventory_membership_operation_lines
  to authenticated;
