import type {
  Location,
  TrafficResponse,
  TrafficSegment,
} from "@astana/api-client";
import type {
  GeoJSONSource,
  Map as LibreMap,
  MapGeoJSONFeature,
} from "maplibre-gl";
import { valid } from "./contracts";
import { motionPaths, pointOnPath, poseOnPath } from "./map-motion";
import { modelLayer, modelParts } from "./map-motion-models";
import type { Locale } from "./i18n";

export const TRAFFIC_TTL_MS = 90_000;
export const TRAFFIC_REFRESH_MS = 60_000;
const SOURCE = "compass-traffic-segments";
const PARTICLES = "compass-traffic-illustration";
const LAYERS = ["compass-traffic-lines", "compass-traffic-symbolic-cars"];
const insideAstana = (lon: number, lat: number) =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  lon >= 71 &&
  lon <= 71.8 &&
  lat >= 50.8 &&
  lat <= 51.4;
const copy = {
  action: ["Реальные пробки", "Нақты кептелістер", "Live traffic"],
  hide: ["Скрыть пробки", "Кептелісті жасыру", "Hide traffic"],
  refresh: ["Обновить потоки", "Ағынды жаңарту", "Refresh traffic"],
  loading: [
    "Запрашиваем скорость дорожного потока…",
    "Жол ағынының жылдамдығын сұраудамыз…",
    "Requesting road flow speeds…",
  ],
  not_configured: [
    "Пробки не подключены: нужен серверный ключ TomTom. Реальных данных сейчас нет.",
    "Кептеліс қосылмаған: серверде TomTom кілті қажет. Нақты деректер қазір жоқ.",
    "Traffic is not configured: a server-side TomTom key is required. No live data is available.",
  ],
  unavailable: [
    "Дорожный поток сейчас недоступен. Старые данные убраны.",
    "Жол ағыны қазір қолжетімсіз. Ескі деректер алынды.",
    "Road flow is unavailable. Previous data was removed.",
  ],
  invalid: [
    "Ответ о пробках не прошёл проверку. Непроверенные потоки не показаны.",
    "Кептеліс жауабы тексеруден өтпеді. Тексерілмеген ағын көрсетілмейді.",
    "Traffic response could not be verified. Unverified flow is not shown.",
  ],
  stale: [
    "Данные потока устарели и скрыты. Обновите их по кнопке.",
    "Ағын деректері ескіріп, жасырылды. Батырмамен жаңартыңыз.",
    "Flow data expired and was hidden. Refresh it using the button.",
  ],
  no_roads: [
    "Приблизьте карту к дорогам Астаны и дождитесь загрузки.",
    "Астана жолдарын жақындатып, жүктелуін күтіңіз.",
    "Zoom in to Astana roads and wait for the map to load.",
  ],
  cooldown: [
    "Обновление доступно раз в минуту.",
    "Минутына бір рет жаңартуға болады.",
    "Refresh is available once per minute.",
  ],
  live: [
    "Скорость потока TomTom · выборка до 6 участков",
    "TomTom ағын жылдамдығы · 6 бөлікке дейін",
    "TomTom flow speed · up to 6 sampled segments",
  ],
  partial: [
    "TomTom: данные есть только для части выбранных дорог",
    "TomTom: таңдалған жолдардың бір бөлігі ғана қолжетімді",
    "TomTom: data available for only some sampled roads",
  ],
  illustration: [
    "3D-машины иллюстрируют скорость потока: это не отслеживаемые автомобили. Данные есть только для выбранных участков.",
    "3D-көліктер ағын жылдамдығын шартты көрсетеді, нақты көліктер бақыланбайды. Дерек тек таңдалған бөліктерге бар.",
    "3D cars illustrate flow speed; they are not tracked vehicles. Data covers only the sampled segments.",
  ],
  colors: [
    "Зелёный — свободнее, жёлтый — медленнее, красный — затор или закрытие",
    "Жасыл — еркінірек, сары — баяуырақ, қызыл — кептеліс немесе жабық жол",
    "Green: freer flow; amber: slower; red: congested or closed",
  ],
} as const;
export type TrafficNotice = Exclude<
  keyof typeof copy,
  "action" | "hide" | "refresh" | "illustration" | "colors"
>;
export const trafficText = (locale: Locale, key: keyof typeof copy) =>
  copy[key][locale === "ru" ? 0 : locale === "kk" ? 1 : 2];

/** Samples existing public road vertices only, never a user start or shared position. */
export function roadSamplePoints(
  features: Pick<MapGeoJSONFeature, "geometry" | "properties">[],
  isVisible: (point: [number, number]) => boolean = () => true,
): Location[] {
  const candidates = motionPaths(features)
    .filter((path) => path.kind === "car")
    .map((path) =>
      path.coordinates.filter(
        ([lon, lat]) => insideAstana(lon, lat) && isVisible([lon, lat]),
      ),
    )
    .filter((coordinates) => coordinates.length > 0)
    .map((coordinates) => coordinates[Math.floor(coordinates.length / 2)]);
  const unique = new Map<string, Location>();
  for (const [lon, lat] of candidates)
    unique.set(`${lon.toFixed(3)}:${lat.toFixed(3)}`, {
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
    });
  const points = [...unique.values()];
  if (points.length <= 6) return points;
  return Array.from(
    { length: 6 },
    (_, index) => points[Math.floor((index * (points.length - 1)) / 5)],
  );
}
export function sampleVisibleRoads(map: LibreMap): Location[] {
  const style = map.getStyle();
  const layer = style.layers.find(
    (item) =>
      "source-layer" in item &&
      item["source-layer"] === "transportation" &&
      "source" in item &&
      typeof item.source === "string" &&
      style.sources[item.source]?.type === "vector",
  );
  if (!layer || !("source" in layer) || typeof layer.source !== "string")
    return [];
  const bounds = map.getBounds();
  return roadSamplePoints(
    map.querySourceFeatures(layer.source, { sourceLayer: "transportation" }),
    (point) => bounds.contains(point),
  );
}
export class TrafficError extends Error {
  constructor(public readonly code: "invalid" | "unavailable") {
    super(code);
  }
}
export function checkedTraffic(
  payload: unknown,
  now = Date.now(),
): TrafficResponse {
  if (!valid("TrafficResponse", payload)) throw new TrafficError("invalid");
  const result = payload as TrafficResponse;
  const hasFlow = result.status === "live" || result.status === "partial";
  if (
    hasFlow !== result.segments.length > 0 ||
    result.segments.some((segment) => {
      const age = now - Date.parse(segment.fetched_at);
      return (
        age < -30_000 ||
        age >= TRAFFIC_TTL_MS ||
        segment.geometry.coordinates.some(
          ([lon, lat]) => !insideAstana(lon, lat),
        )
      );
    })
  )
    throw new TrafficError("invalid");
  return result;
}
export async function fetchTraffic(
  points: Location[],
  signal: AbortSignal,
): Promise<TrafficResponse> {
  if (
    !valid("TrafficRequest", { points }) ||
    !points.every((point) => insideAstana(point.lon, point.lat))
  )
    throw new TrafficError("invalid");
  let response: Response;
  try {
    response = await fetch("/api/v1/traffic", {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(32000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TrafficError("unavailable");
  }
  if (!response.ok) throw new TrafficError("unavailable");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TrafficError("invalid");
  }
  return checkedTraffic(payload);
}
export function flowStyle(segment: TrafficSegment) {
  const ratio =
    segment.road_closed || segment.free_flow_speed_kmh <= 0
      ? 0
      : Math.min(
          1,
          Math.max(0, segment.current_speed_kmh / segment.free_flow_speed_kmh),
        );
  return {
    ratio,
    color: ratio <= 0.35 ? "#d74432" : ratio <= 0.65 ? "#d39316" : "#249b52",
    count: segment.road_closed ? 0 : 1 + Math.round((1 - ratio) * 7),
    speed: segment.road_closed ? 0 : segment.current_speed_kmh / 3.6,
  };
}
export function trafficParticles(segments: TrafficSegment[], elapsed: number) {
  return {
    type: "FeatureCollection" as const,
    features: segments.flatMap((segment) => {
      const path = motionPaths([
        { geometry: segment.geometry, properties: { class: "minor" } },
      ])[0];
      if (!path) return [];
      const style = flowStyle(segment);
      return Array.from({ length: style.count }, (_, index) => ({
        type: "Feature" as const,
        properties: { illustrative: true, color: style.color },
        geometry: {
          type: "Point" as const,
          coordinates: pointOnPath(
            path,
            (index * path.length) / style.count + elapsed * style.speed,
          ),
        },
      }));
    }),
  };
}

export function trafficModels(
  segments: TrafficSegment[],
  elapsed: number,
  zoom: number,
) {
  let remaining = 24;
  return {
    type: "FeatureCollection" as const,
    features: segments.flatMap((segment, segmentIndex) => {
      const path = motionPaths([
        { geometry: segment.geometry, properties: { class: "minor" } },
      ])[0];
      if (!path || remaining <= 0) return [];
      const flow = flowStyle(segment);
      const count = Math.min(flow.count, remaining);
      remaining -= count;
      return Array.from({ length: count }, (_, index) =>
        modelParts({
          actor: `flow-${segmentIndex}-${index}`,
          kind: "car",
          ...poseOnPath(
            path,
            (index * path.length) / count + elapsed * flow.speed,
          ),
          color: flow.color,
          phase: 0,
          zoom,
        }).map((part) => ({
          ...part,
          properties: { ...part.properties, illustrative: true },
        })),
      ).flat();
    }),
  };
}

/** Draw only provider geometry; the moving 3D cars illustrate flow, not tracking. */
export function startTrafficLayer(
  map: LibreMap,
  response: TrafficResponse,
  onStale: () => void,
): () => void {
  checkedTraffic(response);
  if (!response.segments.length) return () => {};
  const lines = {
    type: "FeatureCollection" as const,
    features: response.segments.map((segment) => ({
      type: "Feature" as const,
      properties: { color: flowStyle(segment).color },
      geometry: segment.geometry,
    })),
  };
  map.addSource(SOURCE, {
    type: "geojson",
    attribution: response.attribution,
    data: lines,
  });
  map.addSource(PARTICLES, {
    type: "geojson",
    tolerance: 0,
    maxzoom: 20,
    data: trafficModels(response.segments, 0, map.getZoom()),
  });
  map.addLayer(
    {
      id: LAYERS[0],
      type: "line",
      source: SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 6,
        "line-opacity": 0.8,
      },
    },
    map.getLayer("journey-line") ? "journey-line" : undefined,
  );
  map.addLayer(modelLayer(LAYERS[1], PARTICLES));
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const expiry = Math.min(
    ...response.segments.map(
      (segment) => Date.parse(segment.fetched_at) + TRAFFIC_TTL_MS,
    ),
  );
  let frame: number | null = null,
    disposed = false,
    elapsed = 0,
    previous = 0,
    lastWrite = 0;
  const paused = () =>
    document.hidden || preference.matches || map.getZoom() < 14;
  const draw = () => {
    if (!disposed)
      (map.getSource(PARTICLES) as GeoJSONSource | undefined)?.setData(
        trafficModels(response.segments, elapsed, map.getZoom()),
      );
  };
  const tick = (now: number) => {
    frame = null;
    if (disposed || paused()) return;
    if (previous) elapsed += Math.min(250, now - previous) / 1000;
    previous = now;
    if (now - lastWrite >= 100) {
      draw();
      lastWrite = now;
    }
    frame = requestAnimationFrame(tick);
  };
  const update = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    previous = 0;
    if (!disposed && !paused()) frame = requestAnimationFrame(tick);
  };
  const moved = () => {
    draw();
    update();
  };
  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    if (frame !== null) cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", update);
    preference.removeEventListener("change", update);
    map.off("moveend", moved);
    try {
      for (const layer of [...LAYERS].reverse())
        if (map.getLayer(layer)) map.removeLayer(layer);
      for (const source of [PARTICLES, SOURCE])
        if (map.getSource(source)) map.removeSource(source);
    } catch {
      /* Map teardown may have removed the style already. */
    }
  };
  const timer = setTimeout(
    () => {
      stop();
      onStale();
    },
    Math.max(0, expiry - Date.now()),
  );
  document.addEventListener("visibilitychange", update);
  preference.addEventListener("change", update);
  map.on("moveend", moved);
  update();
  return stop;
}
