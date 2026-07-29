import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  withTimeout: vi.fn(async (value: PromiseLike<unknown>) => await value),
}));

vi.mock("./supabase-helpers", () => ({
  requireSession: mocks.requireSession,
  withTimeout: mocks.withTimeout,
}));

import {
  getEdgeFunctionErrorMessage,
  refreshTemuTrackingForOrderIds,
  type TrackingRefreshResult,
} from "./order-tracking";

const successfulResult: TrackingRefreshResult = {
  source: "manual",
  queriedOrderCount: 1,
  updatedOrderCount: 1,
  deliveredOrderCount: 0,
  exceptionOrderCount: 0,
  failedOrderCount: 0,
  failures: [],
};

describe("refreshTemuTrackingForOrderIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the session and explicitly sends the latest access token", async () => {
    const refreshSession = vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: "fresh-access-token",
        },
      },
      error: null,
    });
    const invoke = vi.fn().mockResolvedValue({
      data: successfulResult,
      error: null,
    });
    mocks.requireSession.mockResolvedValue({
      supabase: {
        auth: { refreshSession },
        functions: { invoke },
      },
    });

    await expect(
      refreshTemuTrackingForOrderIds(["order-id"]),
    ).resolves.toEqual(successfulResult);

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("refresh-temu-tracking", {
      body: { source: "manual", orderIds: ["order-id"] },
      headers: {
        Authorization: "Bearer fresh-access-token",
      },
    });
  });

  it("shows the Edge Function response instead of the generic HTTP error", async () => {
    const invokeError = {
      context: new Response(
        JSON.stringify({ error: "登录状态已失效，请重新登录。" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
      message: "Edge Function returned a non-2xx status code",
    };
    mocks.requireSession.mockResolvedValue({
      supabase: {
        auth: {
          refreshSession: vi.fn().mockResolvedValue({
            data: {
              session: {
                access_token: "fresh-access-token",
              },
            },
            error: null,
          }),
        },
        functions: {
          invoke: vi.fn().mockResolvedValue({
            data: null,
            error: invokeError,
          }),
        },
      },
    });

    await expect(
      refreshTemuTrackingForOrderIds(["order-id"]),
    ).rejects.toThrow("登录状态已失效，请重新登录。");
  });

  it("requires a new login when the session cannot be refreshed", async () => {
    mocks.requireSession.mockResolvedValue({
      supabase: {
        auth: {
          refreshSession: vi.fn().mockResolvedValue({
            data: { session: null },
            error: new Error("Invalid Refresh Token"),
          }),
        },
      },
    });

    await expect(
      refreshTemuTrackingForOrderIds(["order-id"]),
    ).rejects.toThrow("当前登录已失效，请重新登录后再查询物流状态。");
  });
});

describe("getEdgeFunctionErrorMessage", () => {
  it("falls back to a normal error message", async () => {
    await expect(
      getEdgeFunctionErrorMessage(new Error("网络异常"), "查询失败"),
    ).resolves.toBe("网络异常");
  });
});
