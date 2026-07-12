import { getCachedAsync } from "./async-cache";
import { fetchWarehouses } from "./inventory";
import { operationalCacheKeys, operationalCacheTtlMs } from "./operational-cache";

type CachedLoadOptions = { force?: boolean };

export function loadCachedWarehouses(options: CachedLoadOptions = {}) {
  return getCachedAsync(
    operationalCacheKeys.warehouses,
    fetchWarehouses,
    { force: options.force, ttlMs: operationalCacheTtlMs },
  );
}
