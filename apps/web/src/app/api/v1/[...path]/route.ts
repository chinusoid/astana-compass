import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
function failure(status: number) {
  return Response.json(
    {
      request_id: crypto.randomUUID(),
      error: {
        code:
          status === 404
            ? "not_found"
            : status === 422
              ? "invalid_request"
              : "provider_unavailable",
        message: "Request could not be completed",
        retryable: status === 503,
        details: [],
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const getAllowed =
    request.method === "GET" &&
    ((path.length === 1 && ["places", "data-status"].includes(path[0])) ||
      (path[0] === "places" && path.length > 1));
  const postAllowed =
    request.method === "POST" &&
    path.length === 1 &&
    ["recommendations", "itineraries", "feedback"].includes(path[0]);
  if (!getAllowed && !postAllowed) return failure(404);
  try {
    const origin = new URL(
      process.env.ASTANA_API_URL ?? "http://127.0.0.1:8000",
    );
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      return failure(503);
    const target = new URL(
      `/v1/${path.map(encodeURIComponent).join("/")}`,
      origin,
    );
    if (getAllowed && path.length === 1 && path[0] === "places") {
      for (const key of ["bbox", "query", "categories", "cursor", "limit"]) {
        const value = request.nextUrl.searchParams.get(key);
        if (value !== null) target.searchParams.set(key, value);
      }
    }
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(32000),
    ]);
    let body: Uint8Array | undefined;
    if (postAllowed) {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancelRead = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancelRead, { once: true });
      try {
        signal.throwIfAborted();
        while (reader) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.length;
          if (size > 32768) {
            await reader.cancel();
            return failure(422);
          }
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener("abort", cancelRead);
      }
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(postAllowed ? { "Content-Type": "application/json" } : {}),
      },
      body: body as BodyInit | undefined,
      cache: "no-store",
      signal,
      redirect: "error",
    });
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    for (const key of ["X-Request-ID", "X-Astana-Data-Mode", "Retry-After"]) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return failure(503);
  }
}
export const GET = proxy;
export const POST = proxy;
