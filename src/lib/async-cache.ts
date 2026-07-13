type AsyncCacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
};

type PersistedEntry = { version: number; expiresAt: number; value: unknown };
type AsyncCacheOptions = { force?: boolean; ttlMs?: number };

const cache = new Map<string, AsyncCacheEntry>();
const CACHE_VERSION = 2;
const DEFAULT_TTL_MS = 5 * 60_000;
const STORAGE_PREFIX = "temu-jp:operational-cache:";
const persistentKeyPatterns = [
  /^operational:products(?::selling)?$/,
  /^operational:product-details:/,
  /^operational:product-skus:/,
  /^operational:warehouses$/,
  /^operational:logistics-methods$/,
  /^operational:warehouse-logistics:/,
];
let storageListenerInstalled = false;
let cacheScope = "signed-out";

function storageScopePrefix() {
  return `${STORAGE_PREFIX}v${CACHE_VERSION}:${encodeURIComponent(cacheScope)}:`;
}

export function setAsyncCacheScope(scope: string | null | undefined) {
  const nextScope = scope?.trim() || "signed-out";
  if (nextScope === cacheScope) return;
  cache.clear();
  cacheScope = nextScope;
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${STORAGE_PREFIX}v1:`)) window.localStorage.removeItem(key);
    }
  } catch {
    // Legacy cache cleanup is best effort.
  }
}

function ensureStorageListener() {
  if (storageListenerInstalled || typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(storageScopePrefix())) return;
    const logicalKey = event.key.slice(storageScopePrefix().length);
    cache.delete(logicalKey);
  });
  storageListenerInstalled = true;
}

function canPersist(key: string) {
  return persistentKeyPatterns.some((pattern) => pattern.test(key));
}

function storageKey(key: string) {
  return `${storageScopePrefix()}${key}`;
}

function readPersistent<T>(key: string): PersistedEntry | null {
  if (typeof window === "undefined" || !canPersist(key)) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedEntry;
    if (parsed.version !== CACHE_VERSION || !("value" in parsed)) {
      window.localStorage.removeItem(storageKey(key));
      return null;
    }
    return parsed as PersistedEntry & { value: T };
  } catch {
    return null;
  }
}

function writePersistent(key: string, value: unknown, expiresAt: number) {
  if (typeof window === "undefined" || !canPersist(key)) return;
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify({ version: CACHE_VERSION, expiresAt, value }));
  } catch {
    // Cache quota or privacy restrictions must not interrupt business operations.
  }
}

function startLoad<T>(key: string, loader: () => Promise<T>, ttlMs: number) {
  const expiresAt = Date.now() + ttlMs;
  const promise = loader()
    .then((value) => {
      writePersistent(key, value, expiresAt);
      return value;
    })
    .catch((error) => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
      throw error;
    });
  cache.set(key, { expiresAt, promise });
  return promise;
}

export function getCachedAsync<T>(key: string, loader: () => Promise<T>, options: AsyncCacheOptions = {}): Promise<T> {
  ensureStorageListener();
  const now = Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const current = cache.get(key);
  if (!options.force && current?.expiresAt && current.expiresAt > now) return current.promise as Promise<T>;

  if (!options.force) {
    const persisted = readPersistent<T>(key);
    if (persisted) {
      const staleValue = Promise.resolve(persisted.value as T);
      if (persisted.expiresAt > now) {
        cache.set(key, { expiresAt: persisted.expiresAt, promise: staleValue });
      } else {
        // Stale-while-revalidate: render cached base data immediately and refresh in background.
        void startLoad(key, loader, ttlMs).catch(() => undefined);
      }
      return staleValue;
    }
  }
  return startLoad(key, loader, ttlMs);
}

export function invalidateAsyncCache(prefix?: string) {
  ensureStorageListener();
  if (!prefix) cache.clear();
  else for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);

  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(storageScopePrefix())) continue;
      const logicalKey = key.slice(storageScopePrefix().length);
      if (!prefix || logicalKey.startsWith(prefix)) window.localStorage.removeItem(key);
    }
  } catch {
    // Cache invalidation must not turn a successful business write into a UI error.
  }
}
