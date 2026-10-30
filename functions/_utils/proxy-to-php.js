const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export async function proxyToPhp(context, routePrefix) {
  const configuredOrigin = context.env.PHP_API_ORIGIN;
  if (typeof configuredOrigin !== "string" || !configuredOrigin.trim()) {
    return Response.json(
      { error: "The PHP API origin is not configured." },
      { status: 503 }
    );
  }

  let origin;
  try {
    origin = new URL(configuredOrigin);
  } catch (error) {
    console.error("PHP_API_ORIGIN is not a valid URL:", error);
    return Response.json({ error: "The PHP API origin is invalid." }, { status: 500 });
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    return Response.json(
      { error: "PHP_API_ORIGIN must be an HTTP(S) origin without a path." },
      { status: 500 }
    );
  }

  const path = context.params.path;
  const pathSegments = Array.isArray(path) ? path : [path || ""];
  if (
    pathSegments.some((segment) =>
      !segment || segment === "." || segment === ".." || !/^[a-zA-Z0-9._-]+$/.test(segment)
    )
  ) {
    return new Response("Not found", { status: 404 });
  }

  const incomingUrl = new URL(context.request.url);
  const targetUrl = new URL(
    `${routePrefix}/${pathSegments.join("/")}`,
    origin
  );
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(context.request.headers);
  headers.delete("host");
  HOP_BY_HOP_HEADERS.forEach((header) => headers.delete(header));

  const requestOptions = {
    method: context.request.method,
    headers,
    redirect: "manual",
  };
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    requestOptions.body = context.request.body;
  }

  try {
    const upstream = await fetch(targetUrl, requestOptions);
    const responseHeaders = new Headers(upstream.headers);
    HOP_BY_HOP_HEADERS.forEach((header) => responseHeaders.delete(header));
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Could not reach the configured PHP API:", error);
    return Response.json(
      { error: "The PHP API could not be reached." },
      { status: 502 }
    );
  }
}
