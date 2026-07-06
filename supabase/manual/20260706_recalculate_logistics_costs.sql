-- 手动执行脚本：按 2026-07-06 物流口径重算历史核价数据。
--
-- 新口径：
-- 1. 正常核价不再额外加顺丰成本。
-- 2. pricing_results.sf_allocated_cost_rmb 保留字段但统一写 0。
-- 3. pricing_results.total_cost_rmb = 采购成本 + 采购运费 + 包装成本 + 物流成本。
-- 4. profit_calculations.result_json 标记为过期；新版前端会按 calculationVersion=6 自动重算。

begin;

with recalculated as (
  select
    pr.id,
    round(
      (
        pr.purchase_cost_rmb +
        pr.purchase_shipping_cost_rmb +
        pr.packaging_cost_rmb +
        pr.selected_logistics_cost_rmb
      )::numeric,
      2
    ) as total_cost_rmb,
    least(greatest(coalesce(ps.target_profit_rate, 0.3), 0), 0.99) as target_profit_rate
  from public.pricing_results pr
  left join public.pricing_settings ps
    on ps.owner_id = pr.owner_id
),
pricing_updates as (
  update public.pricing_results pr
  set
    sf_allocated_cost_rmb = 0,
    total_cost_rmb = r.total_cost_rmb,
    minimum_temu_price_rmb = round(
      (r.total_cost_rmb / (1 - r.target_profit_rate) - pr.shipping_subsidy_rmb)::numeric,
      2
    ),
    estimated_profit_rmb = round(
      (
        (r.total_cost_rmb / (1 - r.target_profit_rate) - pr.shipping_subsidy_rmb) +
        pr.shipping_subsidy_rmb -
        r.total_cost_rmb
      )::numeric,
      2
    ),
    estimated_profit_rate = coalesce(
      round(
        (
          (
            (r.total_cost_rmb / (1 - r.target_profit_rate) - pr.shipping_subsidy_rmb) +
            pr.shipping_subsidy_rmb -
            r.total_cost_rmb
          ) / nullif(
            (r.total_cost_rmb / (1 - r.target_profit_rate) - pr.shipping_subsidy_rmb) +
            pr.shipping_subsidy_rmb,
            0
          )
        )::numeric,
        4
      ),
      0
    ),
    updated_at = now()
  from recalculated r
  where pr.id = r.id
  returning pr.id
),
profit_updates as (
  update public.profit_calculations pc
  set
    result_json = jsonb_set(
      coalesce(pc.result_json, '{}'::jsonb),
      '{calculationVersion}',
      '0'::jsonb,
      true
    ),
    updated_at = now()
  where coalesce(
    case
      when (pc.result_json ->> 'calculationVersion') ~ '^-?[0-9]+(\.[0-9]+)?$'
        then (pc.result_json ->> 'calculationVersion')::numeric
      else 0
    end,
    0
  ) <> 0
  returning pc.id
)
select
  (select count(*) from pricing_updates) as pricing_results_recalculated,
  (select count(*) from profit_updates) as profit_calculations_marked_stale;

commit;
