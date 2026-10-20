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
  startDistance?: number;
};
type MotionViewport = {
  width: number;
  height: number;
  project: (coordinates: [number, number]) => { x: number; y: number };
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

function interpolate(a: number[], b: number[], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// A pitched projection is not linear in geographic distance. Find a point on
// the source segment, rather than unprojecting an arbitrary screen position.
function segmentPoint(
  a: [number, number],
  b: [number, number],
  fraction: number,
  viewport: MotionViewport,
) {
  if (fraction <= 0) return a;
  if (fraction >= 1) return b;
  const pa = viewport.project(a),
    pb = viewport.project(b);
  const axis = Math.abs(pb.x - pa.x) > Math.abs(pb.y - pa.y) ? "x" : "y";
  const target = pa[axis] + (pb[axis] - pa[axis]) * fraction;
  const increasing = pb[axis] > pa[axis];
  let low = 0,
    high = 1;
  for (let iteration = 0; iteration < 18; iteration++) {
    const middle = (low + high) / 2;
    const value = viewport.project(interpolate(a, b, middle))[axis];
    if (value < target === increasing) low = middle;
    else high = middle;
  }
  return interpolate(a, b, (low + high) / 2);
}

/** Clip each connected source span independently, including roads crossing the screen. */
function visibleSpans(
  coordinates: [number, number][],
  viewport: MotionViewport,
) {
  const spans: [number, number][][] = [];
  let span: [number, number][] = [];
  const finish = () => {
    if (span.length > 1) spans.push(span);
    span = [];
  };
  for (let index = 1; index < coordinates.length; index++) {
    const a = coordinates[index - 1],
      b = coordinates[index];
    const pa = viewport.project(a),
      pb = viewport.project(b);
    const dx = pb.x - pa.x,
      dy = pb.y - pa.y;
    let enter = 0,
      leave = 1;
    if (![pa.x, pa.y, pb.x, pb.y].every(Number.isFinite)) {
      finish();
      continue;
    }
    for (const [p, q] of [
      [-dx, pa.x],
      [dx, viewport.width - pa.x],
      [-dy, pa.y],
      [dy, viewport.height - pa.y],
    ]) {
      if (p === 0) {
        if (q < 0) leave = -1;
      } else if (p < 0) enter = Math.max(enter, q / p);
      else leave = Math.min(leave, q / p);
    }
    if (enter > leave || leave < 0 || enter > 1) {
      finish();
      continue;
    }
    const start = segmentPoint(a, b, enter, viewport);
    const end = segmentPoint(a, b, leave, viewport);
    if (enter > 0 || span.length >= 999) finish();
    if (!span.length) span.push(start);
    span.push(end);
    if (leave < 1) finish();
  }
  finish();
  return spans;
}

function visibleSelection(paths: MotionPath[], viewport: MotionViewport) {
  const candidates = paths
    .map((path) => {
      let distance = Infinity,
        segment = 1,
        fraction = 0;
      for (let index = 1; index < path.coordinates.length; index++) {
        const a = path.coordinates[index - 1],
          b = path.coordinates[index];
        const pa = viewport.project(a),
          pb = viewport.project(b);
        const dx = pb.x - pa.x,
          dy = pb.y - pa.y;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((viewport.width / 2 - pa.x) * dx +
              (viewport.height / 2 - pa.y) * dy) /
              (dx * dx + dy * dy || 1),
          ),
        );
        const nextDistance = Math.hypot(
          pa.x + dx * t - viewport.width / 2,
          pa.y + dy * t - viewport.height / 2,
        );
        if (nextDistance >= distance) continue;
        distance = nextDistance;
        segment = index;
        fraction = t;
      }
      const point = segmentPoint(
        path.coordinates[segment - 1],
        path.coordinates[segment],
        fraction,
        viewport,
      );
      const startDistance = Math.min(
        path.length - 0.001,
        path.cumulative[segment - 1] +
          meters(path.coordinates[segment - 1], point),
      );
      const { x, y } = viewport.project(point);
      return {
        path: { ...path, startDistance },
        distance,
        cell: `${Math.max(0, Math.min(2, Math.floor((x / viewport.width) * 3)))}:${Math.max(0, Math.min(2, Math.floor((y / viewport.height) * 3)))}`,
      };
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        JSON.stringify(a.path.coordinates).localeCompare(
          JSON.stringify(b.path.coordinates),
        ),
    );
  const selected: MotionPath[] = [];
  for (const kind of ["car", "walker"] as const) {
    const remaining = candidates.filter(
      (candidate) => candidate.path.kind === kind,
    );
    const limit = kind === "car" ? 24 : 16;
    let count = 0;
    // Round-robin screen cells prevents tile order or dense edge roads from
    // consuming the entire budget before central/other visible paths are seen.
    while (remaining.length && count < limit) {
      const cells = new Set<string>();
      for (let index = 0; index < remaining.length;) {
        if (cells.has(remaining[index].cell)) {
          index++;
          continue;
        }
        cells.add(remaining[index].cell);
        selected.push(remaining.splice(index, 1)[0].path);
        count++;
        if (count >= limit) break;
      }
    }
  }
  return selected;
}

/** Use actual loaded road/path vertices only; no route, gap or connector is invented. */
export function motionPaths(
  features: Pick<MapGeoJSONFeature, "geometry" | "properties">[],
  viewport?: MotionViewport,
): MotionPath[] {
  if (viewport && (viewport.width <= 0 || viewport.height <= 0)) return [];
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
    if (!kind || (!viewport && counts[kind] >= (kind === "car" ? 24 : 16)))
      continue;
    const geometry = feature.geometry;
    const lines: number[][][] =
      geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.type === "MultiLineString"
          ? geometry.coordinates
          : [];
    for (const line of lines) {
      if (!viewport && counts[kind] >= (kind === "car" ? 24 : 16)) break;
      // Clip before bounding vertex cost so a long road's visible section is
      // retained. Never join disconnected parts or simplify across a bend.
      const coordinates = line
        .slice(0, viewport ? undefined : 1000)
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
      for (const span of viewport
        ? visibleSpans(coordinates, viewport)
        : [coordinates]) {
        const forward = JSON.stringify(span);
        const reverse = viewport
          ? JSON.stringify([...span].reverse())
          : forward;
        const key = `${kind}:${forward < reverse ? forward : reverse}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cumulative = [0];
        for (let index = 1; index < span.length; index++)
          cumulative.push(
            cumulative[index - 1] + meters(span[index - 1], span[index]),
          );
        const length = cumulative.at(-1)!;
        if (length < 8) continue;
        paths.push({ kind, coordinates: span, cumulative, length });
        counts[kind]++;
      }
    }
    if (!viewport && counts.car >= 24 && counts.walker >= 16) break;
  }
  return viewport ? visibleSelection(paths, viewport) : paths;
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
          (path.startDistance ?? path.length * ((index * 0.381966) % 1)) +
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
        (path.startDistance ?? path.length * ((index * 0.381966) % 1)) +
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
  let dirty = true;
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
    if (disposed || !dirty) return;
    dirty = false;
    try {
      const next =
        map.getZoom() >= 14
          ? motionPaths(
              map.querySourceFeatures(vectorSource, {
                sourceLayer: "transportation",
              }),
              {
                width: map.getCanvas().clientWidth,
                height: map.getCanvas().clientHeight,
                project: (coordinates) => map.project(coordinates),
              },
            )
          : [];
      // Zoom changes display scale even while motion is paused. An unchanged
      // idle event must not call setData again and cause another idle loop.
      const nextSignature = JSON.stringify([
        Math.round(map.getZoom() * 10),
        next.map((path) => [path.kind, path.coordinates, path.startDistance]),
      ]);
      if (nextSignature === signature) return;
      signature = nextSignature;
      paths = next;
      elapsed = 0;
      draw();
      updateRunning();
    } catch {
      paths = [];
      draw();
      updateRunning();
    }
  };
  const viewChanged = () => {
    dirty = true;
    refresh();
  };
  const sourceChanged = (event: { sourceId?: string }) => {
    // Our animated GeoJSON source emits data/idle events too. Only real road
    // tile changes require another geometry scan, batched until the next idle.
    if (event.sourceId === vectorSource) dirty = true;
  };
  map.on("idle", refresh);
  map.on("moveend", viewChanged);
  map.on("resize", viewChanged);
  map.on("sourcedata", sourceChanged);
  preference.addEventListener("change", updateRunning);
  document.addEventListener("visibilitychange", updateRunning);
  refresh();
  updateRunning();
  return () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    map.off("idle", refresh);
    map.off("moveend", viewChanged);
    map.off("resize", viewChanged);
    map.off("sourcedata", sourceChanged);
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
