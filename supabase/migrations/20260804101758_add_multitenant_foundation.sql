-- Multitenant foundation only. Existing business-table policies and the
-- account_permissions compatibility path remain unchanged in this phase.

create table public.enterprises (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'archived')),
  legacy_owner_id uuid references auth.users(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint enterprises_code_not_blank check (btrim(code) <> ''),
  constraint enterprises_name_not_blank check (btrim(name) <> ''),
  constraint enterprises_code_unique unique (code)
);

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null
    references public.enterprises(id) on delete restrict,
  code text not null,
  name text not null,
  platform text not null default 'temu',
  status text not null default 'active'
    check (status in ('active', 'suspended', 'archived')),
  legacy_owner_id uuid references auth.users(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shops_code_not_blank check (btrim(code) <> ''),
  constraint shops_name_not_blank check (btrim(name) <> ''),
  constraint shops_enterprise_code_unique unique (enterprise_id, code),
  constraint shops_enterprise_id_id_unique unique (enterprise_id, id)
);

create table public.platform_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.enterprise_members (
  enterprise_id uuid not null
    references public.enterprises(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role = 'enterprise_owner'),
  status text not null default 'active'
    check (status in ('active', 'suspended')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (enterprise_id, user_id),
  constraint enterprise_members_one_enterprise_per_user unique (user_id)
);

create table public.shop_operator_assignments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enterprise_id uuid not null,
  shop_id uuid not null,
  status text not null default 'active'
    check (status in ('active', 'suspended')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shop_operator_assignment_shop_fkey
    foreign key (enterprise_id, shop_id)
    references public.shops(enterprise_id, id)
    on delete restrict,
  constraint shop_operator_assignment_user_shop_unique unique (user_id, shop_id)
);

create table public.permission_catalog (
  resource text not null,
  action text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  primary key (resource, action),
  constraint permission_catalog_resource_not_blank check (btrim(resource) <> ''),
  constraint permission_catalog_action_not_blank check (btrim(action) <> '')
);

create table public.shop_operator_permissions (
  user_id uuid not null,
  shop_id uuid not null,
  resource text not null,
  action text not null,
  allowed boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, shop_id, resource, action),
  constraint shop_operator_permissions_assignment_fkey
    foreign key (user_id, shop_id)
    references public.shop_operator_assignments(user_id, shop_id)
    on delete cascade,
  constraint shop_operator_permissions_catalog_fkey
    foreign key (resource, action)
    references public.permission_catalog(resource, action)
    on delete restrict
);

-- A platform owner must explicitly enter an enterprise context before a later
-- cutover policy permits business-data writes. The context is scoped to the
-- Supabase Auth session rather than the user so separate devices do not alter
-- each other's edit scope.
create table private.user_shop_contexts (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  enterprise_id uuid not null,
  shop_id uuid,
  entered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint user_shop_contexts_shop_fkey
    foreign key (enterprise_id, shop_id)
    references public.shops(enterprise_id, id)
    on delete cascade,
  constraint user_shop_contexts_future_expiry
    check (expires_at > entered_at)
);

create table private.multitenant_runtime_state (
  id boolean primary key default true check (id),
  permission_mode text not null default 'legacy'
    check (permission_mode in ('legacy', 'tenant')),
  cutover_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into private.multitenant_runtime_state (id, permission_mode)
values (true, 'legacy')
on conflict (id) do nothing;

insert into public.permission_catalog (resource, action, description)
values
  ('products', 'view', '查看商品与 SKU'),
  ('products', 'create', '新增商品与 SKU'),
  ('products', 'update', '修改商品与 SKU'),
  ('products', 'delete', '删除商品与 SKU'),
  ('pricing', 'view', '查看核价结果'),
  ('pricing', 'update', '修改核价参数和结果'),
  ('inventory', 'view', '查看库存'),
  ('inventory', 'adjust', '调整库存'),
  ('inventory', 'transfer', '调拨和接收入库'),
  ('purchases', 'view', '查看采购'),
  ('purchases', 'create', '创建采购'),
  ('purchases', 'update', '修改采购和入库'),
  ('purchases', 'delete', '删除采购'),
  ('orders', 'view', '查看订单'),
  ('orders', 'import', '导入订单和物流数据'),
  ('orders', 'update', '修改订单'),
  ('orders', 'fulfill', '分配、拆包、合并和发货'),
  ('orders', 'delete', '删除订单'),
  ('finance', 'view', '查看财务数据'),
  ('finance', 'create', '录入费用、结算和付款'),
  ('finance', 'update', '修改财务数据'),
  ('finance', 'delete', '删除或作废财务数据'),
  ('settings', 'view', '查看店铺设置'),
  ('settings', 'update', '修改店铺设置'),
  ('shops', 'view', '查看店铺信息'),
  ('shops', 'manage', '管理店铺'),
  ('members', 'view', '查看成员和权限'),
  ('members', 'manage', '管理成员和权限'),
  ('diagnostics', 'view', '查看系统诊断')
on conflict (resource, action) do nothing;

create index enterprise_members_enterprise_status_idx
  on public.enterprise_members (enterprise_id, status);
create index shop_operator_assignments_shop_status_idx
  on public.shop_operator_assignments (shop_id, status);
create index shop_operator_assignments_enterprise_status_idx
  on public.shop_operator_assignments (enterprise_id, status);
create index shop_operator_permissions_shop_user_idx
  on public.shop_operator_permissions (shop_id, user_id)
  where allowed;
create index user_shop_contexts_user_expiry_idx
  on private.user_shop_contexts (user_id, expires_at);

drop trigger if exists enterprises_set_updated_at on public.enterprises;
create trigger enterprises_set_updated_at
before update on public.enterprises
for each row execute function public.set_updated_at();

drop trigger if exists shops_set_updated_at on public.shops;
create trigger shops_set_updated_at
before update on public.shops
for each row execute function public.set_updated_at();

drop trigger if exists enterprise_members_set_updated_at on public.enterprise_members;
create trigger enterprise_members_set_updated_at
before update on public.enterprise_members
for each row execute function public.set_updated_at();

drop trigger if exists shop_operator_assignments_set_updated_at
  on public.shop_operator_assignments;
create trigger shop_operator_assignments_set_updated_at
before update on public.shop_operator_assignments
for each row execute function public.set_updated_at();

drop trigger if exists shop_operator_permissions_set_updated_at
  on public.shop_operator_permissions;
create trigger shop_operator_permissions_set_updated_at
before update on public.shop_operator_permissions
for each row execute function public.set_updated_at();

create or replace function private.current_user_is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null
    and exists (
      select 1
      from public.platform_members member
      where member.user_id = (select auth.uid())
    )
$function$;

create or replace function private.current_user_is_enterprise_owner(
  p_enterprise_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null
    and exists (
      select 1
      from public.enterprise_members member
      where member.user_id = (select auth.uid())
        and member.enterprise_id = p_enterprise_id
        and member.role = 'enterprise_owner'
        and member.status = 'active'
    )
$function$;

create or replace function private.current_user_is_shop_operator(
  p_shop_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null
    and exists (
      select 1
      from public.shop_operator_assignments assignment
      where assignment.user_id = (select auth.uid())
        and assignment.shop_id = p_shop_id
        and assignment.status = 'active'
    )
$function$;

create or replace function private.current_user_can_view_enterprise(
  p_enterprise_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select private.current_user_is_platform_owner()
    or private.current_user_is_enterprise_owner(p_enterprise_id)
    or exists (
      select 1
      from public.shop_operator_assignments assignment
      where assignment.user_id = (select auth.uid())
        and assignment.enterprise_id = p_enterprise_id
        and assignment.status = 'active'
    )
$function$;

create or replace function private.current_user_can_view_shop(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select private.current_user_is_platform_owner()
    or exists (
      select 1
      from public.shops shop
      where shop.id = p_shop_id
        and private.current_user_is_enterprise_owner(shop.enterprise_id)
    )
    or private.current_user_is_shop_operator(p_shop_id)
$function$;

revoke all on function private.current_user_is_platform_owner()
  from public, anon;
revoke all on function private.current_user_is_enterprise_owner(uuid)
  from public, anon;
revoke all on function private.current_user_is_shop_operator(uuid)
  from public, anon;
revoke all on function private.current_user_can_view_enterprise(uuid)
  from public, anon;
revoke all on function private.current_user_can_view_shop(uuid)
  from public, anon;
grant execute on function private.current_user_is_platform_owner()
  to authenticated;
grant execute on function private.current_user_is_enterprise_owner(uuid)
  to authenticated;
grant execute on function private.current_user_is_shop_operator(uuid)
  to authenticated;
grant execute on function private.current_user_can_view_enterprise(uuid)
  to authenticated;
grant execute on function private.current_user_can_view_shop(uuid)
  to authenticated;

alter table public.enterprises enable row level security;
alter table public.shops enable row level security;
alter table public.platform_members enable row level security;
alter table public.enterprise_members enable row level security;
alter table public.shop_operator_assignments enable row level security;
alter table public.permission_catalog enable row level security;
alter table public.shop_operator_permissions enable row level security;
alter table private.user_shop_contexts enable row level security;
alter table private.multitenant_runtime_state enable row level security;

create policy enterprises_select_authorized
on public.enterprises for select to authenticated
using (private.current_user_can_view_enterprise(id));

create policy shops_select_authorized
on public.shops for select to authenticated
using (private.current_user_can_view_shop(id));

create policy platform_members_select_self
on public.platform_members for select to authenticated
using (user_id = (select auth.uid()));

create policy enterprise_members_select_authorized
on public.enterprise_members for select to authenticated
using (
  user_id = (select auth.uid())
  or private.current_user_is_platform_owner()
  or private.current_user_is_enterprise_owner(enterprise_id)
);

create policy shop_operator_assignments_select_authorized
on public.shop_operator_assignments for select to authenticated
using (
  user_id = (select auth.uid())
  or private.current_user_is_platform_owner()
  or private.current_user_is_enterprise_owner(enterprise_id)
);

create policy permission_catalog_select_authenticated
on public.permission_catalog for select to authenticated
using (true);

create policy shop_operator_permissions_select_authorized
on public.shop_operator_permissions for select to authenticated
using (
  user_id = (select auth.uid())
  or private.current_user_is_platform_owner()
  or exists (
    select 1
    from public.shop_operator_assignments assignment
    where assignment.user_id = shop_operator_permissions.user_id
      and assignment.shop_id = shop_operator_permissions.shop_id
      and private.current_user_is_enterprise_owner(assignment.enterprise_id)
  )
);

revoke all on table public.enterprises from public, anon;
revoke all on table public.shops from public, anon;
revoke all on table public.platform_members from public, anon;
revoke all on table public.enterprise_members from public, anon;
revoke all on table public.shop_operator_assignments from public, anon;
revoke all on table public.permission_catalog from public, anon;
revoke all on table public.shop_operator_permissions from public, anon;
revoke all on table private.user_shop_contexts
  from public, anon, authenticated;
revoke all on table private.multitenant_runtime_state
  from public, anon, authenticated;

grant select on table public.enterprises to authenticated;
grant select on table public.shops to authenticated;
grant select on table public.platform_members to authenticated;
grant select on table public.enterprise_members to authenticated;
grant select on table public.shop_operator_assignments to authenticated;
grant select on table public.permission_catalog to authenticated;
grant select on table public.shop_operator_permissions to authenticated;
