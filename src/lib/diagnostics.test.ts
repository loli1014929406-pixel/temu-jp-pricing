import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDiagnostics,
  flushCentralDiagnostics,
  getRecentDiagnostics,
  isCredibleWebVitalValue,
  reportAppError,
  reportSlowOperation,
  sanitizeDiagnosticText,
  sanitizeDiagnosticTraceId,
  subscribeDiagnostics,
} from "./diagnostics";
import { getSupabaseClient } from "./supabase";

vi.mock("./supabase", () => ({ getSupabaseClient: vi.fn() }));

afterEach(() => {
  clearDiagnostics();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

  it("preserves valid trace IDs without allowing arbitrary text", () => {
    const traceId = "019ee9fd-ded7-7990-bfb3-1039438917c6";
    expect(sanitizeDiagnosticTraceId(traceId)).toBe(traceId);
    expect(sanitizeDiagnosticTraceId("Bearer secret token")).toBe("");
  });

  it("uploads the original valid trace ID", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(getSupabaseClient).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: "user-1" } } },
        }),
      },
      from: vi.fn().mockReturnValue({ insert }),
    } as never);
    const traceId = "019ee9fd-ded7-7990-bfb3-1039438917c6";

    reportSlowOperation("load-orders", 1200, { traceId });
    await flushCentralDiagnostics();

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ trace_id: traceId }),
    ]);
  });

  it("rejects impossible Web Vital samples from percentile calculations", () => {
    expect(isCredibleWebVitalValue("web-vital:LCP", 2500)).toBe(true);
    expect(isCredibleWebVitalValue("web-vital:LCP", 60_001)).toBe(false);
    expect(isCredibleWebVitalValue("web-vital:INP", Number.NaN)).toBe(false);
    expect(isCredibleWebVitalValue("web-vital:CLS", 250)).toBe(true);
    expect(isCredibleWebVitalValue("web-vital:CLS", 10_001)).toBe(false);
  });

  it("captures the event path and rotates the trace when the route changes", () => {
    const location = { pathname: "/orders" };
    vi.stubGlobal("window", {
      location,
      sessionStorage: { setItem: vi.fn() },
    });

    reportSlowOperation("load-orders", 1200);
    location.pathname = "/inventory";
    reportSlowOperation("load-inventory", 900);

    const [inventoryEvent, orderEvent] = getRecentDiagnostics();
    expect(orderEvent).toMatchObject({ path: "/orders", appVersion: expect.any(String) });
    expect(inventoryEvent).toMatchObject({ path: "/inventory", appVersion: expect.any(String) });
    expect(inventoryEvent?.traceId).not.toBe(orderEvent?.traceId);
  });
});
