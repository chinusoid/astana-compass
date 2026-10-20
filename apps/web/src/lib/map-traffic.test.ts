import { afterEach, expect, it, vi } from "vitest";
import type { TrafficResponse, TrafficSegment } from "@astana/api-client";
import type { Map as LibreMap } from "maplibre-gl";
import {
  checkedTraffic,
  fetchTraffic,
  flowStyle,
  roadSamplePoints,
  startTrafficLayer,
  trafficParticles,
  trafficModels,
  TRAFFIC_TTL_MS,
} from "./map-traffic";

const now = Date.parse("2026-10-19T10:00:00Z");
const segment = (): TrafficSegment => ({
  geometry: {
    type: "LineString",
    coordinates: [
      [71.43, 51.128],
      [71.431, 51.128],
      [71.431, 51.129],
    ],
  },
  current_speed_kmh: 30,
  free_flow_speed_kmh: 60,
  confidence: 0.9,
  road_closed: false,
  fetched_at: new Date(now).toISOString(),
});
const response = (): TrafficResponse => ({
  status: "live",
  provider: "TomTom",
  attribution: "© TomTom",
  segments: [segment()],
});
const road = (index: number, properties = { class: "minor" }) => ({
  geometry: {
    type: "LineString" as const,
    coordinates: [
      [71.3 + index * 0.003, 51.1],
      [71.301 + index * 0.003, 51.101],
    ],
  },
  properties,
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("samples at most six distinct public road vertices, excluding footpaths and restricted roads", () => {
  const points = roadSamplePoints([
    ...Array.from({ length: 20 }, (_, i) => road(i)),
    road(21, { class: "path" }),
    road(22, { class: "minor", access: "private" } as { class: string }),
    {
      ...road(23),
      geometry: {
        type: "LineString",
        coordinates: [
          [80, 60],
          [80.01, 60.01],
        ],
      },
    },
  ]);
  expect(points).toHaveLength(6);
  for (const point of points) {
    expect(point.lon).toBeGreaterThanOrEqual(71);
    expect(point.lon).toBeLessThanOrEqual(71.8);
    expect(point.lat).toBeGreaterThanOrEqual(50.8);
    expect(point.lat).toBeLessThanOrEqual(51.4);
  }
  expect(new Set(points.map((point) => `${point.lon}:${point.lat}`)).size).toBe(
    6,
  );
});
it("filters to visible road vertices before limiting the sample", () => {
  const points = roadSamplePoints(
    Array.from({ length: 20 }, (_, i) => road(i)),
    ([lon]) => lon > 71.35,
  );
  expect(points.length).toBeGreaterThan(0);
  expect(points.every((point) => point.lon > 71.35)).toBe(true);
});
it("accepts not_configured without inventing any flow data", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      status: "not_configured",
      provider: "TomTom",
      segments: [],
      attribution: "© TomTom",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const points = roadSamplePoints([road(1)]);
  const result = await fetchTraffic(points, new AbortController().signal);
  expect(result.status).toBe("not_configured");
  expect(result.segments).toEqual([]);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/traffic",
    expect.objectContaining({
      credentials: "omit",
      body: JSON.stringify({ points }),
    }),
  );
});
it("rejects off-city samples before sending a request", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchTraffic([{ lat: 90, lon: 180 }], new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects malformed provider data instead of promoting it to live", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "live", segments: [] })),
  );
  await expect(
    fetchTraffic(roadSamplePoints([road(1)]), new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});
it.each([
  "old",
  "future",
  "wrong-city",
  "empty-live",
  "unavailable-with-segment",
])("rejects inconsistent or stale traffic: %s", (kind) => {
  const data = response();
  if (kind === "old")
    data.segments[0].fetched_at = new Date(now - TRAFFIC_TTL_MS).toISOString();
  if (kind === "future")
    data.segments[0].fetched_at = new Date(now + 60_000).toISOString();
  if (kind === "wrong-city")
    data.segments[0].geometry.coordinates = [
      [0, 0],
      [0.1, 0.1],
    ];
  if (kind === "empty-live") data.segments = [];
  if (kind === "unavailable-with-segment") data.status = "unavailable";
  expect(() => checkedTraffic(data, now)).toThrow();
});
it("maps low speeds to red, denser and slower illustrative cars; closure has no moving cars", () => {
  const slow = { ...segment(), current_speed_kmh: 6 };
  const fast = { ...segment(), current_speed_kmh: 60 };
  expect(flowStyle(slow).color).toBe("#d74432");
  expect(flowStyle(fast).color).toBe("#249b52");
  expect(flowStyle(slow).count).toBeGreaterThan(flowStyle(fast).count);
  expect(flowStyle(slow).speed).toBeLessThan(flowStyle(fast).speed);
  const dots = trafficParticles([slow], 2);
  expect(dots.features.every((item) => item.properties.illustrative)).toBe(
    true,
  );
  expect(
    dots.features.every(
      (item) =>
        item.geometry.coordinates[1] === 51.128 ||
        item.geometry.coordinates[0] === 71.431,
    ),
  ).toBe(true);
  expect(
    trafficParticles([{ ...slow, road_closed: true }], 10).features,
  ).toHaveLength(0);
  const models = trafficModels([slow], 2, 17);
  expect(
    new Set(models.features.map((part) => part.properties.actor)).size,
  ).toBe(flowStyle(slow).count);
  expect(
    models.features.every(
      (part) =>
        part.geometry.type === "Polygon" && part.properties.illustrative,
    ),
  ).toBe(true);
  expect(
    trafficModels([{ ...slow, road_closed: true }], 10, 17).features,
  ).toHaveLength(0);
  expect(
    new Set(
      trafficModels(
        Array.from({ length: 6 }, () => slow),
        2,
        17,
      ).features.map((part) => part.properties.actor),
    ).size,
  ).toBeLessThanOrEqual(24);
});
it("removes expired flow layers and stops listeners without background refresh", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const sources = new Map<string, unknown>();
  const layers = new Set<string>();
  const removeListener = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: removeListener,
  }));
  const frames = vi.fn();
  vi.stubGlobal("requestAnimationFrame", frames);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const map = {
    getZoom: () => 17,
    on: vi.fn(),
    off: vi.fn(),
    addSource: (id: string, value: unknown) => sources.set(id, value),
    addLayer: ({ id }: { id: string }) => layers.add(id),
    getLayer: (id: string) => layers.has(id),
    getSource: (id: string) => sources.get(id),
    removeLayer: (id: string) => layers.delete(id),
    removeSource: (id: string) => sources.delete(id),
  } as unknown as LibreMap;
  const stale = vi.fn();
  const stop = startTrafficLayer(map, response(), stale);
  expect(layers.size).toBe(2);
  expect(sources.size).toBe(2);
  expect(frames).not.toHaveBeenCalled();
  vi.advanceTimersByTime(TRAFFIC_TTL_MS);
  expect(stale).toHaveBeenCalledOnce();
  expect(layers.size).toBe(0);
  expect(sources.size).toBe(0);
  expect(removeListener).toHaveBeenCalledOnce();
  stop();
  vi.advanceTimersByTime(TRAFFIC_TTL_MS);
  expect(stale).toHaveBeenCalledOnce();
});

it("pauses the traffic models when hidden, reduced or too far out, and resumes without a time jump", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  let zoom = 17;
  let reduce = false;
  let hidden = false;
  const mediaListeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reduce;
    },
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) =>
      mediaListeners.delete(fn),
  }));
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++frameId, fn);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const layers = new Set<string>();
  const listeners = new Map<string, () => void>();
  const map = {
    getZoom: () => zoom,
    on: (event: string, fn: () => void) => listeners.set(event, fn),
    off: (event: string) => listeners.delete(event),
    addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
    addLayer: ({ id }: { id: string }) => layers.add(id),
    getLayer: (id: string) => layers.has(id),
    getSource: (id: string) => sources.get(id),
    removeLayer: (id: string) => layers.delete(id),
    removeSource: (id: string) => sources.delete(id),
  };
  const stop = startTrafficLayer(
    map as unknown as LibreMap,
    response(),
    vi.fn(),
  );
  const tick = (time: number) => {
    const [id, fn] = [...frames.entries()][0];
    frames.delete(id);
    fn(time);
  };
  expect(frames.size).toBe(1);
  tick(100);
  const data = sources.get("compass-traffic-illustration")!;
  const initial = data.setData.mock.lastCall![0];
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(frames.size).toBe(0);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  tick(10_000);
  expect(data.setData.mock.lastCall![0]).toEqual(initial);
  reduce = true;
  for (const listener of mediaListeners) listener();
  expect(frames.size).toBe(0);
  reduce = false;
  for (const listener of mediaListeners) listener();
  zoom = 13;
  listeners.get("moveend")!();
  expect(frames.size).toBe(0);
  zoom = 17;
  listeners.get("moveend")!();
  expect(frames.size).toBe(1);
  stop();
  expect(frames.size).toBe(0);
  expect(listeners.size).toBe(0);
  expect(mediaListeners.size).toBe(0);
  expect(sources.size).toBe(0);
});
