// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("does not expose arbitrary backend paths", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const response = await GET(new NextRequest("http://localhost/api/v1/admin"), {
    params: Promise.resolve({ path: ["admin"] }),
  });
  expect(response.status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
it("forwards supported query fields and data-mode without browser credentials", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { places: [], next_cursor: null },
        { headers: { "X-Astana-Data-Mode": "live" } },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const response = await GET(
    new NextRequest(
      "http://localhost/api/v1/places?query=museum&key=untrusted",
      {
        headers: { Cookie: "session=private", Authorization: "Bearer private" },
      },
    ),
    { params: Promise.resolve({ path: ["places"] }) },
  );
  expect(response.headers.get("X-Astana-Data-Mode")).toBe("live");
  const [url, options] = fetch.mock.calls[0];
  expect(url.searchParams.has("key")).toBe(false);
  expect(options.headers).not.toHaveProperty("Cookie");
  expect(options.headers).not.toHaveProperty("Authorization");
});
it("rejects an oversized request before forwarding", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const response = await POST(
    new NextRequest("http://localhost/api/v1/recommendations", {
      method: "POST",
      body: "x".repeat(32769),
    }),
    { params: Promise.resolve({ path: ["recommendations"] }) },
  );
  expect(response.status).toBe(422);
  expect(fetch).not.toHaveBeenCalled();
});
it("cancels a pending body read when the client disconnects", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const request = new NextRequest("http://localhost/api/v1/recommendations", {
    method: "POST",
    body,
    signal: controller.signal,
  });
  const result = POST(request, {
    params: Promise.resolve({ path: ["recommendations"] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  expect((await result).status).toBe(503);
  expect(cancel).toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
