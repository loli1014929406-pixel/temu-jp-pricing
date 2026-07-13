-- Cache request-scoped auth and permission helpers once per statement while
-- preserving every existing policy predicate and command unchanged.
do $$
declare
  policy_record record;
  optimized_qual text;
  optimized_check text;
begin
  for policy_record in
    select
      namespace.nspname as schema_name,
      relation.relname as table_name,
      policy.polname as policy_name,
      pg_get_expr(policy.polqual, policy.polrelid) as qual,
      pg_get_expr(policy.polwithcheck, policy.polrelid) as with_check
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and (
        coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') ~
          '(auth\.(uid|jwt)\(\)|current_account_(permission|has_permission|can_edit|can_delete)\(\))'
        or coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '') ~
          '(auth\.(uid|jwt)\(\)|current_account_(permission|has_permission|can_edit|can_delete)\(\))'
      )
  loop
    optimized_qual := policy_record.qual;
    optimized_check := policy_record.with_check;

    if optimized_qual is not null then
      optimized_qual := replace(optimized_qual, 'auth.uid()', '(select auth.uid())');
      optimized_qual := replace(optimized_qual, 'auth.jwt()', '(select auth.jwt())');
      optimized_qual := replace(optimized_qual, 'current_account_permission()', '(select public.current_account_permission())');
      optimized_qual := replace(optimized_qual, 'current_account_has_permission()', '(select public.current_account_has_permission())');
      optimized_qual := replace(optimized_qual, 'current_account_can_edit()', '(select public.current_account_can_edit())');
      optimized_qual := replace(optimized_qual, 'current_account_can_delete()', '(select public.current_account_can_delete())');
    end if;

    if optimized_check is not null then
      optimized_check := replace(optimized_check, 'auth.uid()', '(select auth.uid())');
      optimized_check := replace(optimized_check, 'auth.jwt()', '(select auth.jwt())');
      optimized_check := replace(optimized_check, 'current_account_permission()', '(select public.current_account_permission())');
      optimized_check := replace(optimized_check, 'current_account_has_permission()', '(select public.current_account_has_permission())');
      optimized_check := replace(optimized_check, 'current_account_can_edit()', '(select public.current_account_can_edit())');
      optimized_check := replace(optimized_check, 'current_account_can_delete()', '(select public.current_account_can_delete())');
    end if;

    if optimized_qual is not null and optimized_check is not null then
      execute format(
        'alter policy %I on %I.%I using (%s) with check (%s)',
        policy_record.policy_name,
        policy_record.schema_name,
        policy_record.table_name,
        optimized_qual,
        optimized_check
      );
    elsif optimized_qual is not null then
      execute format(
        'alter policy %I on %I.%I using (%s)',
        policy_record.policy_name,
        policy_record.schema_name,
        policy_record.table_name,
        optimized_qual
      );
    elsif optimized_check is not null then
      execute format(
        'alter policy %I on %I.%I with check (%s)',
        policy_record.policy_name,
        policy_record.schema_name,
        policy_record.table_name,
        optimized_check
      );
    end if;
  end loop;
end;
$$;

-- This index duplicates idx_purchase_items_team_order(order_id, id).
drop index if exists public.idx_purchase_order_items_order;
