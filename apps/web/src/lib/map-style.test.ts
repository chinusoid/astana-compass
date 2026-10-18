import { describe, expect, it, vi } from "vitest";
import type { Map, StyleSpecification } from "maplibre-gl";
import type { RouteEstimate } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import {
  ASTANA_VIEW,
  BUILDING_LAYER,
  basemapStyle,
  buildingLayers,
  installBuildings,
  pickedLocation,
  validatedRouteGeometry,
} from "./map-style";

const route = () =>
  structuredClone(
    (
      examples.cases.find((item) => item.name === "recommendations_valid")!
        .instance as { recommendations: { route: RouteEstimate }[] }
    ).recommendations[0].route,
  );

describe("map source and geometry boundaries", () => {
  it("uses the official vector style and never contacts a tile provider in none mode", () => {
    expect(basemapStyle("openfreemap")).toBe(
      "https://tiles.openfreemap.org/styles/liberty",
    );
    const offline = basemapStyle("none") as StyleSpecification;
    expect(offline.sources).toEqual({});
    expect(offline.layers.every((layer) => layer.type === "background")).toBe(
      true,
    );
    expect(ASTANA_VIEW.zoom).toBeGreaterThanOrEqual(15);
    expect(ASTANA_VIEW.pitch).toBe(50);
  });
  it("reuses the vector source and disables Liberty's duplicate extrusion before adding ours", () => {
    const getStyle = () => ({
      sources: { openmaptiles: { type: "vector" } },
      layers: [
        {
          id: "building",
          type: "fill",
          source: "openmaptiles",
          "source-layer": "building",
        },
        {
          id: "building-3d",
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
        },
        { id: "names", type: "symbol", layout: { "text-field": "name" } },
      ],
    });
    const map = { getStyle, setLayoutProperty: vi.fn(), addLayer: vi.fn() };
    expect(installBuildings(map as unknown as Map)).toBe(true);
    expect(map.setLayoutProperty).toHaveBeenCalledWith(
      "building-3d",
      "visibility",
      "none",
    );
    expect(map.addLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: BUILDING_LAYER,
        source: "openmaptiles",
        "source-layer": "building",
      }),
      "names",
    );
    const [, extrusion] = buildingLayers("openmaptiles");
    expect(JSON.stringify(extrusion.paint)).toContain("render_height");
    expect(JSON.stringify(extrusion.paint)).toContain("render_min_height");
    expect(JSON.stringify(extrusion.filter)).toContain("hide_3d");
  });
  it("does not invent a vector source when the basemap has none", () => {
    const map = {
      getStyle: () => ({ sources: {}, layers: [] }),
      addLayer: vi.fn(),
    };
    expect(installBuildings(map as unknown as Map)).toBe(false);
    expect(map.addLayer).not.toHaveBeenCalled();
  });
  it("never displays approximate or malformed route geometry", () => {
    const estimate = route();
    expect(validatedRouteGeometry(estimate)).toBeNull();
    estimate.method = "routed";
    estimate.geometry = {
      type: "LineString",
      coordinates: [
        [71.43, 51.128],
        [71.44, 51.13],
      ],
    };
    expect(validatedRouteGeometry(estimate)).toEqual(estimate.geometry);
    estimate.geometry.coordinates[0][0] = NaN;
    expect(validatedRouteGeometry(estimate)).toBeNull();
    estimate.method = "approximate";
    estimate.geometry.coordinates[0][0] = 71.43;
    expect(validatedRouteGeometry(estimate)).toBeNull();
  });
  it("uses lat/lon and rejects impossible picks while normalising world longitude", () => {
    expect(pickedLocation(71.4305123, 51.1283456)).toEqual({
      lat: 51.128346,
      lon: 71.430512,
    });
    expect(pickedLocation(431.43, 51.1)).toEqual({ lat: 51.1, lon: 71.43 });
    expect(pickedLocation(Infinity, 51)).toBeNull();
    expect(pickedLocation(71, 91)).toBeNull();
  });
});
