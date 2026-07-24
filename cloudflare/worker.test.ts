import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyJapanPost, proxyYamato, withSecurityHeaders } from "./worker";

const authEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
} satisfies Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tracking worker", () => {
  it("requires authentication for both carrier endpoints", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const japanPostResponse = await proxyJapanPost(
      new Request("https://example.com/japanpost-tracking/services/srv/search/direct?reqCodeNo1=AB123456789JP"),
      authEnv,
    );
    const yamatoResponse = await proxyYamato(
      new Request("https://example.com/yamato-tracking/cgi-bin/tneko", {
        method: "POST",
        body: new URLSearchParams({ number01: "123456789012" }),
      }),
      authEnv,
    );

    expect(japanPostResponse.status).toBe(401);
    expect(yamatoResponse.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies an authenticated Japan Post request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("<html>tracking</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyJapanPost(
      new Request("https://example.com/japanpost-tracking/services/srv/search/direct?reqCodeNo1=AB123456789JP", {
        headers: { Authorization: "Bearer user-token" },
      }),
      authEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("tracking");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://project.supabase.co/auth/v1/user");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("trackings.post.japanpost.jp");
  });

  it("accepts the scoped internal secret for a Yamato request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(new Response("<html>yamato tracking</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyYamato(
      new Request("https://example.com/yamato-tracking/cgi-bin/tneko", {
        method: "POST",
        headers: { "x-tracking-proxy-secret": "scoped-secret" },
        body: new URLSearchParams({ number01: "766081370725" }),
      }),
      authEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("yamato tracking");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "verify_temu_tracking_proxy_secret",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "toi.kuronekoyamato.co.jp",
    );
  });

  it("adds browser security headers", () => {
    const response = withSecurityHeaders(new Response("ok"));

    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
