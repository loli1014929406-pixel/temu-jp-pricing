import { afterEach, describe, expect, it, vi } from "vitest";
import { getCachedAsync, invalidateAsyncCache } from "./async-cache";

afterEach(() => {
  invalidateAsyncCache();
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
});
