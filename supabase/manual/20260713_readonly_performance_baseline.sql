-- Read-only execution-plan baseline for the Supabase SQL editor.
-- Replace the two placeholders with a permitted test account, then run the whole transaction.
-- EXPLAIN ANALYZE executes these stable read functions but does not change business data.

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_TEST_USER_UUID', true);
select set_config('request.jwt.claim.email', 'REPLACE_WITH_TEST_USER_EMAIL', true);

explain (analyze, buffers, verbose, format text)
select * from public.get_temu_orders_page(
  1, 20, '', 'all', null, '', false, 'ship_deadline', 'asc', now()
);

explain (analyze, buffers, verbose, format text)
select * from public.get_purchase_orders_page(1, 20, '');

explain (analyze, buffers, verbose, format text)
select * from public.get_finance_order_analysis(
  1, 20, '', null, null, 'all', 'all'
);

rollback;
