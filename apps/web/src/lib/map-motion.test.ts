import { afterEach, expect, it, vi } from "vitest";
import type { Map as LibreMap } from "maplibre-gl";
import {
  motionPaths,
  motionPoints,
  pointOnPath,
  startMapMotion,
} from "./map-motion";

const road = (
  coordinates: number[][],
  properties: Record<string, unknown> = { class: "minor" },
) => ({ geometry: { type: "LineString" as const, coordinates }, properties });
const elbow = [
  [71.43, 51.128],
  [71.431, 51.128],
  [71.431, 51.129],
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("moves through actual road vertices, not across an invented straight shortcut", () => {
  const [path] = motionPaths([road(elbow)]);
  const first = pointOnPath(path, path.cumulative[1] / 2);
  expect(first[1]).toBe(51.128);
  expect(first[0]).toBeCloseTo(71.4305);
  const second = pointOnPath(path, (path.cumulative[1] + path.length) / 2);
  expect(second[0]).toBe(71.431);
  expect(second[1]).toBeCloseTo(51.1285);
  const displayed = motionPoints([path], 10);
  expect(displayed.features[0].geometry.type).toBe("Point");
  expect(displayed.features[0].properties.simulation).toBe(true);
});
it("separates disconnected lines and distinguishes cars from foot paths", () => {
  const lines = [elbow, elbow.map(([lon, lat]) => [lon + 0.01, lat])];
  const paths = motionPaths([
    {
      geometry: { type: "MultiLineString", coordinates: lines },
      properties: { class: "path", subclass: "footway" },
    },
    road(elbow),
  ]);
  expect(paths).toHaveLength(3);
  expect(paths.map((path) => path.kind)).toEqual(["walker", "walker", "car"]);
  expect(paths[0].coordinates).toEqual(lines[0]);
  expect(paths[1].coordinates).toEqual(lines[1]);
});
it("does not place pedestrians on motorways or use restricted/indoor/tunnel/invalid features", () => {
  const paths = motionPaths([
    road(elbow, { class: "motorway" }),
    road(elbow, { class: "minor", access: "private" }),
    road(elbow, { class: "path", subclass: "footway", foot: "no" }),
    road(elbow, { class: "path", indoor: 1 }),
    road(elbow, { class: "minor", brunnel: "tunnel" }),
    road(elbow, { class: "rail" }),
    road([
      [NaN, 51],
      [71, 51],
    ]),
    road([
      [71, 51],
      [71, 51],
    ]),
  ]);
  expect(paths).toHaveLength(1);
  expect(paths[0].kind).toBe("car");
});
it("bounds particle count and vertex cost and honours reverse one-way geometry", () => {
  const many = Array.from({ length: 90 }, (_, index) =>
    road(elbow.map(([lon, lat]) => [lon + index * 0.001, lat])),
  );
  expect(motionPaths(many)).toHaveLength(24);
  const [reverse] = motionPaths([road(elbow, { class: "minor", oneway: -1 })]);
  expect(reverse.coordinates).toEqual([...elbow].reverse());
  const long = Array.from({ length: 1500 }, (_, index) => [
    71 + index * 0.000001,
    51,
  ]);
  expect(motionPaths([road(long)])[0].coordinates).toHaveLength(1000);
});
it("pauses for reduced motion and hidden pages, then removes animation and listeners", () => {
  let reduce = true;
  let hidden = false;
  const mediaListeners = new Set<() => void>();
  const preference = {
    get matches() {
      return reduce;
    },
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) =>
      mediaListeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => preference);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const data = { setData: vi.fn() };
  const layers = new Set<string>();
  const listeners = new Map<string, () => void>();
  let source = false;
  const map = {
    getStyle: () => ({
      sources: { openmaptiles: { type: "vector" } },
      layers: [
        {
          id: "roads",
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
        },
      ],
    }),
    addSource: () => {
      source = true;
    },
    getSource: () => (source ? data : undefined),
    removeSource: () => {
      source = false;
    },
    addLayer: (layer: { id: string }) => layers.add(layer.id),
    getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => layers.delete(id),
    getZoom: () => 15.5,
    querySourceFeatures: vi.fn(() => [road(elbow)]),
    on: (name: string, listener: () => void) => listeners.set(name, listener),
    off: (name: string) => listeners.delete(name),
  };
  const status = vi.fn();
  const stop = startMapMotion(map as unknown as LibreMap, status);
  expect(status).toHaveBeenLastCalledWith("paused");
  expect(frames.size).toBe(0);
  expect(map.querySourceFeatures).toHaveBeenCalledWith("openmaptiles", {
    sourceLayer: "transportation",
  });
  reduce = false;
  for (const listener of mediaListeners) listener();
  expect(status).toHaveBeenLastCalledWith("running");
  expect(frames.size).toBe(1);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(status).toHaveBeenLastCalledWith("paused");
  expect(frames.size).toBe(0);
  stop();
  stop();
  expect(source).toBe(false);
  expect(layers.size).toBe(0);
  expect(listeners.size).toBe(0);
  expect(mediaListeners.size).toBe(0);
});
