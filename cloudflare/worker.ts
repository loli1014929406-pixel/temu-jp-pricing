const yamatoTrackingPath = "/yamato-tracking/cgi-bin/tneko";
const yamatoTrackingUrl = "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko";
const japanPostTrackingPath = "/japanpost-tracking/services/srv/search/direct";
const japanPostTrackingUrl = "https://trackings.post.japanpost.jp/services/srv/search/direct";
const maxBodyBytes = 1024;
const requestTimeoutMs = 10_000;
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
].join("; ");

type TrackingAuthEnv = Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">;

export function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", contentSecurityPolicy);
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function textResponse(body: string, status: number, extraHeaders?: HeadersInit) {
  return withSecurityHeaders(new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=UTF-8",
      ...extraHeaders,
    },
  }));
}

function proxyResponse(upstreamResponse: Response) {
  return withSecurityHeaders(new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": upstreamResponse.headers.get("Content-Type") || "text/html; charset=UTF-8",
    },
  }));
}

function isTimeoutError(error: unknown) {
  return error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

async function verifySupabaseUser(request: Request, env: TrackingAuthEnv) {
  const authorization = request.headers.get("Authorization") || "";
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { ok: false, response: textResponse("Tracking proxy authentication is not configured", 500) };
  }
  if (!authorization.startsWith("Bearer ")) {
    return { ok: false, response: textResponse("Unauthorized", 401) };
  }

  const authResponse = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const ok = authResponse.ok;
  await authResponse.body?.cancel();
  return ok
    ? { ok: true as const }
    : { ok: false as const, response: textResponse("Unauthorized", 401) };
}

export async function proxyYamato(request: Request, env: TrackingAuthEnv) {
  if (request.method !== "POST") {
    return textResponse("Method Not Allowed", 405, { Allow: "POST" });
  }

  try {
    const authentication = await verifySupabaseUser(request, env);
    if (!authentication.ok) return authentication.response;

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > maxBodyBytes) return textResponse("Request body too large", 413);

    const bodyBytes = await request.arrayBuffer();
    if (bodyBytes.byteLength > maxBodyBytes) return textResponse("Request body too large", 413);

    const params = new URLSearchParams(new TextDecoder().decode(bodyBytes));
    const trackingNo = String(params.get("number01") || "").trim();
    if (!/^\d{10,14}$/.test(trackingNo)) {
      return textResponse("Invalid tracking number", 400);
    }

    const upstreamResponse = await fetch(yamatoTrackingUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
      },
      body: new URLSearchParams({ number01: trackingNo, category: "0" }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return proxyResponse(upstreamResponse);
  } catch (error) {
    console.error(JSON.stringify({
      event: "tracking_proxy_error",
      carrier: "yamato",
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return textResponse("Yamato tracking proxy failed", isTimeoutError(error) ? 504 : 502);
  }
}

export async function proxyJapanPost(request: Request, env: TrackingAuthEnv) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse("Method Not Allowed", 405, { Allow: "GET, HEAD" });
  }

  try {
    const authentication = await verifySupabaseUser(request, env);
    if (!authentication.ok) return authentication.response;

    const requestUrl = new URL(request.url);
    const trackingNo = String(requestUrl.searchParams.get("reqCodeNo1") || "").trim();
    if (!/^[A-Za-z0-9-]{8,32}$/.test(trackingNo)) {
      return textResponse("Invalid tracking number", 400);
    }

    const upstreamUrl = new URL(japanPostTrackingUrl);
    upstreamUrl.search = new URLSearchParams({
      reqCodeNo1: trackingNo,
      searchKind: "S002",
      locale: "ja",
    }).toString();
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return proxyResponse(upstreamResponse);
  } catch (error) {
    console.error(JSON.stringify({
      event: "tracking_proxy_error",
      carrier: "japan_post",
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return textResponse("Japan Post tracking proxy failed", isTimeoutError(error) ? 504 : 502);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === yamatoTrackingPath) return proxyYamato(request, env);
    if (pathname === japanPostTrackingPath) return proxyJapanPost(request, env);
    if (pathname.startsWith("/yamato-tracking/") || pathname.startsWith("/japanpost-tracking/")) {
      return textResponse("Not Found", 404);
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
