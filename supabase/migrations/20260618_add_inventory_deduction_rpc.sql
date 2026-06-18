create or replace function public.deduct_inventory_atomic(order_groups jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_group jsonb;
  v_deduction jsonb;
  v_group_id text;
  v_dedupe_key text;
  v_stock_id uuid;
  v_item_id uuid;
  v_quantity int;
  v_reason text;
  v_reversal_reason text;
  
  v_current_stock int;
  v_warehouse_id uuid;
  v_owner_id uuid;
  v_net_change int;
  v_remaining_to_deduct int;
  v_next_stock int;
  v_adjustment_id uuid;
  
  v_results jsonb := '[]'::jsonb;
  v_failures jsonb := '[]'::jsonb;
  v_group_results jsonb;
  v_error_detail text;
begin
  -- 1. Security Check (Pre-flight)
  if not public.current_account_can_edit() then
    raise exception '权限不足，无法执行库存扣减操作';
  end if;

  -- 2. Empty Check
  if order_groups is null or jsonb_array_length(order_groups) = 0 then
    return jsonb_build_object('results', v_results, 'failures', v_failures);
  end if;

  -- 3. Lock all involved stock rows in ID order to prevent deadlock
  perform id from public.warehouse_item_stocks
  where id in (
    select (d->>'stockId')::uuid 
    from jsonb_array_elements(order_groups) as g,
         jsonb_array_elements(g->'deductions') as d
    where d->>'stockId' is not null
  )
  order by id
  for update;

  -- 4. Process each group
  for v_group in select * from jsonb_array_elements(order_groups)
  loop
    v_group_id := v_group->>'groupId';
    v_dedupe_key := v_group->>'dedupeKey';
    v_group_results := '[]'::jsonb;

    begin
      if v_group->'deductions' is null or jsonb_array_length(v_group->'deductions') = 0 then
        continue;
      end if;

      for v_deduction in select * from jsonb_array_elements(v_group->'deductions')
      loop
        v_stock_id := (v_deduction->>'stockId')::uuid;
        v_quantity := (v_deduction->>'quantity')::int;
        v_reason := v_deduction->>'reason';
        v_reversal_reason := v_deduction->>'reversalReason';
        
        -- Load current stock
        select warehouse_id, item_id, stock_quantity, owner_id
        into v_warehouse_id, v_item_id, v_current_stock, v_owner_id
        from public.warehouse_item_stocks
        where id = v_stock_id;

        if not found then
          raise exception 'GROUP_FAIL' using 
            errcode = 'P0001', 
            detail = jsonb_build_object(
              'stockId', v_stock_id, 
              'itemId', null, 
              'requiredQuantity', v_quantity, 
              'currentQuantity', 0, 
              'message', '仓库配件库存不存在'
            )::text;
        end if;

        -- Dedupe check & Partial reversal handling
        if v_dedupe_key is not null then
          select coalesce(sum(change_quantity), 0)
          into v_net_change
          from public.warehouse_item_stock_adjustments
          where warehouse_id = v_warehouse_id
            and item_id = v_item_id
            and reason in (v_reason, coalesce(v_reversal_reason, ''));

          v_remaining_to_deduct := v_quantity + v_net_change;

          if v_remaining_to_deduct <= 0 then
            continue;
          else
            v_quantity := v_remaining_to_deduct;
          end if;
        end if;

        -- Check stock sufficient
        if v_current_stock < v_quantity then
          raise exception 'GROUP_FAIL' using 
            errcode = 'P0001', 
            detail = jsonb_build_object(
              'stockId', v_stock_id, 
              'itemId', v_item_id, 
              'requiredQuantity', v_quantity, 
              'currentQuantity', v_current_stock,
              'message', '仓库配件库存不足'
            )::text;
        end if;

        v_next_stock := v_current_stock - v_quantity;

        -- Update stock
        update public.warehouse_item_stocks
        set stock_quantity = v_next_stock, updated_at = now()
        where id = v_stock_id;

        -- Insert adjustment
        insert into public.warehouse_item_stock_adjustments (
          warehouse_id, item_id, owner_id,
          previous_quantity, next_quantity, change_quantity, reason
        ) values (
          v_warehouse_id, v_item_id, v_owner_id,
          v_current_stock, v_next_stock, -v_quantity, v_reason
        ) returning id into v_adjustment_id;

        -- Accumulate results for this group
        v_group_results := v_group_results || jsonb_build_object(
          'id', v_stock_id,
          'warehouse_id', v_warehouse_id,
          'item_id', v_item_id,
          'stock_quantity', v_next_stock,
          'adjustment_id', v_adjustment_id,
          'previous_quantity', v_current_stock,
          'change_quantity', -v_quantity,
          'reason', v_reason
        );
      end loop;

      v_results := v_results || v_group_results;

    exception
      when others then
        if sqlstate = 'P0001' and sqlerrm = 'GROUP_FAIL' then
          -- Get the detail JSON safely
          get stacked diagnostics v_error_detail = pg_exception_detail;
          v_failures := v_failures || jsonb_build_object(
            'groupId', v_group_id,
            'detail', v_error_detail::jsonb
          );
        else
          raise;
        end if;
    end;
  end loop;

  return jsonb_build_object('results', v_results, 'failures', v_failures);
end;
$$;
