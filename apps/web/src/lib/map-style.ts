import type {
  FillExtrusionLayerSpecification,
  FillLayerSpecification,
  Map,
  StyleSpecification,
} from "maplibre-gl";
import type { RouteEstimate } from "@astana/api-client";
import { routeGeometry, valid } from "./contracts";

export type MapProvider = "openfreemap" | "osm" | "none";
export const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
export const ASTANA_VIEW = {
  center: [71.4305, 51.1283] as [number, number],
  zoom: 15.5,
  pitch: 50,
  bearing: -18,
};
export const BUILDING_LAYER = "compass-buildings-3d";
export const BUILDING_FOOTPRINTS = "compass-building-footprints";

export function basemapStyle(
  provider: MapProvider,
): string | StyleSpecification {
  if (provider === "openfreemap") return OPENFREEMAP_STYLE;
  return {
    version: 8,
    sources:
      provider === "osm"
        ? {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              maxzoom: 19,
              attribution:
                '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
            },
          }
        : {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#e9ede8" },
      },
      ...(provider === "osm"
        ? [{ id: "basemap", type: "raster" as const, source: "osm" }]
        : []),
    ],
  };
}

export function buildingLayers(
  source: string,
): [FillLayerSpecification, FillExtrusionLayerSpecification] {
  return [
    {
      id: BUILDING_FOOTPRINTS,
      type: "fill",
      source,
      "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": "#d5d5cd", "fill-outline-color": "#b6bbb3" },
    },
    {
      id: BUILDING_LAYER,
      type: "fill-extrusion",
      source,
      "source-layer": "building",
      minzoom: 14,
      filter: [
        "all",
        ["!=", ["get", "hide_3d"], true],
        [">", ["coalesce", ["get", "render_height"], 0], 0],
      ],
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "render_height"], 0],
          0,
          "#d4d9d3",
          60,
          "#b7c7c0",
          160,
          "#91aaa5",
        ],
        // Heights come from the provider, including its own estimates. Missing
        // heights stay flat; the interface never invents a building height.
        "fill-extrusion-height": [
          "max",
          0,
          ["coalesce", ["get", "render_height"], 0],
        ],
        "fill-extrusion-base": [
          "max",
          0,
          [
            "min",
            ["coalesce", ["get", "render_min_height"], 0],
            ["coalesce", ["get", "render_height"], 0],
          ],
        ],
        "fill-extrusion-opacity": 0.9,
        "fill-extrusion-vertical-gradient": true,
      },
    },
  ];
}

/** Reuse Liberty's verified vector source, avoiding a second tile download. */
export function installBuildings(map: Map): boolean {
  const style = map.getStyle();
  const building = style.layers.find(
    (layer) => "source-layer" in layer && layer["source-layer"] === "building",
  );
  if (
    !building ||
    !("source" in building) ||
    typeof building.source !== "string" ||
    style.sources[building.source]?.type !== "vector"
  )
    return false;
  const label = style.layers.find(
    (layer) => layer.type === "symbol" && layer.layout?.["text-field"],
  );
  // Liberty includes its own extrusion. Hide it before installing ours, so 2D
  // really is flat and buildings are never rendered twice.
  for (const layer of style.layers)
    if (layer.type === "fill-extrusion" && layer["source-layer"] === "building")
      map.setLayoutProperty(layer.id, "visibility", "none");
  for (const layer of buildingLayers(building.source))
    map.addLayer(layer, label?.id);
  return true;
}

export function validatedRouteGeometry(
  route: RouteEstimate | null | undefined,
) {
  return route && valid("RouteEstimate", route) ? routeGeometry(route) : null;
}

export function pickedLocation(lng: number, lat: number) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat < -90 || lat > 90)
    return null;
  const lon = ((((lng + 180) % 360) + 360) % 360) - 180;
  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
}
