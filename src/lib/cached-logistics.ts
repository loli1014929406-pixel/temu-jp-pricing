import { getCachedAsync } from "./async-cache";
import { fetchLogisticsMethods, fetchWarehouseLogisticsMethods } from "./logistics-methods";
import {
  getOperationalIdsCacheKey,
  operationalCacheKeys,
  operationalCacheTtlMs,
} from "./operational-cache";

type CachedLoadOptions = { force?: boolean };

export function loadCachedLogisticsMethods(options: CachedLoadOptions = {}) {
  return getCachedAsync(
    operationalCacheKeys.logisticsMethods,
    fetchLogisticsMethods,
    { force: options.force, ttlMs: operationalCacheTtlMs },
  );
}

export function loadCachedWarehouseLogisticsMethods(
  warehouseIds: string[],
  options: CachedLoadOptions = {},
) {
  const ids = Array.from(new Set(warehouseIds)).sort();
  if (ids.length === 0) return Promise.resolve([]);
  return getCachedAsync(
    getOperationalIdsCacheKey("operational:warehouse-logistics", ids),
    () => fetchWarehouseLogisticsMethods(ids),
    { force: options.force, ttlMs: operationalCacheTtlMs },
  );
}
