-- Add an isolated template kind for the two-sheet shipping workbook export.
-- Existing order import, tracking import, and Temu upload export templates
-- keep their current contracts and behavior.

alter table public.temu_order_file_import_templates
  drop constraint if exists temu_order_file_import_templates_import_type_check;

alter table public.temu_order_file_import_templates
  add constraint temu_order_file_import_templates_import_type_check
  check (
    import_type in (
      'orders',
      'tracking',
      'temu_upload',
      'shipping_export'
    )
  );

create or replace function public.ensure_shipping_export_default_template()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_inserted_count integer := 0;
  v_field_mappings jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.current_account_can_edit() then
    return jsonb_build_object('insertedCount', 0);
  end if;

  select jsonb_object_agg(
    field_key,
    jsonb_build_object(
      'sourceType', 'header',
      'column', null,
      'fixedValue', '',
      'headerAliases', jsonb_build_array(header_alias),
      'worksheetName', worksheet_name
    )
  )
  into v_field_mappings
  from (
    values
      ('shipment_recipient_name', 'Sheet1', '收件人'),
      ('shipment_address', 'Sheet1', '收件人地址'),
      ('shipment_postal_code', 'Sheet1', '收件邮编'),
      ('shipment_phone', 'Sheet1', '收件电话'),
      ('shipment_package_count', 'Sheet1', '件数'),
      ('shipment_destination', 'Sheet1', '目的地(可以都填TYO)'),
      ('shipment_order_no', 'Sheet1', '订单号'),
      ('shipment_service_type', 'Sheet1', '服务类型(不填写默认B2C)'),
      ('shipment_store_name', 'Sheet1', '店铺名称'),
      ('shipment_store_note', 'Sheet1', '店铺备注'),
      ('shipment_sender_name', 'Sheet1', '发件人'),
      ('shipment_sender_address', 'Sheet1', '发件人地址'),
      ('shipment_sender_phone', 'Sheet1', '发件人电话'),
      ('shipment_sender_postal_code', 'Sheet1', '发件人邮编'),
      ('shipment_store', 'Sheet1', '店铺'),
      ('shipment_custom_weight', 'Sheet1', '自定义重量'),
      ('shipment_has_battery', 'Sheet1', '是否带电(0:不带电/1:带电)'),
      ('shipment_platform_name', 'Sheet1', '平台名称'),
      ('shipment_sales_unit', 'Sheet1', '生产销售单位'),
      ('shipment_sales_unit_code', 'Sheet1', '生产销售单位统一编码'),
      ('item_order_no', 'Sheet2', '订单号'),
      ('item_code', 'Sheet2', '商品代码'),
      ('item_name', 'Sheet2', '品名'),
      ('item_description', 'Sheet2', '描述'),
      ('item_quantity', 'Sheet2', '商品数量'),
      ('item_unit_price', 'Sheet2', '单价'),
      ('item_currency', 'Sheet2', '币值'),
      ('item_compilation_method', 'Sheet2', '编制方式'),
      ('item_hs_code', 'Sheet2', 'HS_CODE'),
      ('item_origin_country', 'Sheet2', '原产国'),
      ('item_shelf_no', 'Sheet2', '货架号'),
      ('item_purchase_no', 'Sheet2', '采购编号'),
      ('item_style_color', 'Sheet2', '样式颜色'),
      ('item_customer_note', 'Sheet2', '客户备注'),
      ('item_url', 'Sheet2', 'URL'),
      ('item_primary_key', 'Sheet2', 'PRIMARYKEY'),
      ('item_domestic_declared_value', 'Sheet2', '国内申报价值'),
      ('item_domestic_currency', 'Sheet2', '国内申报币值')
  ) as fields(field_key, worksheet_name, header_alias);

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
    'shipping_export',
    '现有下载发货表格模板',
    'Sheet1',
    2,
    v_field_mappings,
    true,
    'legacy_shipping_export'
  )
  on conflict do nothing;

  get diagnostics v_inserted_count = row_count;
  return jsonb_build_object('insertedCount', v_inserted_count);
end;
$$;

revoke all on function public.ensure_shipping_export_default_template()
  from public;
grant execute on function public.ensure_shipping_export_default_template()
  to authenticated;
