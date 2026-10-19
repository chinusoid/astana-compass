import type {
  GeoJSONSource,
  Map as LibreMap,
  MapGeoJSONFeature,
} from "maplibre-gl";
import { modelLayer, modelParts } from "./map-motion-models";

export type MotionKind = "car" | "walker";
export type MotionPath = {
  kind: MotionKind;
  coordinates: [number, number][];
  cumulative: number[];
  length: number;
};
export type MotionStatus = "running" | "paused" | "empty";
const SOURCE = "compass-simulated-motion";
const LAYERS = ["compass-simulated-cars", "compass-simulated-walkers"];
const CAR_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "service",
]);
const WALK_CLASSES = new Set(["footway", "pedestrian", "path", "steps"]);

function meters(a: number[], b: number[]) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 +
    Math.cos(a[1] * rad) *
      Math.cos(b[1] * rad) *
      Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 12_742_017.6 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Use actual loaded road/path vertices only; no route, gap or connector is invented. */
export function motionPaths(
  features: Pick<MapGeoJSONFeature, "geometry" | "properties">[],
): MotionPath[] {
  const paths: MotionPath[] = [];
  const seen = new Set<string>();
  const counts = { car: 0, walker: 0 };
  for (const feature of features) {
    const props = feature.properties ?? {};
    if (
      props.access === "no" ||
      props.access === "private" ||
      props.indoor === 1 ||
      props.brunnel === "tunnel"
    )
      continue;
    const kind: MotionKind | null = CAR_CLASSES.has(props.class)
      ? "car"
      : WALK_CLASSES.has(props.class) &&
          (props.class === "pedestrian" ||
            WALK_CLASSES.has(props.subclass ?? "path")) &&
          props.foot !== "no"
        ? "walker"
        : null;
    if (!kind || counts[kind] >= (kind === "car" ? 24 : 16)) continue;
    const geometry = feature.geometry;
    const lines: number[][][] =
      geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.type === "MultiLineString"
          ? geometry.coordinates
          : [];
    for (const line of lines) {
      if (counts[kind] >= (kind === "car" ? 24 : 16)) break;
      // Truncate along existing vertices; never simplify across a bend or join
      // disconnected MultiLineString parts to manufacture a traversable road.
      const coordinates = line
        .slice(0, 1000)
        .map((point) => [point[0], point[1]] as [number, number]);
      if (
        coordinates.length < 2 ||
        coordinates.some(
          ([lon, lat]) =>
            !Number.isFinite(lon) ||
            !Number.isFinite(lat) ||
            Math.abs(lon) > 180 ||
            Math.abs(lat) > 90,
        )
      )
        continue;
      if (kind === "car" && props.oneway === -1) coordinates.reverse();
      const key = `${kind}:${JSON.stringify(coordinates)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cumulative = [0];
      for (let index = 1; index < coordinates.length; index++)
        cumulative.push(
          cumulative[index - 1] +
            meters(coordinates[index - 1], coordinates[index]),
        );
      const length = cumulative.at(-1)!;
      if (length < 8) continue;
      paths.push({ kind, coordinates, cumulative, length });
      counts[kind]++;
    }
    if (counts.car >= 24 && counts.walker >= 16) break;
  }
  return paths;
}

export function poseOnPath(path: MotionPath, distance: number) {
  const target = ((distance % path.length) + path.length) % path.length;
  let left = 1,
    right = path.cumulative.length - 1;
  while (left < right) {
    const middle = (left + right) >> 1;
    if (path.cumulative[middle] < target) left = middle + 1;
    else right = middle;
  }
  const start = path.coordinates[left - 1],
    end = path.coordinates[left];
  const segment = path.cumulative[left] - path.cumulative[left - 1];
  const progress =
    segment > 0 ? (target - path.cumulative[left - 1]) / segment : 0;
  return {
    coordinates: [
      start[0] + (end[0] - start[0]) * progress,
      start[1] + (end[1] - start[1]) * progress,
    ] as [number, number],
    heading:
      ((Math.atan2(
        (end[0] - start[0]) * Math.cos((start[1] * Math.PI) / 180),
        end[1] - start[1],
      ) *
        180) /
        Math.PI +
        360) %
      360,
  };
}

export function pointOnPath(
  path: MotionPath,
  distance: number,
): [number, number] {
  return poseOnPath(path, distance).coordinates;
}

export function motionPoints(paths: MotionPath[], elapsedSeconds: number) {
  return {
    type: "FeatureCollection" as const,
    features: paths.map((path, index) => ({
      type: "Feature" as const,
      properties: { kind: path.kind, simulation: true },
      geometry: {
        type: "Point" as const,
        coordinates: pointOnPath(
          path,
          path.length * ((index * 0.381966) % 1) +
            elapsedSeconds * (path.kind === "car" ? 8 : 1.4),
        ),
      },
    })),
  };
}

export function motionModels(
  paths: MotionPath[],
  elapsedSeconds: number,
  zoom: number,
) {
  return {
    type: "FeatureCollection" as const,
    features: paths.flatMap((path, index) => {
      const distance =
        path.length * ((index * 0.381966) % 1) +
        elapsedSeconds * (path.kind === "car" ? 8 : 1.4);
      // Walkers turn at a path end instead of jumping back to its other end.
      const reverse =
        path.kind === "walker" && Math.floor(distance / path.length) % 2 === 1;
      const pose = poseOnPath(
        path,
        reverse
          ? Math.max(0, path.length - (distance % path.length) - 0.001)
          : distance,
      );
      return modelParts({
        actor: `local-${index}`,
        kind: path.kind,
        ...pose,
        heading: (pose.heading + (reverse ? 180 : 0)) % 360,
        phase: elapsedSeconds * 7 + index * 1.7,
        zoom,
      });
    }),
  };
}

/** Optional local illustration. No user data, location feed or traffic API is used. */
export function startMapMotion(
  map: LibreMap,
  onStatus: (status: MotionStatus) => void,
): () => void {
  const style = map.getStyle();
  const transport = style.layers.find(
    (layer) =>
      "source-layer" in layer &&
      layer["source-layer"] === "transportation" &&
      "source" in layer &&
      typeof layer.source === "string" &&
      style.sources[layer.source]?.type === "vector",
  );
  if (
    !transport ||
    !("source" in transport) ||
    typeof transport.source !== "string"
  ) {
    onStatus("empty");
    return () => {};
  }
  const vectorSource = transport.source;
  map.addSource(SOURCE, {
    type: "geojson",
    tolerance: 0,
    maxzoom: 20,
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    ...modelLayer(LAYERS[0], SOURCE),
    filter: ["==", ["get", "kind"], "car"],
  });
  map.addLayer({
    ...modelLayer(LAYERS[1], SOURCE),
    filter: ["==", ["get", "kind"], "walker"],
  });
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let paths: MotionPath[] = [];
  let signature = "";
  let frame: number | null = null;
  let elapsed = 0;
  let previous = 0;
  let lastWrite = 0;
  let disposed = false;
  let lastStatus: MotionStatus | null = null;
  const report = (status: MotionStatus) => {
    if (status !== lastStatus) {
      lastStatus = status;
      onStatus(status);
    }
  };
  const paused = () => preference.matches || document.hidden;
  const draw = () =>
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(
      motionModels(paths, elapsed, map.getZoom()),
    );
  const tick = (now: number) => {
    frame = null;
    if (disposed || paused() || !paths.length) return;
    if (previous) elapsed += Math.min(now - previous, 250) / 1000;
    previous = now;
    if (now - lastWrite >= 100) {
      draw();
      lastWrite = now;
    }
    frame = requestAnimationFrame(tick);
  };
  const updateRunning = () => {
    if (disposed) return;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    previous = 0;
    report(paused() ? "paused" : paths.length ? "running" : "empty");
    if (!paused() && paths.length) frame = requestAnimationFrame(tick);
  };
  const refresh = () => {
    if (disposed) return;
    try {
      const next =
        map.getZoom() >= 14
          ? motionPaths(
              map.querySourceFeatures(vectorSource, {
                sourceLayer: "transportation",
              }),
            )
          : [];
      // Zoom changes display scale even while motion is paused. An unchanged
      // idle event must not call setData again and cause another idle loop.
      const nextSignature = JSON.stringify([
        Math.round(map.getZoom() * 10),
        next.map((path) => [path.kind, path.coordinates]),
      ]);
      if (nextSignature === signature) return;
      signature = nextSignature;
      paths = next;
      draw();
      updateRunning();
    } catch {
      paths = [];
      draw();
      updateRunning();
    }
  };
  map.on("idle", refresh);
  map.on("moveend", refresh);
  preference.addEventListener("change", updateRunning);
  document.addEventListener("visibilitychange", updateRunning);
  refresh();
  updateRunning();
  return () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    map.off("idle", refresh);
    map.off("moveend", refresh);
    preference.removeEventListener("change", updateRunning);
    document.removeEventListener("visibilitychange", updateRunning);
    try {
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    } catch {
      /* The map may already have removed its style during teardown. */
    }
  };
}
