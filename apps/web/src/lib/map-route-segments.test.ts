import type { RouteGeometry } from "@astana/api-client";
import { expect, it } from "vitest";
import {
  journeyColor,
  journeyLegs,
  revealedLegs,
  RETURN_COLOR,
} from "./map-route-segments";

const route = (coordinates: [number, number][]): RouteGeometry => ({
  type: "LineString",
  coordinates,
});

it("keeps six ordered stops and their return distinct on one supplied path", () => {
  const points: [number, number][] = Array.from({ length: 7 }, (_, index) => [
    71.43 + index * 0.001,
    51.12,
  ]);
  const geometry = route([...points, points[0]]);
  const legs = journeyLegs(
    geometry,
    points.slice(1).map(([lon, lat]) => ({ lon, lat })),
    true,
  );
  expect(
    legs.map((leg) => `${leg.properties.from}→${leg.properties.to}`),
  ).toEqual(["S→1", "1→2", "2→3", "3→4", "4→5", "5→6", "6→S"]);
  expect(new Set(legs.map((leg) => leg.properties.color)).size).toBe(7);
  expect(legs.at(-1)!.geometry.coordinates.at(-1)).toEqual(points[0]);
});

it("colours the complete ordered provider path including the explicit return", () => {
  const geometry = route([
    [71.43, 51.12],
    [71.431, 51.121],
    [71.432, 51.12],
    [71.433, 51.121],
    [71.43, 51.12],
  ]);
  const legs = journeyLegs(
    geometry,
    [
      { lon: 71.431, lat: 51.121 },
      { lon: 71.432, lat: 51.12 },
      { lon: 71.433, lat: 51.121 },
    ],
    true,
  );
  expect(legs).toHaveLength(4);
  expect(
    legs.map((leg) => `${leg.properties.from}→${leg.properties.to}`),
  ).toEqual(["S→1", "1→2", "2→3", "3→S"]);
  expect(legs.map((leg) => leg.properties.color)).toEqual([
    journeyColor(0),
    journeyColor(1),
    journeyColor(2),
    RETURN_COLOR,
  ]);
  expect(
    legs.flatMap((leg, index) =>
      index ? leg.geometry.coordinates.slice(1) : leg.geometry.coordinates,
    ),
  ).toEqual(geometry.coordinates);
});

it("honours stop order when the same intersection occurs twice on a loop", () => {
  const geometry = route([
    [71.43, 51.12],
    [71.431, 51.121],
    [71.432, 51.12],
    [71.431, 51.121],
    [71.43, 51.122],
  ]);
  const legs = journeyLegs(
    geometry,
    [
      { lon: 71.432, lat: 51.12 },
      { lon: 71.431, lat: 51.121 },
    ],
    true,
  );
  expect(legs[0].geometry.coordinates).toEqual(
    geometry.coordinates.slice(0, 3),
  );
  expect(legs[1].geometry.coordinates).toEqual(
    geometry.coordinates.slice(2, 4),
  );
  expect(legs[2].geometry.coordinates).toEqual(geometry.coordinates.slice(3));
});

it("splits at road projections without drawing connectors to off-road places", () => {
  const geometry = route([
    [71.43, 51.12],
    [71.432, 51.12],
    [71.432, 51.122],
  ]);
  const legs = journeyLegs(geometry, [
    { lon: 71.431, lat: 51.1202 },
    { lon: 71.432, lat: 51.1222 },
  ]);
  expect(legs[0].geometry.coordinates.at(-1)).toEqual([71.431, 51.12]);
  expect(legs[1].geometry.coordinates[0]).toEqual([71.431, 51.12]);
  expect(legs[1].geometry.coordinates.at(-1)).toEqual(
    geometry.coordinates.at(-1),
  );
  for (const leg of legs)
    for (const [lon, lat] of leg.geometry.coordinates)
      expect(lat === 51.12 || lon === 71.432).toBe(true);
});

it("preserves the provider's final tail, handles repeats and never invents an approximate line", () => {
  expect(journeyLegs(null, [{ lon: 71.43, lat: 51.12 }])).toEqual([]);
  expect(
    journeyLegs(
      route([
        [71.43, 51.12],
        [71.43, 51.12],
      ]),
    ),
  ).toEqual([]);
  const geometry = route([
    [71.43, 51.12],
    [71.43, 51.12],
    [71.432, 51.12],
    [71.433, 51.121],
  ]);
  const legs = journeyLegs(geometry, [{ lon: 71.432, lat: 51.12 }]);
  expect(legs[0].geometry.coordinates).toEqual([
    [71.43, 51.12],
    [71.432, 51.12],
    [71.433, 51.121],
  ]);
  expect(revealedLegs(legs, 0)).toEqual([]);
  expect(revealedLegs(legs, 1)).toBe(legs);
  const partial = revealedLegs(legs, 0.25);
  expect(partial[0].geometry.coordinates.at(-1)![1]).toBe(51.12);
  expect(partial[0].geometry.coordinates.at(-1)![0]).toBeLessThan(71.432);
});
