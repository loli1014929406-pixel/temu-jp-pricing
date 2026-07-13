import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("preserves result order and caps active work", async () => {
    let active = 0;
    let maxActive = 0;
    const progress: number[] = [];

    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return value * 10;
      },
      (completed) => progress.push(completed),
    );

    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects invalid concurrency", async () => {
    await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow(
      "positive integer",
    );
  });
});
