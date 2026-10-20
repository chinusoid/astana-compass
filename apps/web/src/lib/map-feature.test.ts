import { afterEach, expect, it, vi } from "vitest";
import {
  fetchMapFeatures,
  mapFeaturesResult,
  safeSourceUrl,
} from "./map-feature";

const feature = {
  id: "osm:way:123",
  name: "Building",
  kind: "building",
  description: null,
  address: null,
  location: { lat: 51.13, lon: 71.44 },
  match: "nearby",
  distance_meters: 20,
  attributes: [],
  source_url: "https://www.openstreetmap.org/way/123",
  source_label: "OpenStreetMap",
};
const result = {
  status: "ok",
  features: [feature],
  retrieved_at: "2026-10-19T10:00:00Z",
  attribution: "© OpenStreetMap contributors",
};
afterEach(() => vi.unstubAllGlobals());

it("accepts canonical facts with location, proximity and attribution", () => {
  expect(mapFeaturesResult(result)).toEqual(result);
  expect(
    mapFeaturesResult({ ...result, status: "empty", features: [] }),
  ).not.toBeNull();
});
it("rejects incomplete, inconsistent or unsafe provider responses", () => {
  expect(mapFeaturesResult({ status: "ok", features: [feature] })).toBeNull();
  expect(mapFeaturesResult({ ...result, features: [] })).toBeNull();
  expect(
    mapFeaturesResult({ ...result, features: [feature, feature] }),
  ).toBeNull();
  expect(
    mapFeaturesResult({
      ...result,
      features: [{ ...feature, match: "exact" }],
    }),
  ).toBeNull();
  expect(
    mapFeaturesResult({
      ...result,
      features: [{ ...feature, source_url: "javascript:alert(1)" }],
    }),
  ).toBeNull();
  expect(safeSourceUrl("https://user:secret@example.org")).toBeNull();
});
it("submits only explicit map location and locale and exposes provider cooldown", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(
    fetchMapFeatures(feature.location, "kk", signal),
  ).rejects.toMatchObject({ code: "busy" });
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/map-features",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ location: feature.location, locale: "kk" }),
      signal,
    }),
  );
});
