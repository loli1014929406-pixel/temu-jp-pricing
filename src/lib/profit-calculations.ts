import { getSupabaseClient } from "./supabase";
import type {
  ProfitCalculationInput,
  ProfitCalculationResult,
  SavedProfitCalculation,
} from "../types";

export async function fetchProfitCalculationsBySkuIds(skuIds: string[]) {
  if (skuIds.length === 0) return [] as SavedProfitCalculation[];

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("profit_calculations")
    .select("*")
    .in("sku_id", skuIds);

  if (error) throw error;
  return data as SavedProfitCalculation[];
}

export async function saveProfitCalculation(
  productId: string,
  skuId: string,
  input: ProfitCalculationInput,
  result: ProfitCalculationResult,
) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("profit_calculations").upsert(
    {
      product_id: productId,
      sku_id: skuId,
      temu_price_rmb: input.temuPriceRmb,
      traffic_discount_rate: input.trafficDiscountRate,
      activity_discount_rate: input.activityDiscountRate,
      coupon_discount_rate: input.couponDiscountRate,
      result_json: result,
    },
    { onConflict: "sku_id" },
  );

  if (error) throw error;
}
