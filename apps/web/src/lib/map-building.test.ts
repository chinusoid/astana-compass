import { expect, it } from "vitest";
import { buildingLookupPoint } from "./map-building";

const ring = (points: number[][]) =>
  points.map(([x, y]) => [71.4 + x / 1000, 51.1 + y / 1000]);
const box = ring([
  [0, 0],
  [6, 0],
  [6, 6],
  [0, 6],
  [0, 0],
]);

it("chooses an interior footprint point rather than an exterior concave bbox centre", () => {
  // C-shaped building: bbox centre (3, 3) is outside the building.
  const outline = ring([
    [0, 0],
    [6, 0],
    [6, 1],
    [1, 1],
    [1, 5],
    [6, 5],
    [6, 6],
    [0, 6],
    [0, 0],
  ]);
  const point = buildingLookupPoint({
    type: "Polygon",
    coordinates: [outline],
  })!;
  expect(point).not.toBeNull();
  expect(point.lon).toBeGreaterThan(71.4);
  expect(point.lon).toBeLessThan(71.406);
  expect(point.lat).toBeGreaterThan(51.1);
  expect(point.lat).toBeLessThan(51.106);
  expect(point.lon < 71.401 || point.lat < 51.101 || point.lat > 51.105).toBe(
    true,
  );
});

it.each([false, true])(
  "excludes courtyards regardless of winding (reversed=%s)",
  (reversed) => {
    const hole = ring([
      [1, 1],
      [5, 1],
      [5, 5],
      [1, 5],
      [1, 1],
    ]);
    const coordinates = reversed
      ? [[...box].reverse(), [...hole].reverse()]
      : [box, hole];
    const point = buildingLookupPoint({ type: "Polygon", coordinates })!;
    expect(point).not.toBeNull();
    expect(
      point.lon > 71.401 &&
        point.lon < 71.405 &&
        point.lat > 51.101 &&
        point.lat < 51.105,
    ).toBe(false);
  },
);

it("handles separated MultiPolygon parts without choosing the gap between them", () => {
  const second = box.map(([lon, lat]) => [lon + 0.02, lat]);
  const point = buildingLookupPoint({
    type: "MultiPolygon",
    coordinates: [[box], [second]],
  })!;
  expect(point).not.toBeNull();
  expect(
    (point.lon > 71.4 && point.lon < 71.406) ||
      (point.lon > 71.42 && point.lon < 71.426),
  ).toBe(true);
  expect(point.lat).toBeGreaterThan(51.1);
  expect(point.lat).toBeLessThan(51.106);
});

it.each([
  null,
  { type: "Point", coordinates: [71.43, 51.12] },
  { type: "Polygon", coordinates: [] },
  { type: "Polygon", coordinates: [box.slice(0, -1)] },
  {
    type: "Polygon",
    coordinates: [
      [
        [71.4, 51.1],
        [NaN, 51.1],
        [71.4, 51.2],
        [71.4, 51.1],
      ],
    ],
  },
  {
    type: "Polygon",
    coordinates: [
      ring([
        [0, 0],
        [1, 1],
        [2, 2],
        [0, 0],
      ]),
    ],
  },
  {
    type: "Polygon",
    coordinates: [
      box,
      ring([
        [8, 8],
        [9, 8],
        [9, 9],
        [8, 8],
      ]),
    ],
  },
  { type: "Polygon", coordinates: [box.map(([lon, lat]) => [lon - 1, lat])] },
  { type: "MultiPolygon", coordinates: [[box], null] },
  {
    type: "Polygon",
    coordinates: [
      Array.from({ length: 2049 }, (_, index) => box[index % box.length]),
    ],
  },
])(
  "does not override ground lookup for invalid or out-of-area geometry: %j",
  (geometry) => {
    expect(buildingLookupPoint(geometry)).toBeNull();
  },
);
