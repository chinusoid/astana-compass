import { expect, it, vi } from "vitest";
import type { Place } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import type { Map as LibreMap } from "maplibre-gl";
import { fitJourney, placePopup, routeArrows } from "./map-route";

it("includes stops outside the routed road in the full route overview", () => {
  const map = { fitBounds: vi.fn() };
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
