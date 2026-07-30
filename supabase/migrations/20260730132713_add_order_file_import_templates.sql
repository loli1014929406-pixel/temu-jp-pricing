-- Add user-owned mapping templates for Temu order files and logistics
-- tracking-number files. This migration only stores upload configuration; it
-- does not change order, shipment, inventory, or workflow data.

create table public.temu_order_file_import_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  import_type text not null
    check (import_type in ('orders', 'tracking')),
  name text not null,
  worksheet_name text not null default '',
  start_row integer not null default 2 check (start_row > 0),
  field_mappings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_mappings) = 'object'),
  is_system boolean not null default false,
  system_key text not null default '',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint temu_order_file_import_templates_name_not_blank
    check (btrim(name) <> '')
);

create unique index temu_order_file_import_templates_user_name_uidx
  on public.temu_order_file_import_templates (
    user_id,
    import_type,
    lower(btrim(name))
  )
  where deleted_at is null;

create unique index temu_order_file_import_templates_user_system_uidx
  on public.temu_order_file_import_templates (user_id, import_type, system_key)
  where btrim(system_key) <> '';

create index temu_order_file_import_templates_visible_user_updated_idx
  on public.temu_order_file_import_templates (
    user_id,
    import_type,
    is_system desc,
    updated_at desc
  )
  where deleted_at is null;

alter table public.temu_order_file_import_templates enable row level security;

create policy "temu_order_file_import_templates_select_own"
  on public.temu_order_file_import_templates for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "temu_order_file_import_templates_insert_own"
  on public.temu_order_file_import_templates for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  );

create policy "temu_order_file_import_templates_update_own"
  on public.temu_order_file_import_templates for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  )
  with check (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  );

create policy "temu_order_file_import_templates_delete_own"
  on public.temu_order_file_import_templates for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  );

grant select, insert, update, delete
  on table public.temu_order_file_import_templates
  to authenticated;

create trigger temu_order_file_import_templates_set_updated_at
  before update on public.temu_order_file_import_templates
  for each row execute function public.set_updated_at();

create or replace function public.ensure_temu_order_file_import_default_templates()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_inserted_count integer := 0;
  v_row_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.current_account_can_edit() then
    return jsonb_build_object('insertedCount', 0);
  end if;

  insert into public.temu_order_file_import_templates (
    user_id,
    import_type,
    name,
    worksheet_name,
    start_row,
    field_mappings,
    is_system,
    system_key
  ) values (
    v_user_id,
    'orders',
    '现有上传订单模板',
    '',
    2,
    jsonb_build_object(
      'order_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('订单号', '主订单号', '订单编号', '订单ID', 'Order ID')
      ),
      'sub_order_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('子订单号', '子订单编号', '子订单ID', 'Sub Order ID', 'Sub-order ID')
      ),
      'order_status', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('订单状态', '状态', 'Order Status')
      ),
      'sku_code', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('SKU货号', 'SKU 货号', 'SKU', 'SKU ID', '商品SKU', '商家SKU')
      ),
      'fulfillment_quantity', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('应履约件数', '商品数量', '数量', '购买数量', '件数', '商品件数')
      ),
      'product_attributes', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('商品属性', '商品规格', '销售属性', 'SKU属性', '规格')
      ),
      'recipient_name', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('收货人姓名', '收件人姓名', '收货人', '收件人', 'CONSIGNEE_NAME', 'CONSIGNEE NAME', 'Recipient Name')
      ),
      'recipient_phone', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('收货人联系方式', '收件人联系方式', '收货电话', '收件电话', '联系电话', '电话', 'CONTACT_TEL', 'CONTACT TEL', 'Recipient Phone')
      ),
      'email', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('邮箱', '电子邮箱', 'Email', 'E-mail')
      ),
      'province', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('省份', '都道府县', '都道府県', '州/省', 'Province')
      ),
      'city', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('城市', '市区町村', '市', 'City')
      ),
      'district', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('区县', '区町村', '区', 'District')
      ),
      'address_line1', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('详细地址1', '详细地址 1', '地址1', '收货地址1', '收件地址1', '收件人地址', '收货地址', '地址', '住所1', 'DELIVERY_ADDR_JP', 'DELIVERY ADDR JP')
      ),
      'address_line2', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('详细地址2', '详细地址 2', '地址2', '收货地址2', '收件地址2', '住所2')
      ),
      'postal_code', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('收货地址邮编', '邮编', '收件邮编', '收货邮编', '郵便番号', 'POSTCODE', 'Postal Code', 'Zip Code')
      ),
      'latest_ship_time', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('要求最晚发货时间', '最晚发货时间', '发货截止时间', 'Latest Ship Time')
      ),
      'actual_ship_time', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('实际发货时间', 'Actual Ship Time')
      ),
      'estimated_delivery_time', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('预计送达时间', '预计送达日期', 'Estimated Delivery Time')
      )
    ),
    true,
    'legacy_orders'
  )
  on conflict do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted_count := v_inserted_count + v_row_count;

  insert into public.temu_order_file_import_templates (
    user_id,
    import_type,
    name,
    worksheet_name,
    start_row,
    field_mappings,
    is_system,
    system_key
  ) values (
    v_user_id,
    'tracking',
    '现有上传物流单号模板',
    '',
    2,
    jsonb_build_object(
      'order_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('订单号', '主订单号', 'REF_NO', 'REF NO', 'Order ID')
      ),
      'sub_order_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('子订单号', '子订单编号', 'Sub Order ID', 'Sub-order ID')
      ),
      'tracking_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('CWB_NO', 'CWB NO', '跟踪单号', '物流单号', '运单号', '单号', 'お問い合わせ番号', 'Tracking No', 'Tracking Number')
      )
    ),
    true,
    'legacy_tracking'
  )
  on conflict do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted_count := v_inserted_count + v_row_count;

  return jsonb_build_object('insertedCount', v_inserted_count);
end;
$$;

revoke all on function public.ensure_temu_order_file_import_default_templates() from public;
grant execute on function public.ensure_temu_order_file_import_default_templates()
  to authenticated;
