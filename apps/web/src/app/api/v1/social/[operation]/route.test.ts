// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const state = {
  profile: { id: "guest", name: "Guest" },
  friend_code: "invite",
  friends: [],
  friend_requests: [],
  party_invites: [],
  parties: [],
  expires_at: "2026-10-20T00:00:00Z",
};
const token = "a".repeat(43);
const context = (operation: string) => ({
  params: Promise.resolve({ operation }),
});

it("keeps exact browser host checks when Next normalizes a loopback URL", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ token, state }));
  vi.stubGlobal("fetch", fetch);
  const make = (origin: string) =>
    new NextRequest("http://127.0.0.1:13000/api/v1/social/session", {
      method: "POST",
      headers: { Origin: origin, Host: "127.0.0.1:13000" },
      body: '{"name":"Guest"}',
    });
  expect(
    (await POST(make("http://127.0.0.1:13000"), context("session"))).status,
  ).toBe(200);
  expect(
    (await POST(make("http://localhost:13000"), context("session"))).status,
  ).toBe(403);
});

it("sets a private cookie and never exposes the backend bearer token to JavaScript", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ token, state })),
  );
  const response = await POST(
    new NextRequest("https://compass.example/api/v1/social/session", {
      method: "POST",
      headers: { Origin: "https://compass.example" },
      body: JSON.stringify({ name: "Guest" }),
    }),
    context("session"),
  );
  expect(await response.json()).toEqual(state);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=strict");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("Max-Age=604800");
  expect(cookie).toContain("Path=/");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("rejects cross-origin writes before reading credentials or forwarding", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const response = await POST(
    new NextRequest("https://compass.example/api/v1/social/action", {
      method: "POST",
      headers: {
        Origin: "https://other.example",
        Cookie: `astana_guest=${token}`,
      },
      body: "{}",
    }),
    context("action"),
  );
  expect(response.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});

it("forwards only the guest cookie as bearer, omitting unrelated cookies and injected authorization", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(state));
  vi.stubGlobal("fetch", fetch);
  const response = await GET(
    new NextRequest("https://compass.example/api/v1/social/state", {
      headers: {
        Cookie: `other=private; astana_guest=${token}`,
        Authorization: "Bearer injected",
      },
    }),
    context("state"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
  expect(fetch.mock.calls[0][1].redirect).toBe("manual");
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("Cookie");
  // Reading state must not renew the original seven-day session deadline.
  expect(response.headers.get("set-cookie")).toBeNull();
});

it.each([301, 302, 303, 307, 308])(
  "rejects upstream %s redirects without forwarding the guest bearer",
  async (status) => {
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status,
        headers: { Location: "https://other.example/private" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await GET(
      new NextRequest("https://compass.example/api/v1/social/state", {
        headers: { Cookie: `astana_guest=${token}` },
      }),
      context("state"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "provider_unavailable" },
    });
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it("clears expired guest sessions and rejects unknown resources", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { code: "session_required" } }, { status: 401 }),
    );
  vi.stubGlobal("fetch", fetch);
  const response = await GET(
    new NextRequest("https://compass.example/api/v1/social/state"),
    context("state"),
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    (
      await GET(
        new NextRequest("https://compass.example/api/v1/social/admin"),
        context("admin"),
      )
    ).status,
  ).toBe(404);
  expect(fetch).toHaveBeenCalledOnce();
});

it("bounds photo writes and rejects malformed session responses", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ token, state: { ...state, friend_code: null } }),
    );
  vi.stubGlobal("fetch", fetch);
  const request = (body: string) =>
    new NextRequest("http://localhost/api/v1/social/session", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body,
    });
  expect(
    (await POST(request("x".repeat(32769)), context("session"))).status,
  ).toBe(422);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (await POST(request('{"name":"Guest"}'), context("session"))).status,
  ).toBe(503);
});

it("validates successful state and action responses before exposing them", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...state, token: "private-upstream-secret" }),
      ),
  );
  const response = await GET(
    new NextRequest("https://compass.example/api/v1/social/state"),
    context("state"),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private-upstream-secret");
});

it("forwards canonical logout and clears the private cookie", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ signed_out: true })),
  );
  const response = await POST(
    new NextRequest("https://compass.example/api/v1/social/action", {
      method: "POST",
      headers: { Origin: "https://compass.example" },
      body: '{"action":"logout"}',
    }),
    context("action"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ signed_out: true });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});

it("caps streamed upstream replies even without Content-Length and cancels the reader", async () => {
  let emitted = 0;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        emitted++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  const response = await GET(
    new NextRequest("https://compass.example/api/v1/social/state"),
    context("state"),
  );
  expect(response.status).toBe(503);
  expect(emitted).toBe(17);
  expect(cancelled).toHaveBeenCalledOnce();
});

it("requests identity encoding and rejects encoded responses without reading them", async () => {
  const pull = vi.fn();
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    { pull, cancel: cancelled },
    { highWaterMark: 0 },
  );
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(body, { headers: { "Content-Encoding": "gzip" } }),
    );
  vi.stubGlobal("fetch", fetch);
  const response = await GET(
    new NextRequest("https://compass.example/api/v1/social/state"),
    context("state"),
  );
  expect(response.status).toBe(503);
  expect(fetch.mock.calls[0][1].headers["Accept-Encoding"]).toBe("identity");
  expect(pull).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledOnce();
});

it("cancels a stalled upstream body when the incoming request is aborted", async () => {
  const controller = new AbortController();
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  const pending = GET(
    new NextRequest("https://compass.example/api/v1/social/state", {
      signal: controller.signal,
    }),
    context("state"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const response = await pending;
  expect(response.status).toBe(503);
  expect(cancelled).toHaveBeenCalledOnce();
});
