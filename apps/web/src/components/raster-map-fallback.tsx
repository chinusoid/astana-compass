"use client";

/* Native images retain the OSM tile URL and browser cache without an image proxy. */
/* eslint-disable @next/next/no-img-element */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { Location, Place } from "@astana/api-client";
import type { Locale } from "@/lib/i18n";
import type { validatedRouteGeometry } from "@/lib/map-style";
import { journeyColor, journeyLegs } from "@/lib/map-route-segments";
import {
  fitRaster,
  mercator,
  rasterScreen,
  unproject,
  RASTER_DEFAULT,
  type RasterCamera,
} from "@/lib/raster-map-projection";
import styles from "./raster-map-fallback.module.css";

type Props = {
  places: Place[];
  origin: Location | null;
  activeId: string | null;
  stopIds: string[];
  geometry: ReturnType<typeof validatedRouteGeometry>;
  locale: Locale;
  picking: boolean;
  bottomInset?: number;
  overviewRequest?: number;
  includesReturn?: boolean;
  onPick: (point: Location) => void;
  onSelect: (id: string) => void;
  onDetails?: (id: string) => void;
  onInspect: (point: Location) => void;
  onRetry3D: () => void;
};
const COPY = {
  ru: {
    title: "Упрощённая 2D-карта",
    retry: "Вернуть 3D",
    fit: "Весь маршрут",
    start: "Старт",
    zoomIn: "Приблизить",
    zoomOut: "Отдалить",
    pick: "Нажмите на карту, чтобы выбрать старт",
    help: "Перетаскивайте карту; стрелки — перемещение, Enter — выбрать точку",
    tiles: "Некоторые фрагменты карты не загрузились",
    stop: "Остановка",
  },
  kk: {
    title: "Жеңілдетілген 2D-карта",
    retry: "3D-ге қайту",
    fit: "Толық маршрут",
    start: "Бастау",
    zoomIn: "Жақындату",
    zoomOut: "Алыстату",
    pick: "Бастау нүктесін картадан таңдаңыз",
    help: "Картаны жылжытыңыз; бағыттауыштар — жылжыту, Enter — нүкте таңдау",
    tiles: "Картаның кейбір бөліктері жүктелмеді",
    stop: "Аялдама",
  },
  en: {
    title: "Simplified 2D map",
    retry: "Retry 3D",
    fit: "Whole route",
    start: "Start",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    pick: "Tap the map to choose your start",
    help: "Drag the map; arrow keys pan, Enter selects a point",
    tiles: "Some map tiles could not be loaded",
    stop: "Stop",
  },
};

export default function RasterMapFallback(props: Props) {
  const copy = COPY[props.locale];
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [camera, setCamera] = useState<RasterCamera>(() => ({
    ...mercator(props.origin ?? RASTER_DEFAULT),
    zoom: 15,
  }));
  const [tileFailures, setTileFailures] = useState(0);
  const cameraRef = useRef(camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    camera: RasterCamera;
    moved: boolean;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const arrowId = `raster-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const destinations = useMemo(
    () =>
      props.stopIds.flatMap((id) => {
        const place = props.places.find((item) => item.id === id);
        return place ? [place.location] : [];
      }),
    [props.stopIds, props.places],
  );
  const fitPoints = useMemo(
    () => [
      ...(props.origin ? [props.origin] : []),
      ...destinations,
      ...(props.geometry?.coordinates.map(([lon, lat]) => ({ lon, lat })) ??
        []),
    ],
    [props.origin, destinations, props.geometry],
  );
  const fitKey = JSON.stringify(fitPoints);
  const fit = () =>
    setCamera(fitRaster(fitPoints, size.width, size.height, props.bottomInset));

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height)
        setSize((before) =>
          before.width === rect.width && before.height === rect.height
            ? before
            : { width: rect.width, height: rect.height },
        );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    const points = JSON.parse(fitKey) as Location[];
    const id = requestAnimationFrame(() =>
      setCamera(fitRaster(points, size.width, size.height, props.bottomInset)),
    );
    return () => cancelAnimationFrame(id);
  }, [
    fitKey,
    size.width,
    size.height,
    props.bottomInset,
    props.overviewRequest,
  ]);

  const tiles = useMemo(() => {
    let z = camera.zoom;
    const scale = 256 * 2 ** camera.zoom;
    const west = camera.x * scale - size.width / 2,
      north = camera.y * scale - size.height / 2;
    let tileSize = 256;
    while (
      (Math.ceil(size.width / tileSize) + 2) *
        (Math.ceil(size.height / tileSize) + 2) >
        90 &&
      z > 0
    ) {
      z--;
      tileSize *= 2;
    }
    const count = 2 ** z;
    const result: {
      key: string;
      url: string;
      left: number;
      top: number;
      size: number;
    }[] = [];
    for (
      let y = Math.floor(north / tileSize);
      y <= Math.floor((north + size.height) / tileSize);
      y++
    ) {
      if (y < 0 || y >= count) continue;
      for (
        let x = Math.floor(west / tileSize);
        x <= Math.floor((west + size.width) / tileSize);
        x++
      ) {
        const wrappedX = ((x % count) + count) % count;
        result.push({
          key: `${z}/${x}/${y}`,
          url: `https://tile.openstreetmap.org/${z}/${wrappedX}/${y}.png`,
          left: x * tileSize - west,
          top: y * tileSize - north,
          size: tileSize,
        });
      }
    }
    return result.slice(0, 90);
  }, [camera, size]);
  const legs = useMemo(
    () =>
      journeyLegs(props.geometry ?? null, destinations, props.includesReturn),
    [props.geometry, destinations, props.includesReturn],
  );
  const path = (coordinates: [number, number][]) =>
    coordinates
      .map(([lon, lat], index) => {
        const point = rasterScreen(
          { lon, lat },
          camera,
          size.width,
          size.height,
        );
        return `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      })
      .join(" ");
  const stopOrder = new Map(props.stopIds.map((id, index) => [id, index]));
  const markers = props.places
    .map((place) => ({
      place,
      point: rasterScreen(place.location, camera, size.width, size.height),
      order: stopOrder.get(place.id),
    }))
    .filter(
      ({ point }) =>
        point.x > -80 &&
        point.x < size.width + 80 &&
        point.y > -80 &&
        point.y < size.height + 80,
    )
    .sort(
      (a, b) =>
        Number(b.order !== undefined) - Number(a.order !== undefined) ||
        Number(b.place.id === props.activeId) -
          Number(a.place.id === props.activeId) ||
        (a.order ?? 100) - (b.order ?? 100),
    )
    .slice(0, 100);
  const origin = props.origin
    ? rasterScreen(props.origin, camera, size.width, size.height)
    : null;

  const pointAt = (x: number, y: number) => {
    const scale = 256 * 2 ** cameraRef.current.zoom;
    return unproject(
      cameraRef.current.x + (x - size.width / 2) / scale,
      cameraRef.current.y + (y - size.height / 2) / scale,
    );
  };
  const choose = (point: Location) =>
    props.picking ? props.onPick(point) : props.onInspect(point);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      (event.target as Element).closest("button,a")
    )
      return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera: cameraRef.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.x,
      dy = event.clientY - active.y;
    if (Math.hypot(dx, dy) > 5) active.moved = true;
    if (!active.moved) return;
    const scale = 256 * 2 ** active.camera.zoom;
    const next = {
      ...active.camera,
      x: active.camera.x - dx / scale,
      y: Math.max(0, Math.min(1, active.camera.y - dy / scale)),
    };
    cameraRef.current = next;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setCamera(next);
    });
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!active.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      choose(pointAt(event.clientX - rect.left, event.clientY - rect.top));
    }
  };
  const zoom = (delta: number) =>
    setCamera((value) => ({
      ...value,
      zoom: Math.max(3, Math.min(19, value.zoom + delta)),
    }));
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const step = 100 / (256 * 2 ** camera.zoom);
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      setCamera((value) => ({
        ...value,
        x:
          value.x +
          (event.key === "ArrowRight"
            ? step
            : event.key === "ArrowLeft"
              ? -step
              : 0),
        y: Math.max(
          0,
          Math.min(
            1,
            value.y +
              (event.key === "ArrowDown"
                ? step
                : event.key === "ArrowUp"
                  ? -step
                  : 0),
          ),
        ),
      }));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(1);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(unproject(camera.x, camera.y));
    }
  };

  return (
    <div
      ref={host}
      className={styles.map}
      role="region"
      aria-label={`${copy.title}. ${copy.help}`}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={keyboard}
    >
      <div className={styles.tiles} aria-hidden="true">
        {tiles.map((tile) => (
          <img
            key={tile.key}
            src={tile.url}
            alt=""
            draggable={false}
            decoding="async"
            className={styles.tile}
            style={{
              left: tile.left,
              top: tile.top,
              width: tile.size,
              height: tile.size,
            }}
            onError={() => setTileFailures((value) => Math.min(4, value + 1))}
          />
        ))}
      </div>
      <svg
        className={styles.route}
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        aria-hidden="true"
      >
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="7"
            refY="5"
            markerWidth="4"
            markerHeight="4"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 Z" fill="context-stroke" />
          </marker>
        </defs>
        {legs.map((leg, index) => (
          <g key={index}>
            <path
              d={path(leg.geometry.coordinates)}
              fill="none"
              stroke="white"
              strokeWidth={9}
              strokeLinejoin="round"
            />
            <path
              d={path(leg.geometry.coordinates)}
              fill="none"
              stroke={leg.properties.color}
              strokeWidth={5}
              strokeLinejoin="round"
              markerEnd={`url(#${arrowId})`}
            />
          </g>
        ))}
      </svg>
      {origin && (
        <div
          className={styles.origin}
          style={{ left: origin.x, top: origin.y }}
          title={copy.start}
        >
          S<span>{copy.start}</span>
        </div>
      )}
      {markers.map(({ place, point, order }) => (
        <button
          key={place.id}
          type="button"
          className={`${styles.marker} ${order !== undefined ? styles.stop : ""} ${place.id === props.activeId ? styles.active : ""}`}
          style={{
            left: point.x,
            top: point.y,
            backgroundColor:
              order === undefined ? undefined : journeyColor(order),
          }}
          title={place.name}
          aria-label={`${order === undefined ? "" : `${copy.stop} ${order + 1}: `}${place.name}`}
          onClick={() => {
            props.onSelect(place.id);
            props.onDetails?.(place.id);
          }}
        >
          {order === undefined ? "●" : order + 1}
          {(order !== undefined || place.id === props.activeId) && (
            <span>{place.name}</span>
          )}
        </button>
      ))}
      <div className={styles.top}>
        <span role="status">{copy.title}</span>
        <div>
          <button type="button" onClick={fit}>
            {copy.fit}
          </button>
          <button type="button" onClick={props.onRetry3D}>
            {copy.retry}
          </button>
        </div>
      </div>
      <div
        className={styles.zoom}
        style={{
          bottom:
            Math.min(Math.max(0, props.bottomInset ?? 0), size.height - 190) +
            60,
        }}
      >
        <button type="button" aria-label={copy.zoomIn} onClick={() => zoom(1)}>
          +
        </button>
        <button
          type="button"
          aria-label={copy.zoomOut}
          onClick={() => zoom(-1)}
        >
          −
        </button>
      </div>
      {props.picking && <div className={styles.notice}>{copy.pick}</div>}
      {tileFailures >= 3 && (
        <div className={styles.tileNotice} role="status">
          {copy.tiles}
        </div>
      )}
      <div className={styles.attribution}>
        ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
        >
          OpenStreetMap contributors
        </a>
      </div>
    </div>
  );
}
