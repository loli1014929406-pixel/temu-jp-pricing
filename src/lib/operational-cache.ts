import { invalidateAsyncCache } from "./async-cache";

export const operationalCacheKeys = {
  orders: "operational:orders",
  purchases: "operational:purchases",
  products: "operational:products",
  sellingProducts: "operational:products:selling",
  warehouses: "operational:warehouses",
  logisticsMethods: "operational:logistics-methods",
} as const;

export const operationalCacheTtlMs = 30 * 60_000;

export function getOperationalIdsCacheKey(prefix: string, ids: string[]) {
  return `${prefix}:${Array.from(new Set(ids)).sort().join(",")}`;
}

export function invalidateProductReferenceCache() {
  invalidateAsyncCache("operational:products");
  invalidateAsyncCache("operational:product-details:");
  invalidateAsyncCache("operational:product-skus:");
}

export function invalidateWarehouseReferenceCache() {
  invalidateAsyncCache(operationalCacheKeys.warehouses);
  invalidateAsyncCache("operational:warehouse-logistics:");
}

export function invalidateLogisticsReferenceCache() {
  invalidateAsyncCache(operationalCacheKeys.logisticsMethods);
  invalidateAsyncCache("operational:warehouse-logistics:");
}

export function invalidatePurchaseReferenceCache() {
  invalidateAsyncCache(operationalCacheKeys.purchases);
}
