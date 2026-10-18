import { NextRequest, NextResponse } from "next/server";
import { valid } from "@/lib/contracts";

export const dynamic = "force-dynamic";
const COOKIE = "astana_guest";
// A state may contain several rooms and their bounded photo histories. Cap the
// actual streamed bytes before decoding/parsing, not just Content-Length.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function readPayload(upstream: Response, signal: AbortSignal) {
  const encoding = upstream.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") {
    await upstream.body?.cancel();
    throw new Error("Unsupported upstream encoding");
  }
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Missing upstream body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Upstream response too large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const fail = (status: number, code: string) =>
  NextResponse.json(
    { error: { code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ operation: string }> },
) {
  const { operation } = await context.params;
  const allowed =
    request.method === "GET"
      ? ["state", "events"].includes(operation)
      : request.method === "POST" && ["session", "action"].includes(operation);
  if (!allowed) return fail(404, "not_found");
  // Cookie-authenticated writes must originate in this app, including session creation.
  // NextURL normalizes loopback IPs to localhost; the browser Origin uses Host.
  const publicOrigin = request.headers.get("host")
    ? `${request.nextUrl.protocol}//${request.headers.get("host")}`
    : new URL(request.url).origin;
  if (
    request.method === "POST" &&
    request.headers.get("origin") !== publicOrigin
  )
    return fail(403, "origin_rejected");
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
      return fail(503, "provider_unavailable");
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(32000),
    ]);
    let body: Uint8Array | undefined;
    if (request.method === "POST") {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        while (reader) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.length;
          if (size > 32768) {
            await reader.cancel();
            return fail(422, "invalid_request");
          }
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const token = request.cookies.get(COOKIE)?.value;
    const upstream = await fetch(new URL(`/v1/social/${operation}`, origin), {
      method: request.method,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
        ...(token && /^[A-Za-z0-9_-]{40,64}$/.test(token)
          ? { Authorization: `Bearer ${token}` }
          : {}),
      },
      body: body as BodyInit | undefined,
      cache: "no-store",
      signal,
      redirect: "error",
    });
    const payload = await readPayload(upstream, signal);
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const key of ["X-Astana-Data-Mode", "X-Request-ID", "Retry-After"]) {
      const value = upstream.headers.get(key);
      if (value) responseHeaders.set(key, value);
    }
    const cookieOptions = {
      httpOnly: true,
      sameSite: "strict" as const,
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 86400,
    };
    if (upstream.ok && operation === "session") {
      if (!valid("SocialSessionResponse", payload))
        return fail(503, "provider_unavailable");
      const response = NextResponse.json(payload.state, {
        headers: responseHeaders,
      });
      response.cookies.set(COOKIE, payload.token, cookieOptions);
      return response;
    }
    if (
      upstream.ok &&
      !valid(
        operation === "events"
          ? "CommunityEvents"
          : operation === "action"
            ? "SocialActionResponse"
            : "SocialState",
        payload,
      )
    )
      return fail(503, "provider_unavailable");
    const response = NextResponse.json(payload, {
      status: upstream.status,
      headers: responseHeaders,
    });
    if (upstream.status === 401 || payload.signed_out === true)
      response.cookies.set(COOKIE, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch {
    return fail(503, "provider_unavailable");
  }
}
export const GET = proxy;
export const POST = proxy;
