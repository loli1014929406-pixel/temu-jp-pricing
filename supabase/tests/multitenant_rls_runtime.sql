begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(13);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'mt-owner-1@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('11000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'mt-owner-2@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('11000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'mt-operator-1@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.enterprises (id, code, name, legacy_owner_id, created_by)
values
  ('21000000-0000-4000-8000-000000000001', 'mt-e1', 'Tenant Test Enterprise 1', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', 'mt-e2', 'Tenant Test Enterprise 2', '11000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002');

insert into public.shops (
  id, enterprise_id, code, name, legacy_owner_id, created_by
) values
  ('31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'mt-s1', 'Tenant Test Shop 1', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
  ('31000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'mt-s2', 'Tenant Test Shop 2', '11000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002');

insert into public.platform_members (user_id, created_by)
values ('11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');
insert into public.enterprise_members (enterprise_id, user_id, role, created_by)
values
  ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'enterprise_owner', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', 'enterprise_owner', '11000000-0000-4000-8000-000000000002');
insert into public.shop_operator_assignments (
  user_id, enterprise_id, shop_id, created_by
) values (
  '11000000-0000-4000-8000-000000000003',
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);
insert into public.shop_operator_permissions (
  user_id, shop_id, resource, action, allowed, granted_by
) values (
  '11000000-0000-4000-8000-000000000003',
  '31000000-0000-4000-8000-000000000001',
  'products', 'view', true,
  '11000000-0000-4000-8000-000000000001'
);

insert into public.products (
  id, owner_id, enterprise_id, shop_id, product_code, product_name_cn,
  product_name_en, material_en, material_cn, combo_name,
  combo_description, title_jp
) values
  ('41000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'mt-product-1', '企业1商品', '', '', '', '企业1组合', '', '企業1'),
  ('41000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000002', 'mt-product-2', '企业2商品', '', '', '', '企业2组合', '', '企業2');

insert into public.temu_orders (
  id, owner_id, enterprise_id, shop_id, order_no, sub_order_no,
  order_status, sku_code, fulfillment_quantity
) values
  ('62000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'mt-order-1', '', '新订单', 'mt-sku-1', 1),
  ('62000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000002', 'mt-order-2', '', '新订单', 'mt-sku-2', 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","email":"mt-owner-1@example.invalid","session_id":"51000000-0000-4000-8000-000000000001"}', true);

select extensions.is(
  (select count(*) from public.products where id in (
    '41000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000002'
  )), 2::bigint,
  'platform owner can read across enterprises without edit context'
);
update public.products set notes = 'blocked'
where id = '41000000-0000-4000-8000-000000000002';
select extensions.is(
  (select notes from public.products
   where id = '41000000-0000-4000-8000-000000000002'),
  null::text,
  'platform owner cannot edit another enterprise without shop context'
);
update public.products set notes = 'blocked'
where id = '41000000-0000-4000-8000-000000000001';
select extensions.is(
  (select notes from public.products
   where id = '41000000-0000-4000-8000-000000000001'),
  null::text,
  'platform owner cannot edit its enterprise business data without explicit shop context'
);
select public.set_current_shop_context('31000000-0000-4000-8000-000000000001');
update public.products set notes = 'allowed with context'
where id = '41000000-0000-4000-8000-000000000001';
select extensions.is(
  (select notes from public.products where id = '41000000-0000-4000-8000-000000000001'),
  'allowed with context',
  'platform owner can edit only after entering the target shop context'
);
update public.products set notes = 'blocked'
where id = '41000000-0000-4000-8000-000000000002';
select extensions.is(
  (select notes from public.products
   where id = '41000000-0000-4000-8000-000000000002'),
  null::text,
  'platform context for shop 1 does not allow editing shop 2'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated","email":"mt-owner-2@example.invalid","session_id":"51000000-0000-4000-8000-000000000002"}', true);
select extensions.is(
  (select count(*) from public.products where id in (
    '41000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000002'
  )), 1::bigint,
  'enterprise 2 owner sees only enterprise 2 data'
);
select extensions.is(
  (select count(*) from public.products where id = '41000000-0000-4000-8000-000000000001'),
  0::bigint,
  'enterprise 2 owner cannot guess enterprise 1 product id'
);
select extensions.is(
  (select count(*) from public.temu_order_fulfillment_lines
   where source_order_id in (
     '62000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000002'
   )),
  1::bigint,
  'security-invoker order view returns only enterprise 2 rows'
);
select extensions.is(
  (select total_count from public.get_temu_orders_page(p_search => 'mt-order')),
  1::bigint,
  'order pagination RPC does not count another enterprise'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated","email":"mt-operator-1@example.invalid","session_id":"51000000-0000-4000-8000-000000000003"}', true);
select extensions.is(
  (select count(*) from public.products where id in (
    '41000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000002'
  )), 1::bigint,
  'shop 1 operator sees only the assigned shop'
);
select extensions.is(
  (select count(*) from public.products where id = '41000000-0000-4000-8000-000000000002'),
  0::bigint,
  'shop operator cannot guess another enterprise product id'
);
select extensions.is(
  (select count(*) from public.temu_order_fulfillment_lines),
  0::bigint,
  'operator without orders.view cannot read the order view'
);
update public.products set notes = 'blocked'
where id = '41000000-0000-4000-8000-000000000001';
select extensions.is(
  (select notes from public.products
   where id = '41000000-0000-4000-8000-000000000001'),
  'allowed with context',
  'view-only shop operator cannot update its own shop product'
);

select * from extensions.finish();
rollback;
