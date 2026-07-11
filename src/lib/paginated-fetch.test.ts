import { describe, expect, it, vi } from "vitest";
import { fetchAllPages } from "./paginated-fetch";

describe("fetchAllPages", () => {
  it("reads through a full boundary page and returns every row", async () => {
    const source = [1, 2, 3, 4, 5];
    const fetchPage = vi.fn(async (from: number, to: number) => ({
      data: source.slice(from, to + 1),
      error: null,
    }));

    await expect(fetchAllPages(fetchPage, { pageSize: 2 })).resolves.toEqual({
      data: source,
      error: null,
    });
    expect(fetchPage.mock.calls).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });

  it("requests one empty page when the row count matches the page size", async () => {
    const source = [1, 2, 3, 4];
    const fetchPage = vi.fn(async (from: number, to: number) => ({
      data: source.slice(from, to + 1),
      error: null,
    }));

    await expect(fetchAllPages(fetchPage, { pageSize: 2 })).resolves.toEqual({
      data: source,
      error: null,
    });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("returns an error without exposing a partial result", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], error: null })
      .mockResolvedValueOnce({ data: null, error: "network error" });

    await expect(fetchAllPages<number, string>(fetchPage, { pageSize: 2 })).resolves.toEqual({
      data: null,
      error: "network error",
    });
  });

  it("rejects invalid page sizes", async () => {
    await expect(
      fetchAllPages(async () => ({ data: [], error: null }), { pageSize: 0 }),
    ).rejects.toThrow("pageSize must be a positive integer");
  });
});
