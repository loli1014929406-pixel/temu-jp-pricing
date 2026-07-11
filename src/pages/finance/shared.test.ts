import { describe, expect, it } from "vitest";
import { formatDate, getDateKey, getMonthKey } from "./shared";

describe("finance business dates", () => {
  it("keeps timezone-free Temu timestamps on their written calendar date", () => {
    expect(getDateKey("2026-07-01 00:30:00")).toBe("2026-07-01");
    expect(getMonthKey("2026/07/01 00:30:00")).toBe("2026-07");
  });

  it("converts explicit UTC timestamps to the Asia/Tokyo business date", () => {
    expect(getDateKey("2026-06-30T16:30:00Z")).toBe("2026-07-01");
    expect(getMonthKey("2026-06-30T16:30:00+00:00")).toBe("2026-07");
  });

  it("keeps explicit Japan timestamps in the same business month", () => {
    expect(formatDate("2026-07-01T00:30:00+09:00")).toBe("2026-07-01");
  });

  it("returns stable fallbacks for invalid dates", () => {
    expect(getDateKey("2026-02-31")).toBe("");
    expect(getMonthKey("not-a-date")).toBe("未定");
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});
