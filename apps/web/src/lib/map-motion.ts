import type {
  GeoJSONSource,
  Map as LibreMap,
  MapGeoJSONFeature,
} from "maplibre-gl";

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
      : (props.class === "path" &&
            WALK_CLASSES.has(props.subclass ?? "path") &&
            props.foot !== "no") ||
          props.class === "pedestrian"
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

export function pointOnPath(
  path: MotionPath,
  distance: number,
): [number, number] {
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
  return [
    start[0] + (end[0] - start[0]) * progress,
    start[1] + (end[1] - start[1]) * progress,
  ];
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
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: LAYERS[0],
    type: "circle",
    source: SOURCE,
    filter: ["==", ["get", "kind"], "car"],
    paint: {
      "circle-color": "#db8d2e",
      "circle-radius": 3.5,
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: LAYERS[1],
    type: "circle",
    source: SOURCE,
    filter: ["==", ["get", "kind"], "walker"],
    paint: {
      "circle-color": "#235b85",
      "circle-radius": 2.5,
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1,
    },
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
      motionPoints(paths, elapsed),
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
        map.getZoom() >= 12
          ? motionPaths(
              map.querySourceFeatures(vectorSource, {
                sourceLayer: "transportation",
              }),
            )
          : [];
      const nextSignature = JSON.stringify(
        next.map((path) => [path.kind, path.coordinates]),
      );
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
    for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  };
}
