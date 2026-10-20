import { afterEach, expect, it, vi } from "vitest";
import type { Place, PlacePhotoResponse } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import {
  fetchPlacePhoto,
  hasPhotoIdentity,
  placePhotoResult,
} from "./place-photo";

const result: PlacePhotoResponse = {
  status: "available",
  photo: {
    url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Garden.jpg/960px-Garden.jpg",
    source_url: "https://commons.wikimedia.org/wiki/File:Garden.jpg",
    author: "Demir Berisha",
    license: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0",
    alt: "Фотография: Ботанический сад",
  },
};

afterEach(() => vi.unstubAllGlobals());

it("accepts complete canonical attribution and rejects inconsistent availability", () => {
  expect(placePhotoResult(result)).toEqual(result);
  expect(
    placePhotoResult({ status: "unavailable", photo: null }),
  ).not.toBeNull();
  expect(placePhotoResult({ ...result, photo: null })).toBeNull();
  expect(placePhotoResult({ ...result, status: "unavailable" })).toBeNull();
  expect(placePhotoResult({ status: "available", photo: {} })).toBeNull();
});

it("requires evidence for a real place identity", () => {
  const seed = examples.cases.find(
    (entry) => entry.name === "recommendations_valid",
  )!.instance as { places: Place[] };
  const place = structuredClone(seed.places[0]);
  expect(hasPhotoIdentity(place)).toBe(false);
  place.is_synthetic = false;
  place.facts = [
    {
      key: "osm:wikidata",
      status: "known",
      value: "Q104866948",
      evidence_ids: ["source"],
    },
  ];
  place.evidence = [
    {
      ...place.evidence[0],
      id: "source",
      source_type: "osm",
      is_synthetic: false,
    },
  ];
  expect(hasPhotoIdentity(place)).toBe(true);
  place.facts[0].evidence_ids = [];
  expect(hasPhotoIdentity(place)).toBe(false);
});

it.each([
  { url: "https://evil.example/Garden.jpg" },
  {
    url: result.photo!.url.replace(
      "thumb.wikimedia.org",
      "thumb.wikimedia.org.evil.test",
    ),
  },
  { url: result.photo!.url.replace("960px", "2000px") },
  { url: result.photo!.url + "?tracking=true" },
  { url: result.photo!.url.replace("https://", "https://secret@") },
  { source_url: "javascript:alert(1)" },
  { source_url: "https://commons.wikimedia.org/wiki/User:Photo" },
  { license_url: "https://creativecommons.org/licenses/by-nc/4.0/" },
  { license_url: "https://creativecommons.org.evil.test/licenses/by/4.0/" },
])("rejects unsafe or unbounded image/attribution URLs: %j", (patch) => {
  expect(
    placePhotoResult({ ...result, photo: { ...result.photo!, ...patch } }),
  ).toBeNull();
});

it("posts only place identity and language and preserves caller cancellation", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(result));
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  await expect(
    fetchPlacePhoto("osm:way/1196402246", "ru", controller.signal),
  ).resolves.toEqual(result);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/place-photo",
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ place_id: "osm:way/1196402246", locale: "ru" }),
    }),
  );
  controller.abort();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});

it("rejects invalid inputs before sending and fails safely on malformed/unavailable replies", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("error", { status: 503 }))
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchPlacePhoto("", "ru", new AbortController().signal),
  ).rejects.toThrow("invalid_photo_request");
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    fetchPlacePhoto("osm:way/1196402246", "ru", new AbortController().signal),
  ).rejects.toThrow("photo_unavailable");
  await expect(
    fetchPlacePhoto("osm:way/1196402246", "ru", new AbortController().signal),
  ).rejects.toThrow("invalid_photo_response");
});
