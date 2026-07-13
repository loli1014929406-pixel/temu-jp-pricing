import { afterEach, describe, expect, it, vi } from "vitest";
import { getCachedAsync, invalidateAsyncCache, setAsyncCacheScope } from "./async-cache";

afterEach(() => {
  invalidateAsyncCache();
  setAsyncCacheScope(null);
  vi.useRealTimers();
});

describe("getCachedAsync", () => {
  it("coalesces repeated requests while the cache entry is fresh", async () => {
    const loader = vi.fn(async () => ({ value: 1 }));

    const [first, second] = await Promise.all([
      getCachedAsync("orders", loader),
      getCachedAsync("orders", loader),
    ]);

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reloads when force is enabled", async () => {
    const loader = vi.fn(async () => loader.mock.calls.length);

    expect(await getCachedAsync("orders", loader)).toBe(1);
    expect(await getCachedAsync("orders", loader, { force: true })).toBe(2);
  });

  it("removes rejected requests so a retry can succeed", async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("ok");

    await expect(getCachedAsync("orders", loader)).rejects.toThrow("temporary");
    await expect(getCachedAsync("orders", loader)).resolves.toBe("ok");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidates only matching cache prefixes", async () => {
    const productsLoader = vi.fn(async () => "products");
    const warehousesLoader = vi.fn(async () => "warehouses");

    await getCachedAsync("operational:products", productsLoader);
    await getCachedAsync("operational:warehouses", warehousesLoader);
    invalidateAsyncCache("operational:products");
    await getCachedAsync("operational:products", productsLoader);
    await getCachedAsync("operational:warehouses", warehousesLoader);

    expect(productsLoader).toHaveBeenCalledTimes(2);
    expect(warehousesLoader).toHaveBeenCalledTimes(1);
  });

  it("does not fail business writes when browser storage is unavailable", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      get localStorage() {
        throw new Error("storage unavailable");
      },
    });

    expect(() => invalidateAsyncCache("operational:products")).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("isolates persistent operational data by authenticated account", async () => {
    const values = new Map<string, string>();
    const localStorage = {
      get length() { return values.size; },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
    };
    vi.stubGlobal("window", { addEventListener: vi.fn(), localStorage });

    setAsyncCacheScope("account-a");
    await expect(getCachedAsync("operational:products", async () => "a")).resolves.toBe("a");
    setAsyncCacheScope("account-b");
    await expect(getCachedAsync("operational:products", async () => "b")).resolves.toBe("b");
    setAsyncCacheScope("account-a");
    const accountALoader = vi.fn(async () => "wrong-account");
    await expect(getCachedAsync("operational:products", accountALoader)).resolves.toBe("a");
    expect(accountALoader).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
