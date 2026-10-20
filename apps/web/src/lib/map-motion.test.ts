import { afterEach, expect, it, vi } from "vitest";
import type { Map as LibreMap } from "maplibre-gl";
import {
  motionPaths,
  motionPoints,
  motionModels,
  poseOnPath,
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
const coordinate = (x: number, y: number): [number, number] => [
  71.43 + x / 100_000,
  51.128 + y / 100_000,
];
const viewport = {
  width: 300,
  height: 300,
  project: ([lon, lat]: [number, number]) => ({
    x: (lon - 71.43) * 100_000,
    y: (lat - 51.128) * 100_000,
  }),
};
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
  expect(poseOnPath(path, path.cumulative[1] / 2).heading).toBeCloseTo(90);
  expect(
    poseOnPath(path, (path.cumulative[1] + path.length) / 2).heading,
  ).toBeCloseTo(0);
  const model = motionModels([path], 0, 17);
  expect(model.features.every((part) => part.geometry.type === "Polygon")).toBe(
    true,
  );
  expect(model.features.map((part) => part.properties.part)).toContain("cabin");
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
    road(elbow, { class: "pedestrian", foot: "no" }),
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
  expect(poseOnPath(reverse, reverse.cumulative[1] / 2).heading).toBeCloseTo(
    180,
  );
  const long = Array.from({ length: 1500 }, (_, index) => [
    71 + index * 0.000001,
    51,
  ]);
  expect(motionPaths([road(long)])[0].coordinates).toHaveLength(1000);
});
it("selects central and distributed visible roads before source-order caps for both actor kinds", () => {
  const features = ["minor", "footway"].flatMap((kind) => [
    ...Array.from({ length: 50 }, (_, index) =>
      road([coordinate(-500, index), coordinate(-400, index)], { class: kind }),
    ),
    ...Array.from({ length: 50 }, (_, index) =>
      road([coordinate(5, 5 + index / 10), coordinate(30, 5 + index / 10)], {
        class: kind,
      }),
    ),
    ...[50, 150, 250].flatMap((y) =>
      [50, 150, 250].map((x) =>
        road([coordinate(x - 20, y), coordinate(x + 20, y)], { class: kind }),
      ),
    ),
  ]);
  const paths = motionPaths(features, viewport);
  expect(paths.filter((path) => path.kind === "car")).toHaveLength(24);
  expect(paths.filter((path) => path.kind === "walker")).toHaveLength(16);
  for (const kind of ["car", "walker"]) {
    const points = motionPoints(
      paths.filter((path) => path.kind === kind),
      0,
    ).features.map((feature) => viewport.project(feature.geometry.coordinates));
    expect(points.some(({ x, y }) => Math.hypot(x - 150, y - 150) < 1)).toBe(
      true,
    );
    expect(
      new Set(
        points.map(
          ({ x, y }) => `${Math.floor(x / 100)}:${Math.floor(y / 100)}`,
        ),
      ).size,
    ).toBeGreaterThanOrEqual(9);
    expect(
      points.every(({ x, y }) => x >= 0 && x <= 300 && y >= 0 && y <= 300),
    ).toBe(true);
  }
  expect(motionPaths([...features].reverse(), viewport)).toEqual(paths);
});
it("clips crossing roads under pitch and seeds actors on their visible source segment", () => {
  const pitched = {
    ...viewport,
    project: (point: [number, number]) => {
      const { x, y } = viewport.project(point);
      return { x: x / (1 + y / 600), y: y / (1 + y / 600) };
    },
  };
  const [path] = motionPaths(
    [road([coordinate(-200, 200), coordinate(800, 200)])],
    pitched,
  );
  const points = motionPoints([path], 0);
  const seed = pitched.project(points.features[0].geometry.coordinates);
  expect(seed.x).toBeCloseTo(150, 2);
  expect(seed.y).toBeCloseTo(150, 2);
  for (const point of path.coordinates) {
    expect(point[1]).toBe(coordinate(0, 200)[1]);
    expect(pitched.project(point).x).toBeGreaterThanOrEqual(-0.01);
    expect(pitched.project(point).x).toBeLessThanOrEqual(300.01);
  }
});
it("keeps long roads' visible sections and never connects spans separated outside the viewport", () => {
  const long = Array.from({ length: 1500 }, (_, index) =>
    coordinate(index - 1200, 150),
  );
  const paths = motionPaths([road(long)], viewport);
  expect(paths).toHaveLength(1);
  expect(paths[0].coordinates.length).toBeLessThanOrEqual(1000);
  expect(
    viewport.project(motionPoints(paths, 0).features[0].geometry.coordinates).x,
  ).toBeCloseTo(150, 2);
  const separate = motionPaths(
    [
      road([
        coordinate(-50, 100),
        coordinate(350, 100),
        coordinate(350, -50),
        coordinate(100, -50),
        coordinate(100, 350),
      ]),
    ],
    viewport,
  );
  expect(separate).toHaveLength(2);
  expect(
    separate.some((path) =>
      path.coordinates.every((point) => point[1] === coordinate(0, 100)[1]),
    ),
  ).toBe(true);
  expect(
    separate.some((path) =>
      path.coordinates.every((point) => point[0] === coordinate(100, 0)[0]),
    ),
  ).toBe(true);
  expect(motionPaths([road(elbow)], { ...viewport, width: 0 })).toEqual([]);
});
it("turns pedestrians back along the same footpath instead of teleporting at its end", () => {
  const [path] = motionPaths([road(elbow, { class: "footway" })]);
  const endTime = path.length / 1.4;
  const before = motionModels([path], endTime - 0.1, 17);
  const after = motionModels([path], endTime + 0.1, 17);
  const center = (model: typeof before) => {
    const ring = model.features
      .find((part) => part.properties.part === "torso")!
      .geometry.coordinates[0].slice(0, -1);
    return ring.reduce(
      (sum, point) => [
        sum[0] + point[0] / ring.length,
        sum[1] + point[1] / ring.length,
      ],
      [0, 0],
    );
  };
  expect(center(before)[0]).toBeCloseTo(center(after)[0], 5);
  expect(center(before)[1]).toBeCloseTo(center(after)[1], 5);
  const returned = center(motionModels([path], endTime * 2 - 0.0001, 17));
  expect(returned[0]).toBeCloseTo(path.coordinates[0][0], 5);
  expect(returned[1]).toBeCloseTo(path.coordinates[0][1], 5);
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
  const layers = new Map<string, { id: string; type: string }>();
  const listeners = new Map<string, (event?: { sourceId?: string }) => void>();
  let source = false;
  let panY = 0;
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
    addLayer: (layer: { id: string; type: string }) =>
      layers.set(layer.id, layer),
    getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => layers.delete(id),
    getZoom: () => 15.5,
    getCanvas: () => ({ clientWidth: 300, clientHeight: 300 }),
    project: vi.fn((point: [number, number]) => {
      const projected = viewport.project(point);
      return { x: projected.x, y: projected.y + panY };
    }),
    querySourceFeatures: vi.fn(() => [road(elbow)]),
    on: (name: string, listener: (event?: { sourceId?: string }) => void) =>
      listeners.set(name, listener),
    off: (name: string) => listeners.delete(name),
  };
  const status = vi.fn();
  const stop = startMapMotion(map as unknown as LibreMap, status);
  expect([...layers.values()].map((layer) => layer.type)).toEqual([
    "fill-extrusion",
    "fill-extrusion",
  ]);
  expect(status).toHaveBeenLastCalledWith("paused");
  expect(frames.size).toBe(0);
  expect(map.querySourceFeatures).toHaveBeenCalledWith("openmaptiles", {
    sourceLayer: "transportation",
  });
  const writes = data.setData.mock.calls.length;
  const projections = map.project.mock.calls.length;
  listeners.get("idle")!();
  expect(data.setData).toHaveBeenCalledTimes(writes);
  expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
  expect(map.project).toHaveBeenCalledTimes(projections);
  panY = 100;
  listeners.get("moveend")!();
  expect(data.setData).toHaveBeenCalledTimes(writes + 1);
  listeners.get("idle")!();
  expect(data.setData).toHaveBeenCalledTimes(writes + 1);
  expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
  const afterPanProjections = map.project.mock.calls.length;
  reduce = false;
  for (const listener of mediaListeners) listener();
  expect(status).toHaveBeenLastCalledWith("running");
  expect(frames.size).toBe(1);
  const [frameId, animate] = [...frames.entries()][0];
  frames.delete(frameId);
  animate(200);
  listeners.get("sourcedata")!({ sourceId: "compass-simulated-motion" });
  listeners.get("sourcedata")!({ sourceId: "unrelated-vector-source" });
  listeners.get("idle")!();
  expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
  expect(map.project).toHaveBeenCalledTimes(afterPanProjections);
  // Tile arrivals still refresh once; successive source events are batched.
  listeners.get("sourcedata")!({ sourceId: "openmaptiles" });
  listeners.get("sourcedata")!({ sourceId: "openmaptiles" });
  expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
  listeners.get("idle")!();
  listeners.get("idle")!();
  expect(map.querySourceFeatures).toHaveBeenCalledTimes(3);
  listeners.get("resize")!();
  listeners.get("idle")!();
  expect(map.querySourceFeatures).toHaveBeenCalledTimes(4);
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
