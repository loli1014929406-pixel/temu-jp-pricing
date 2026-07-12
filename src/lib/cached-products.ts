import type { ProductItem, ProductSku } from "../types";
import { getCachedAsync } from "./async-cache";
import {
  fetchProductItemsByProductIds,
  fetchProducts,
  fetchProductSkusByProductIds,
} from "./products";
import {
  getOperationalIdsCacheKey,
  operationalCacheKeys,
  operationalCacheTtlMs,
} from "./operational-cache";

type CachedLoadOptions = { force?: boolean };

function cacheOptions(options: CachedLoadOptions) {
  return { force: options.force, ttlMs: operationalCacheTtlMs };
}

export function loadCachedProducts(
  options: CachedLoadOptions & { includeNotSelling?: boolean } = {},
) {
  const includeNotSelling = Boolean(options.includeNotSelling);
  return getCachedAsync(
    includeNotSelling ? operationalCacheKeys.products : operationalCacheKeys.sellingProducts,
    () => fetchProducts({ includeNotSelling }),
    cacheOptions(options),
  );
}

export function loadCachedProductDetails(productIds: string[], options: CachedLoadOptions = {}) {
  const ids = Array.from(new Set(productIds)).sort();
  if (ids.length === 0) {
    return Promise.resolve<[ProductItem[], ProductSku[]]>([[], []]);
  }
  return getCachedAsync(
    getOperationalIdsCacheKey("operational:product-details", ids),
    () => Promise.all([
      fetchProductItemsByProductIds(ids),
      fetchProductSkusByProductIds(ids),
    ]),
    cacheOptions(options),
  );
}

export function loadCachedProductSkus(productIds: string[], options: CachedLoadOptions = {}) {
  const ids = Array.from(new Set(productIds)).sort();
  if (ids.length === 0) return Promise.resolve([] as ProductSku[]);
  return getCachedAsync(
    getOperationalIdsCacheKey("operational:product-skus", ids),
    () => fetchProductSkusByProductIds(ids),
    cacheOptions(options),
  );
}
