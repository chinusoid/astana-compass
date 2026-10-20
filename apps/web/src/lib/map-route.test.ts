import { expect, it, vi } from "vitest";
import type { Place } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { Map as MapLibreMap, type Map as LibreMap } from "maplibre-gl";
import { fitJourney, placePopup, routeArrows } from "./map-route";

function overviewMap(width = 900, height = 650) {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  return {
    fitBounds: vi.fn(),
    resize: vi.fn(),
    getContainer: () => host,
    getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
}

it("includes stops outside the routed road in the full route overview", () => {
  const map = overviewMap();
  fitJourney(
    map as unknown as LibreMap,
    {
      type: "LineString",
      coordinates: [
        [71.43, 51.12],
        [71.44, 51.13],
      ],
    },
    [
      { lon: 71.45, lat: 51.14 },
      { lon: 71.42, lat: 51.11 },
    ],
  );
  expect(map.fitBounds).toHaveBeenCalledWith(
    [
      [71.42, 51.11],
      [71.45, 51.14],
    ],
    expect.objectContaining({ duration: 0 }),
  );
  fitJourney(map as unknown as LibreMap, null);
  expect(map.fitBounds).toHaveBeenCalledOnce();
});

it.each([
  [390, 170],
  [130, 170],
  [390, 60],
  [40, 30],
])("keeps a finite camera in a %d by %d mobile viewport", (width, height) => {
  const map = overviewMap(width, height);
  let camera: LibreMap["_camera"] | undefined;
  const skipRenderer = new Error("Camera-only test, before creating WebGL");
  const setup = vi
    .spyOn(MapLibreMap.prototype, "_setupContainer")
    .mockImplementation(function (this: LibreMap) {
      camera = this._camera;
      throw skipRenderer;
    });
  try {
    new MapLibreMap({ container: document.createElement("div") });
  } catch (error) {
    if (error !== skipRenderer) throw error;
  } finally {
    setup.mockRestore();
  }
  if (!camera) throw new Error("The map camera was not initialized");
  const actualCamera = camera;
  actualCamera.setPadding({ top: 5, right: 5, bottom: 5, left: 5 });
  map.getPadding = () => {
    const padding = actualCamera.getPadding();
    return {
      top: padding.top ?? 0,
      right: padding.right ?? 0,
      bottom: padding.bottom ?? 0,
      left: padding.left ?? 0,
    };
  };
  map.resize.mockImplementation(() =>
    actualCamera.transform.resize(width, height, true),
  );
  map.fitBounds.mockImplementation(
    (
      bounds: Parameters<LibreMap["fitBounds"]>[0],
      options: Parameters<LibreMap["fitBounds"]>[1],
    ) => {
      const fitted = actualCamera.cameraForBounds(bounds, options);
      expect(fitted).toBeDefined();
      expect(Number.isFinite(fitted!.zoom)).toBe(true);
      const center = fitted!.center as { lng: number; lat: number };
      expect(Number.isFinite(center.lng)).toBe(true);
      expect(Number.isFinite(center.lat)).toBe(true);
    },
  );
  expect(
    fitJourney(map as unknown as LibreMap, null, [
      { lon: 71.43, lat: 51.12 },
      { lon: 71.44, lat: 51.13 },
    ]),
  ).toBe(true);
  const options = map.fitBounds.mock.calls[0][1];
  const { top, right, bottom, left } = options.padding;
  const availableWidth = width - 10 - left - right;
  const availableHeight = height - 10 - top - bottom;
  expect(availableWidth).toBeGreaterThan(0);
  expect(availableHeight).toBeGreaterThan(0);
  expect(map.resize.mock.invocationCallOrder[0]).toBeLessThan(
    map.fitBounds.mock.invocationCallOrder[0],
  );
});

it.each([
  [0, 170],
  [390, 0],
  [1, 170],
  [390, Number.NaN],
])("defers fitting an unmeasurable %d by %d map", (width, height) => {
  const map = overviewMap(width, height);
  expect(
    fitJourney(map as unknown as LibreMap, null, [{ lon: 71.43, lat: 51.12 }]),
  ).toBe(false);
  expect(map.fitBounds).not.toHaveBeenCalled();
});

it.each([
  { lon: Number.NaN, lat: 51.12 },
  { lon: 71.43, lat: Number.POSITIVE_INFINITY },
  { lon: 71.43, lat: 90 },
  { lon: 181, lat: 51.12 },
])("does not send invalid bounds to the map camera (%j)", (stop) => {
  const map = overviewMap();
  expect(fitJourney(map as unknown as LibreMap, null, [stop])).toBe(false);
  expect(map.fitBounds).not.toHaveBeenCalled();
});

it("does not suppress an unexpected map failure for a valid viewport and bounds", () => {
  const map = overviewMap();
  map.fitBounds.mockImplementation(() => {
    throw new Error("Unexpected map failure");
  });
  expect(() =>
    fitJourney(map as unknown as LibreMap, null, [{ lon: 71.43, lat: 51.12 }]),
  ).toThrow("Unexpected map failure");
});

it("follows a bend in the provider route with arrows facing each segment", () => {
  const route = {
    type: "LineString" as const,
    coordinates: [
      [71.43, 51.12],
      [71.433, 51.12],
      [71.433, 51.123],
    ] as [number, number][],
  };
  const arrows = routeArrows(route).features;
  expect(arrows.length).toBeGreaterThan(2);
  expect(arrows.some((arrow) => arrow.properties?.bearing === 90)).toBe(true);
  expect(arrows.some((arrow) => arrow.properties?.bearing === 0)).toBe(true);
  for (const arrow of arrows) {
    const [lon, lat] = arrow.geometry.coordinates;
    expect(lat === 51.12 || lon === 71.433).toBe(true);
  }
  expect(routeArrows(null).features).toEqual([]);
});

it("keeps arrow work bounded for long routes and skips repeated vertices", () => {
  expect(
    routeArrows({
      type: "LineString",
      coordinates: [
        [71, 51],
        [71, 51],
        [72, 51],
      ],
    }).features.length,
  ).toBeLessThanOrEqual(61);
  expect(
    routeArrows({
      type: "LineString",
      coordinates: [
        [71, 51],
        [71, 51],
      ],
    }).features,
  ).toHaveLength(0);
});

it("keeps map previews compact and opens the full card for descriptions", () => {
  const place = structuredClone(
    examples.cases.find((entry) => entry.name === "place_valid")!.instance,
  ) as Place;
  place.name = "<img src=x onerror=alert(1)>";
  place.description = "A description supplied by the source";
  place.evidence[0].source_url = "javascript:alert(1)";
  const open = vi.fn();
  const popup = placePopup(place, "en", 0, open);
  expect(popup.querySelector("img")).toBeNull();
  expect(popup.textContent).toContain(place.name);
  expect(popup.textContent).not.toContain(place.description);
  expect(popup.textContent).toContain("This is your first destination");
  expect(popup.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(popup.querySelector("dl")).toBeNull();
  popup.querySelector("button")!.click();
  expect(open).toHaveBeenCalledOnce();
});
