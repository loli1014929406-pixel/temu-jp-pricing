import { getSupabaseClient } from "./supabase";
import type { PricingResult } from "../types";

export async function savePricingResult(
  productId: string,
  skuId: string,
  result: PricingResult,
) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("pricing_results").insert({
    product_id: productId,
    sku_id: skuId,
    purchase_cost_rmb: result.purchaseCostRmb,
    purchase_shipping_cost_rmb: result.purchaseShippingRmb,
    packaging_cost_rmb: result.packagingCostRmb,
    sf_allocated_cost_rmb: 0,
    plan_a_cost_rmb: result.planA,
    plan_b_cost_rmb: result.planB,
    plan_c_cost_rmb: result.planC,
    plan_d_cost_rmb: result.planD,
    selected_logistics_cost_rmb: result.logisticsCostRmb,
    total_cost_rmb: result.totalCostRmb,
    shipping_subsidy_rmb: result.subsidyRmb,
    minimum_temu_price_rmb: result.temuDeclarationPriceRmb,
    estimated_profit_rmb: result.profitRmb,
    estimated_profit_rate: result.profitRate,
  });

  if (error) throw error;
}
