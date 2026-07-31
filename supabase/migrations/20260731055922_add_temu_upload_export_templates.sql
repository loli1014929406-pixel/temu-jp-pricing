-- Extend the existing per-user order-file template store with one isolated
-- template kind for generating Temu upload workbooks. Existing order and
-- tracking import templates and their workflows remain unchanged.

alter table public.temu_order_file_import_templates
  drop constraint if exists temu_order_file_import_templates_import_type_check;

alter table public.temu_order_file_import_templates
  add constraint temu_order_file_import_templates_import_type_check
  check (import_type in ('orders', 'tracking', 'temu_upload'));

create or replace function public.ensure_temu_upload_export_default_template()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_inserted_count integer := 0;
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
    'temu_upload',
    '现有下载上传表格模板',
    '',
    2,
    jsonb_build_object(
      'order_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('订单号')
      ),
      'sub_order_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('子订单号')
      ),
      'fulfillment_quantity', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('商品件数')
      ),
      'tracking_no', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('跟踪单号')
      ),
      'carrier', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('物流承运商')
      ),
      'warehouse_name', jsonb_build_object(
        'sourceType', 'header',
        'column', null,
        'fixedValue', '',
        'headerAliases', jsonb_build_array('发货仓库名称')
      )
    ),
    true,
    'legacy_temu_upload'
  )
  on conflict do nothing;

  get diagnostics v_inserted_count = row_count;
  return jsonb_build_object('insertedCount', v_inserted_count);
end;
$$;

revoke all on function public.ensure_temu_upload_export_default_template()
  from public;
grant execute on function public.ensure_temu_upload_export_default_template()
  to authenticated;
