type AsyncCacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
};

type AsyncCacheOptions = {
  force?: boolean;
  ttlMs?: number;
};

const cache = new Map<string, AsyncCacheEntry>();

export function getCachedAsync<T>(
  key: string,
  loader: () => Promise<T>,
  options: AsyncCacheOptions = {},
): Promise<T> {
  const now = Date.now();
  const current = cache.get(key);
  if (!options.force && current && current.expiresAt > now) {
    return current.promise as Promise<T>;
  }

  const promise = loader().catch((error) => {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    throw error;
  });
  cache.set(key, {
    expiresAt: now + (options.ttlMs ?? 20_000),
    promise,
  });
  return promise;
}

export function invalidateAsyncCache(prefix?: string) {
  if (!prefix) {
    cache.clear();
    return;
  }

  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
