import type { Location } from "@astana/api-client";

type Point = [number, number];
type Polygon = Point[][];

// Same lookup area as the API. Never redirect a click to arbitrary tile data.
const inArea = ([lon, lat]: Point) =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  lon >= 71 &&
  lon <= 71.8 &&
  lat >= 50.8 &&
  lat <= 51.4;

/** -1 outside, 0 on the boundary, 1 strictly inside; independent of winding. */
function ringPosition([x, y]: Point, ring: Point[]): number {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1],
      [bx, by] = ring[i];
    if (
      (x - ax) * (by - ay) === (y - ay) * (bx - ax) &&
      x >= Math.min(ax, bx) &&
      x <= Math.max(ax, bx) &&
      y >= Math.min(ay, by) &&
      y <= Math.max(ay, by)
    )
      return 0;
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay))
      inside = !inside;
  }
  return inside ? 1 : -1;
}

const contains = (point: Point, polygon: Polygon) =>
  ringPosition(point, polygon[0]) === 1 &&
  polygon.slice(1).every((ring) => ringPosition(point, ring) === -1);

/**
 * Pick an interior point of a rendered building's ground footprint, not its
 * bbox centre (which can be in a courtyard or outside a concave building).
 * Horizontal scanlines between vertex latitudes cannot pass through a vertex;
 * candidate intervals are checked against the exterior and every hole.
 * Work is bounded because vector-tile geometry is external input.
 */
export function buildingLookupPoint(geometry: unknown): Location | null {
  if (!geometry || typeof geometry !== "object") return null;
  const { type, coordinates } = geometry as Record<string, unknown>;
  const rawPolygons =
    type === "Polygon"
      ? [coordinates]
      : type === "MultiPolygon"
        ? coordinates
        : null;
  if (
    !Array.isArray(rawPolygons) ||
    !rawPolygons.length ||
    rawPolygons.length > 32
  )
    return null;
  const polygons: Polygon[] = [];
  let vertices = 0;
  for (const rawPolygon of rawPolygons) {
    if (
      !Array.isArray(rawPolygon) ||
      !rawPolygon.length ||
      rawPolygon.length > 64
    )
      return null;
    const polygon: Polygon = [];
    for (const rawRing of rawPolygon) {
      if (!Array.isArray(rawRing) || rawRing.length < 4) return null;
      vertices += rawRing.length;
      if (vertices > 2048) return null;
      const ring: Point[] = [];
      for (const value of rawRing) {
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          typeof value[0] !== "number" ||
          typeof value[1] !== "number"
        )
          return null;
        const point: Point = [value[0], value[1]];
        if (!inArea(point)) return null;
        ring.push(point);
      }
      const [x, y] = ring[0],
        last = ring[ring.length - 1];
      if (x !== last[0] || y !== last[1]) return null;
      const area = ring
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum +
            (ring[index][0] - x) * (point[1] - y) -
            (point[0] - x) * (ring[index][1] - y),
          0,
        );
      if (Math.abs(area) < 1e-16) return null;
      if (
        polygon.length &&
        ring.some((point) => ringPosition(point, polygon[0]) !== 1)
      )
        return null;
      polygon.push(ring);
    }
    polygons.push(polygon);
  }
  let best: Location | null = null,
    clearance = 0;
  for (const polygon of polygons) {
    const ys = [...new Set(polygon.flat().map((point) => point[1]))].sort(
      (a, b) => a - b,
    );
    const bands = ys
      .slice(1)
      .map((y, index) => ({
        y: (y + ys[index]) / 2,
        height: y - ys[index],
      }))
      .sort((a, b) => b.height - a.height)
      .slice(0, 64);
    for (const band of bands) {
      const crossings: number[] = [];
      for (const ring of polygon)
        for (let i = 1; i < ring.length; i++) {
          const [ax, ay] = ring[i - 1],
            [bx, by] = ring[i];
          if (ay > band.y !== by > band.y)
            crossings.push(ax + ((band.y - ay) * (bx - ax)) / (by - ay));
        }
      crossings.sort((a, b) => a - b);
      for (let i = 1; i < crossings.length; i++) {
        const width = crossings[i] - crossings[i - 1];
        const room = Math.min(
          width * Math.cos((band.y * Math.PI) / 180),
          band.height,
        );
        const point: Point = [(crossings[i] + crossings[i - 1]) / 2, band.y];
        if (room > clearance && contains(point, polygon)) {
          clearance = room;
          best = { lon: point[0], lat: point[1] };
        }
      }
    }
  }
  return best;
}
