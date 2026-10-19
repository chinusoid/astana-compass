import { afterEach, expect, it, vi } from "vitest";
import type { MapFeatureResponse } from "@astana/api-client";
import { fetchPlaceDirectory, placeDirectoryResult } from "./place-directory";

const result: MapFeatureResponse = {
  status: "ok",
  retrieved_at: "2026-10-20T10:00:00Z",
  attribution: "© 2ГИС",
  features: [
    {
      id: "twogis:branch:123",
      name: "Cafe branch",
      kind: "cafe",
      description: null,
      address: "Street 1",
      location: { lat: 51.13, lon: 71.44 },
      match: "nearby",
      distance_meters: 15,
      attributes: [{ label: "Часы работы", value: "Пн: 09:00–18:00" }],
      source_url: "https://2gis.kz/astana/firm/123",
      source_label: "2ГИС",
    },
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses the canonical response and rejects foreign identities, mismatched links and duplicate candidates", () => {
  expect(placeDirectoryResult(result)).toEqual(result);
  expect(
    placeDirectoryResult({ ...result, status: "empty", features: [] }),
  ).not.toBeNull();
  for (const patch of [
    { id: "osm:way:123" },
    { source_url: "https://2gis.kz/astana/firm/456" },
    { source_url: "https://2gis.kz.evil.test/astana/firm/123" },
    { source_url: "javascript:alert(1)" },
    { distance_meters: -1 },
  ])
    expect(
      placeDirectoryResult({
        ...result,
        features: [{ ...result.features[0], ...patch }],
      }),
    ).toBeNull();
  expect(
    placeDirectoryResult({
      ...result,
      features: [result.features[0], result.features[0]],
    }),
  ).toBeNull();
  expect(placeDirectoryResult({ ...result, status: "empty" })).toBeNull();
});
it("posts only catalogue identity and language without credentials or caching", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(result));
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  await expect(
    fetchPlaceDirectory("osm:way/987", "kk", controller.signal),
  ).resolves.toEqual(result);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/place-directory",
    expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      body: JSON.stringify({ place_id: "osm:way/987", locale: "kk" }),
    }),
  );
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  controller.abort();
  expect(signal.aborted).toBe(true);
});
it("rejects an invalid input before making a request", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchPlaceDirectory("", "ru", new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  [429, "busy"],
  [503, "unavailable"],
  [403, "unavailable"],
])("reports HTTP %s safely", async (status, code) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("provider body is not UI copy", {
        status: Number(status),
      }),
    ),
  );
  await expect(
    fetchPlaceDirectory("osm:way/987", "ru", new AbortController().signal),
  ).rejects.toMatchObject({ code });
});
it("rejects malformed JSON and converts network failures into a recoverable state", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("not JSON"))
    .mockRejectedValueOnce(new TypeError("Network failed"));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchPlaceDirectory("osm:way/987", "ru", new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    fetchPlaceDirectory("osm:way/987", "ru", new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});
