import { getSupabaseClient } from "../src/lib/supabase";
import { fetchTemuOrders } from "../src/lib/orders";
import { fetchProducts, fetchProductItemsByProductIds, fetchProductSkusByProductIds } from "../src/lib/products";
import { fetchSettings } from "../src/lib/settings";
import { fetchWarehouses } from "../src/lib/inventory";
import { fetchLogisticsMethods, fetchWarehouseLogisticsMethods } from "../src/lib/logistics-methods";
import {
  buildSkuLookup, estimateOrderShippingBreakdown, getOrderQuantity, getOrderSku,
  getSkuUnitCostRmb, roundMoney,
} from "../src/pages/finance/shared";
import { calculateSettlementNetFreightRevenue, calculateSettlementNetSalesRevenue } from "../src/lib/settlement";

const supabase = getSupabaseClient();
const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
  email: import.meta.env.VITE_AUTO_LOGIN_EMAIL,
  password: import.meta.env.VITE_AUTO_LOGIN_PASSWORD,
});
if (authError || !auth.user) throw authError ?? new Error("No test user");

const [orders, products, settings, warehouses, logisticsMethods, settlementResult] = await Promise.all([
  fetchTemuOrders(), fetchProducts({ includeNotSelling: true }), fetchSettings(auth.user.id),
  fetchWarehouses(), fetchLogisticsMethods(),
  supabase.from("finance_settlement_records").select("po_number,sales_revenue,sales_reversal,freight_revenue,freight_reversal").limit(10000),
]);
if (settlementResult.error) throw settlementResult.error;
const productIds = products.map((row) => row.id);
const [items, skus, warehouseLinks] = await Promise.all([
  fetchProductItemsByProductIds(productIds), fetchProductSkusByProductIds(productIds),
  fetchWarehouseLogisticsMethods(warehouses.map((row) => row.id)),
]);
const productsById = new Map(products.map((row) => [row.id, row]));
const itemsById = new Map(items.flatMap((row) => row.id ? [[row.id, row] as const] : []));
const skuLookup = buildSkuLookup(products, skus);
const settlementByPo = new Map<string, { sales: number; freight: number }>();
for (const row of settlementResult.data ?? []) {
  const current = settlementByPo.get(row.po_number) ?? { sales: 0, freight: 0 };
  current.sales += calculateSettlementNetSalesRevenue({
    salesRevenue: Number(row.sales_revenue), salesReversal: Number(row.sales_reversal),
  });
  current.freight += calculateSettlementNetFreightRevenue({
    freightRevenue: Number(row.freight_revenue), freightReversal: Number(row.freight_reversal),
  });
  settlementByPo.set(row.po_number, current);
}
const expected = { orderCount: orders.length, quantity: 0, productCost: 0, firstLegShipping: 0, lastLegShipping: 0, shipping: 0, bill: 0, actualRevenue: 0, settledCount: 0, unsettledCount: 0, unmatchedCount: 0, missingShippingCount: 0 };
const expectedFirstLegById = new Map<string, number>();
for (const order of orders) {
  const sku = getOrderSku(order, skuLookup);
  const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
  const quantity = getOrderQuantity(order);
  const productCost = roundMoney((sku ? getSkuUnitCostRmb(sku, itemsById) : 0) * quantity);
  const shipping = estimateOrderShippingBreakdown({ order, product, settings, logisticsMethods, warehouseLogisticsMethods: warehouseLinks });
  const settlement = settlementByPo.get(order.order_no.trim());
  const revenue = roundMoney((settlement?.sales ?? 0) + (settlement?.freight ?? 0));
  expected.quantity = roundMoney(expected.quantity + quantity);
  expected.productCost = roundMoney(expected.productCost + productCost);
  expected.firstLegShipping = roundMoney(expected.firstLegShipping + shipping.firstLegShippingRmb);
  expectedFirstLegById.set(order.id, shipping.firstLegShippingRmb);
  expected.lastLegShipping = roundMoney(expected.lastLegShipping + shipping.lastLegShippingRmb);
  expected.shipping = roundMoney(expected.shipping + shipping.shippingFeeRmb);
  expected.bill = roundMoney(expected.bill + productCost + shipping.shippingFeeRmb);
  expected.actualRevenue = roundMoney(expected.actualRevenue + revenue);
  expected.settledCount += settlement ? 1 : 0;
  expected.unsettledCount += settlement ? 0 : 1;
  expected.unmatchedCount += sku && product ? 0 : 1;
  expected.missingShippingCount += shipping.shippingFeeSource === "missing" ? 1 : 0;
}
const { data: rpcData, error: rpcError } = await supabase.rpc("get_finance_order_analysis", {
  p_page: 1, p_page_size: 1, p_search: "", p_date_start: null, p_date_end: null, p_status: "all", p_issue: "all",
});
if (rpcError) throw rpcError;
const actual = (Array.isArray(rpcData) ? rpcData[0] : rpcData)?.summary ?? {};
const rpcRows: any[] = [];
for (let page = 1; page <= Math.ceil(orders.length / 100); page += 1) {
  const { data, error } = await supabase.rpc("get_finance_order_analysis", {
    p_page: page, p_page_size: 100, p_search: "", p_date_start: null, p_date_end: null, p_status: "all", p_issue: "all",
  });
  if (error) throw error;
  rpcRows.push(...((Array.isArray(data) ? data[0] : data)?.rows ?? []));
}
const firstLegDifferences = rpcRows.flatMap((row) => {
  const expectedValue = expectedFirstLegById.get(row.order.id) ?? 0;
  const actualValue = Number(row.firstLegShippingRmb ?? 0);
  return Math.abs(expectedValue - actualValue) > 0.011
    ? [{ orderNo: row.order.order_no, warehouse: row.order.warehouse_name, expected: expectedValue, actual: actualValue }]
    : [];
});
const keys = Object.keys(expected) as Array<keyof typeof expected>;
const differences = keys.flatMap((key) => {
  const left = Number(expected[key]);
  const right = Number(actual[key] ?? 0);
  return Math.abs(left - right) > 0.011 ? [{ key, expected: left, actual: right }] : [];
});
console.log(JSON.stringify({ expected, actual, differences, firstLegDifferences }));
await supabase.auth.signOut();
if (differences.length) process.exitCode = 1;
