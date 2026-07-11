import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDiagnostics,
  getRecentDiagnostics,
  reportAppError,
  reportSlowOperation,
  sanitizeDiagnosticText,
  subscribeDiagnostics,
} from "./diagnostics";

afterEach(() => {
  clearDiagnostics();
  vi.restoreAllMocks();
});

describe("diagnostics", () => {
  it("sanitizes sensitive-looking values from error messages", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportAppError(
      new Error("account user@example.com order 123456789012 id 019ee9fd-ded7-7990-bfb3-1039438917c6"),
      "test",
    );

    expect(getRecentDiagnostics()[0]?.message).toBe(
      "account [email] order [number] id [id]",
    );
  });

  it("notifies subscribers when a slow operation is recorded", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiagnostics(listener);

    reportSlowOperation("load-orders", 5200);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]?.[0]).toMatchObject({
      type: "slow-operation",
      context: "load-orders",
      durationMs: 5200,
    });
    unsubscribe();
  });

  it("removes bearer tokens, JWTs, and secret query values", () => {
    expect(
      sanitizeDiagnosticText(
        "Bearer top-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature https://example.com?a=1&token=abc123&password=secret",
      ),
    ).toBe(
      "Bearer [redacted] [token] https://example.com?a=1&token=[redacted]&password=[redacted]",
    );
  });
});
