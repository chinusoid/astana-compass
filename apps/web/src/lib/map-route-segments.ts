import type { Location, RouteGeometry } from "@astana/api-client";

export const JOURNEY_COLORS = [
  "#2563eb",
  "#9333ea",
  "#c05621",
  "#0f766e",
  "#647115",
  "#075985",
];
export const RETURN_COLOR = "#be185d";

type Coordinate = [number, number];
type Projection = { at: number; distance: number; previous?: number };
export type JourneyLeg = {
  type: "Feature";
  properties: { color: string; order: number; from: string; to: string };
  geometry: RouteGeometry;
};

export function journeyColor(index: number, returning = false) {
  return returning
    ? RETURN_COLOR
    : JOURNEY_COLORS[index % JOURNEY_COLORS.length];
}

function measures(coordinates: Coordinate[]) {
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1];
    const b = coordinates[i];
    const east = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) * Math.PI) / 360);
    cumulative.push(cumulative[i - 1] + Math.hypot(east, b[1] - a[1]));
  }
  return cumulative;
}

/** Cut only along the supplied polyline. Interpolated boundaries remain on an
 * existing road segment; no line is drawn between the POI and its road snap. */
export function routeSlice(
  geometry: RouteGeometry,
  start: number,
  end: number,
  cumulative = measures(geometry.coordinates),
): RouteGeometry {
  const coordinates: Coordinate[] = [];
  const pointAt = (at: number): Coordinate => {
    const next = cumulative.findIndex((distance) => distance > at);
    if (next < 0) return geometry.coordinates.at(-1)!;
    if (next === 0) return geometry.coordinates[0];
    const a = geometry.coordinates[next - 1];
    const b = geometry.coordinates[next];
    const fraction =
      (at - cumulative[next - 1]) / (cumulative[next] - cumulative[next - 1]);
    return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
  };
  coordinates.push(pointAt(start));
  for (let i = 1; i < cumulative.length - 1; i++)
    if (cumulative[i] > start && cumulative[i] < end)
      coordinates.push(geometry.coordinates[i]);
  coordinates.push(pointAt(end));
  return { type: "LineString", coordinates };
}

/** Match destinations in itinerary order, including loops and self crossings.
 * A prefix-minimum dynamic program avoids matching a later stop before an
 * earlier one. Ties choose the earliest occurrence, leaving the explicit return
 * leg at the end. This labels one provider path; it does not estimate leg times. */
export function journeyLegs(
  geometry: RouteGeometry | null,
  destinations: Location[] = [],
  includesReturn = false,
): JourneyLeg[] {
  if (!geometry || geometry.coordinates.length < 2) return [];
  const cumulative = measures(geometry.coordinates);
  const total = cumulative.at(-1)!;
  if (!total) return [];
  const candidates = destinations.map((stop) => {
    const latitude = (stop.lat * Math.PI) / 180;
    const scale = Math.cos(latitude);
    const projections: Projection[] = [];
    for (let i = 1; i < geometry.coordinates.length; i++) {
      const a = geometry.coordinates[i - 1];
      const b = geometry.coordinates[i];
      const dx = (b[0] - a[0]) * scale;
      const dy = b[1] - a[1];
      const length = dx * dx + dy * dy;
      if (!length) continue;
      const x = (stop.lon - a[0]) * scale;
      const y = stop.lat - a[1];
      const fraction = Math.max(0, Math.min(1, (x * dx + y * dy) / length));
      projections.push({
        at: cumulative[i - 1] + (cumulative[i] - cumulative[i - 1]) * fraction,
        distance: (x - dx * fraction) ** 2 + (y - dy * fraction) ** 2,
      });
    }
    return projections;
  });
  for (let stage = 1; stage < candidates.length; stage++) {
    const previous = candidates[stage - 1];
    let cursor = 0;
    let best = -1;
    for (const candidate of candidates[stage]) {
      while (cursor < previous.length && previous[cursor].at <= candidate.at) {
        if (best < 0 || previous[cursor].distance < previous[best].distance)
          best = cursor;
        cursor++;
      }
      candidate.previous = best;
      candidate.distance += best < 0 ? Infinity : previous[best].distance;
    }
  }
  const boundaries: number[] = [];
  if (candidates.length) {
    const last = candidates.at(-1)!;
    let best = 0;
    for (let i = 1; i < last.length; i++)
      if (last[i].distance < last[best].distance) best = i;
    for (let stage = candidates.length - 1; stage >= 0; stage--) {
      boundaries.unshift(candidates[stage][best].at);
      best = candidates[stage][best].previous ?? 0;
    }
  }
  // Non-return routes include the provider's final tail in their last leg.
  if (!boundaries.length) boundaries.push(total);
  else if (includesReturn) boundaries.push(total);
  else boundaries[boundaries.length - 1] = total;
  let start = 0;
  return boundaries.map((end, index) => {
    const returning =
      includesReturn &&
      destinations.length > 0 &&
      index === boundaries.length - 1;
    const leg: JourneyLeg = {
      type: "Feature",
      properties: {
        color: journeyColor(index, returning),
        order: index,
        from: index ? String(index) : "S",
        to: returning ? "S" : String(index + 1),
      },
      geometry: routeSlice(geometry, start, end, cumulative),
    };
    start = end;
    return leg;
  });
}

export function revealedLegs(
  legs: JourneyLeg[],
  progress: number,
): JourneyLeg[] {
  if (progress >= 1) return legs;
  const distances = legs.map((leg) =>
    measures(leg.geometry.coordinates).at(-1)!,
  );
  let remaining =
    distances.reduce((sum, distance) => sum + distance, 0) *
    Math.max(0, progress);
  return legs.flatMap((leg, index) => {
    if (remaining <= 0) return [];
    const distance = distances[index];
    const visible = Math.min(remaining, distance);
    remaining -= distance;
    return [
      {
        ...leg,
        geometry:
          visible >= distance
            ? leg.geometry
            : routeSlice(leg.geometry, 0, visible),
      },
    ];
  });
}
