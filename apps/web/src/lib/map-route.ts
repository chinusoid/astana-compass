import type { Location, Place, RouteGeometry } from "@astana/api-client";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import { label, type Locale } from "./i18n";
import { mapText } from "./map-copy";
import { sourcedFact } from "./place-presentation";
import {
  journeyLegs,
  revealedLegs,
  type JourneyLeg,
} from "./map-route-segments";

export const JOURNEY_SOURCE = "journey";
export const JOURNEY_ARROWS = "journey-arrows";

/** Marker popups normally depend on a bubbling map click. Handle native buttons
 * explicitly so selecting a place never also inspects the basemap underneath. */
export function bindMarkerPopup(
  button: HTMLButtonElement,
  marker: Marker,
  select?: () => void,
) {
  button.onclick = (event) => {
    event.stopPropagation();
    select?.();
    marker.togglePopup();
  };
  button.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    button.click();
  };
}

/** Arrowheads follow the provider's vertex order, never a line between stops. */
export function routeArrows(geometry: RouteGeometry | null) {
  const features: {
    type: "Feature";
    properties: { bearing: number };
    geometry: { type: "Point"; coordinates: [number, number] };
  }[] = [];
  if (!geometry) return { type: "FeatureCollection" as const, features };
  const segments = geometry.coordinates.slice(1).map((point, index) => {
    const start = geometry.coordinates[index];
    const latitude = (((start[1] + point[1]) / 2) * Math.PI) / 180;
    const east = (point[0] - start[0]) * Math.cos(latitude);
    const north = point[1] - start[1];
    return {
      start,
      point,
      east,
      north,
      meters: Math.hypot(east, north) * 111_195,
    };
  });
  const total = segments.reduce((sum, segment) => sum + segment.meters, 0);
  if (!Number.isFinite(total) || total <= 0)
    return { type: "FeatureCollection" as const, features };
  const spacing = Math.max(65, total / 60);
  let travelled = 0;
  let next = Math.min(spacing / 2, total / 2);
  for (const segment of segments) {
    while (segment.meters > 0 && next < travelled + segment.meters) {
      const fraction = (next - travelled) / segment.meters;
      features.push({
        type: "Feature",
        properties: {
          bearing: (Math.atan2(segment.east, segment.north) * 180) / Math.PI,
        },
        geometry: {
          type: "Point",
          coordinates: [
            segment.start[0] + (segment.point[0] - segment.start[0]) * fraction,
            segment.start[1] + (segment.point[1] - segment.start[1]) * fraction,
          ],
        },
      });
      next += spacing;
    }
    travelled += segment.meters;
  }
  return { type: "FeatureCollection" as const, features };
}

export function installJourney(map: LibreMap) {
  map.addSource(JOURNEY_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource(JOURNEY_ARROWS, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "journey-casing",
    type: "line",
    source: JOURNEY_SOURCE,
    paint: { "line-color": "#ffffff", "line-width": 10, "line-opacity": 0.95 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "journey-line",
    type: "line",
    source: JOURNEY_SOURCE,
    paint: {
      "line-color": ["get", "color"],
      "line-width": 6,
      "line-opacity": 1,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  // A local raster icon avoids depending on a remote font or external asset.
  const pixels = new Uint8Array(24 * 24 * 4);
  for (let y = 3; y < 20; y++)
    for (let x = 3; x < 21; x++) {
      if (
        Math.abs(x - 11.5) < (20 - y) * 0.53 &&
        (y < 13 || Math.abs(x - 11.5) > (y - 12) * 0.25)
      ) {
        const i = (y * 24 + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
      }
    }
  map.addImage("compass-route-arrow", { width: 24, height: 24, data: pixels });
  map.addLayer({
    id: "journey-direction",
    type: "symbol",
    source: JOURNEY_ARROWS,
    layout: {
      "icon-image": "compass-route-arrow",
      "icon-size": 0.8,
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": false,
    },
  });
}

function paintJourney(map: LibreMap, legs: JourneyLeg[]) {
  (map.getSource(JOURNEY_SOURCE) as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: legs,
  });
  (map.getSource(JOURNEY_ARROWS) as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: legs.flatMap((leg) => routeArrows(leg.geometry).features),
  });
}

export function updateJourney(
  map: LibreMap,
  geometry: RouteGeometry | null,
  destinations: Location[] = [],
  includesReturn = false,
) {
  paintJourney(map, journeyLegs(geometry, destinations, includesReturn));
}

export function reducedMapMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** A one-shot reveal, cancelled when a new route replaces it or the map unmounts. */
export function animateJourney(
  map: LibreMap,
  geometry: RouteGeometry | null,
  destinations: Location[] = [],
  includesReturn = false,
  complete: () => void = () => {},
) {
  const legs = journeyLegs(geometry, destinations, includesReturn);
  const preference =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  let frame = 0;
  let cancelled = false;
  let finished = false;
  let started: number | null = null;
  const finish = () => {
    if (cancelled || finished) return;
    finished = true;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    preference?.removeEventListener?.("change", preferenceChanged);
    paintJourney(map, legs);
    complete();
  };
  const preferenceChanged = () => {
    if (preference?.matches) finish();
  };
  if (
    !geometry ||
    preference?.matches ||
    typeof requestAnimationFrame !== "function"
  )
    finish();
  else {
    paintJourney(map, []);
    const tick = (now: number) => {
      if (cancelled || finished) return;
      started ??= now;
      const progress = Math.min(1, (now - started) / 950);
      // Smooth arrival without delaying the clear start of the route.
      paintJourney(map, revealedLegs(legs, 1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    frame = requestAnimationFrame(tick);
    preference?.addEventListener?.("change", preferenceChanged);
  }
  return () => {
    cancelled = true;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    preference?.removeEventListener?.("change", preferenceChanged);
  };
}

export function fitJourney(
  map: LibreMap,
  geometry: RouteGeometry | null,
  stops: Location[] = [],
  animate = false,
) {
  // Include the actual POIs even if the routing provider snapped to a road.
  // With an approximate estimate, fit the stops without inventing a path.
  const points = [
    ...(geometry?.coordinates ?? []),
    ...stops.map(({ lon, lat }) => [lon, lat]),
  ];
  if (!points.length) return;
  const longitude = points.map((point) => point[0]);
  const latitude = points.map((point) => point[1]);
  map.fitBounds(
    [
      [Math.min(...longitude), Math.min(...latitude)],
      [Math.max(...longitude), Math.max(...latitude)],
    ],
    {
      padding: { top: 100, right: 65, bottom: 70, left: 65 },
      maxZoom: 16,
      duration: animate && !reducedMapMotion() ? 750 : 0,
    },
  );
}

export function categorySymbol(categories: string[]) {
  const icons: Record<string, string> = {
    cafe: "☕",
    restaurant: "♨",
    park: "♧",
    garden: "♧",
    museum: "▥",
    attraction: "★",
    library: "▤",
    theatre: "◈",
    cinema: "▶",
    gallery: "▧",
    arts_centre: "▧",
    artwork: "◆",
    playground: "⚑",
  };
  return icons[categories[0]] ?? "⌖";
}

export function stopTitle(locale: Locale, index: number) {
  return index === 0
    ? mapText(locale, "firstStop")
    : `${mapText(locale, "destination")} ${index + 1}`;
}

export function placePopup(
  place: Place,
  locale: Locale,
  index: number,
  open: () => void,
) {
  const content = document.createElement("div");
  content.className = "map-place-popup";
  const add = (tag: string, text: string) => {
    const element = document.createElement(tag);
    element.textContent = text;
    content.append(element);
    return element;
  };
  if (index >= 0)
    add("p", stopTitle(locale, index)).className = "map-stop-ordinal";
  add("h3", place.name);
  add(
    "p",
    place.categories.map((category) => label(locale, category)).join(" · "),
  );
  const address = ["osm:addr:street", "osm:addr:housenumber"]
    .map((key) => sourcedFact(place, key)?.value)
    .filter(Boolean)
    .join(", ");
  add("p", address || mapText(locale, "addressUnknown"));
  const button = add(
    "button",
    mapText(locale, "fullDetails"),
  ) as HTMLButtonElement;
  button.type = "button";
  button.className = "secondary";
  button.onclick = (event) => {
    event.stopPropagation();
    open();
  };
  content.addEventListener("click", (event) => event.stopPropagation());
  return content;
}
