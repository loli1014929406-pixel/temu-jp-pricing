const yamatoTrackingUrl = "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko";
const maxBodyBytes = 1024;
const requestTimeoutMs = 10_000;

function getRequestBody(request) {
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  if (request.body && typeof request.body === "object") {
    return new URLSearchParams(request.body).toString();
  }
  return "";
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    const authorization = String(request.headers.authorization || "");
    if (!supabaseUrl || !supabaseAnonKey) {
      response.status(500).send("Tracking proxy authentication is not configured");
      return;
    }
    if (!authorization.startsWith("Bearer ")) {
      response.status(401).send("Unauthorized");
      return;
    }
    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: authorization },
      signal: AbortSignal.timeout(requestTimeoutMs),
      cache: "no-store",
    });
    if (!authResponse.ok) {
      response.status(401).send("Unauthorized");
      return;
    }

    const body = getRequestBody(request);
    if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
      response.status(413).send("Request body too large");
      return;
    }
    const params = new URLSearchParams(body);
    const trackingNo = String(params.get("number01") || "").trim();
    if (!/^\d{10,14}$/.test(trackingNo)) {
      response.status(400).send("Invalid tracking number");
      return;
    }
    const upstreamResponse = await fetch(yamatoTrackingUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": request.headers["user-agent"] || "Mozilla/5.0",
      },
      body: new URLSearchParams({ number01: trackingNo, category: "0" }).toString(),
      signal: AbortSignal.timeout(requestTimeoutMs),
      cache: "no-store",
    });
    const html = await upstreamResponse.text();

    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=UTF-8");
    response.status(upstreamResponse.status).send(html);
  } catch (error) {
    console.error("Yamato tracking proxy failed", error);
    response.status(error?.name === "TimeoutError" ? 504 : 502).send("Yamato tracking proxy failed");
  }
}
