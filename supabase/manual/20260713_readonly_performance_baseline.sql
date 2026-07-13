-- Read-only execution-plan baseline for the Supabase SQL editor.
-- Replace both placeholders with one permitted test account before running the transaction.
-- Run this after migrations are deployed and retain the three plans with the release SHA.
-- Compare execution time, shared buffer reads/hits, scan types, sort methods, and row estimates.
-- EXPLAIN ANALYZE executes these stable read functions but does not change business data.
-- Function-internal plans are written to Postgres logs for this transaction only.

begin;
set transaction read only;
set local statement_timeout = '30s';
set local lock_timeout = '3s';
-- Ignore sub-millisecond helper calls so the relevant nested plans remain visible.
set local auto_explain.log_min_duration = '1ms';
set local auto_explain.log_analyze = true;
set local auto_explain.log_buffers = true;
set local auto_explain.log_nested_statements = true;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_TEST_USER_UUID', true);
select set_config('request.jwt.claim.email', 'REPLACE_WITH_TEST_USER_EMAIL', true);
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'REPLACE_WITH_TEST_USER_UUID',
    'email', 'REPLACE_WITH_TEST_USER_EMAIL',
    'role', 'authenticated'
  )::text,
  true
);

-- Baseline A: the default order page, including status/team filtering and sorting.
explain (analyze, buffers, settings, summary, verbose, format text)
select * from public.get_temu_orders_page(
  1, 20, '', 'all', null, '', false, 'ship_deadline', 'asc', now()
);

-- Baseline B: the default purchase page and its nested item/package aggregation.
explain (analyze, buffers, settings, summary, verbose, format text)
select * from public.get_purchase_orders_page(1, 20, '');

-- Baseline C: the default finance analysis page and summary calculation.
explain (analyze, buffers, settings, summary, verbose, format text)
select * from public.get_finance_order_analysis(
  1, 20, '', null, null, 'all', 'all'
);

-- Always leave the SQL editor session without persistent role or claim changes.
-- In Postgres logs, filter for "duration:" and the RPC name to inspect nested plans.
rollback;
