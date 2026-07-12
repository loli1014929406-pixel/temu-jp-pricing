const yamatoTrackingUrl = "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko";

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
    const upstreamResponse = await fetch(yamatoTrackingUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": request.headers["user-agent"] || "Mozilla/5.0",
      },
      body: getRequestBody(request),
      cache: "no-store",
    });
    const html = await upstreamResponse.text();

    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=UTF-8");
    response.status(upstreamResponse.status).send(html);
  } catch (error) {
    console.error("Yamato tracking proxy failed", error);
    response.status(502).send("Yamato tracking proxy failed");
  }
}
