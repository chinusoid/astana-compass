"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin, Map as MapIcon, Compass } from "lucide-react";
import type { Location, Place, RouteEstimate } from "@astana/api-client";
import type { Map as LibreMap, Marker, GeoJSONSource } from "maplibre-gl";
import { routeGeometry } from "@/lib/contracts";
import { t, type Locale } from "@/lib/i18n";

type Props = {
  places: Place[];
  origin: Location | null;
  activeId: string | null;
  selectedIds: string[];
  route: RouteEstimate | null;
  locale: Locale;
  picking: boolean;
  enabled: boolean;
  provider: "osm" | "none";
  onEnable: () => void;
  onPick: (point: Location) => void;
  onSelect: (id: string) => void;
};

export default function CityMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const current = useRef(props);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    current.current = props;
  });
  useEffect(() => {
    if (!props.enabled || !container.current) return;
    let disposed = false;
    const host = container.current;
    import("maplibre-gl")
      .then((lib) => {
        if (disposed) return;
        try {
          setFailed(false);
          lib.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
          const map = new lib.Map({
            container: host,
            center: [71.4305, 51.1283],
            zoom: 12,
            maxZoom: 19,
            attributionControl: false,
            style: {
              version: 8,
              sources:
                props.provider === "osm"
                  ? {
                      osm: {
                        type: "raster",
                        tiles: [
                          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                        ],
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
                  paint: { "background-color": "#e5e9dd" },
                },
                ...(props.provider === "osm"
                  ? [{ id: "basemap", type: "raster" as const, source: "osm" }]
                  : []),
              ],
            },
            locale: {
              "NavigationControl.ZoomIn": t(props.locale, "mapZoomIn"),
              "NavigationControl.ZoomOut": t(props.locale, "mapZoomOut"),
              "NavigationControl.ResetBearing": t(props.locale, "mapNorth"),
            },
          });
          mapRef.current = map;
          map.addControl(
            new lib.NavigationControl({ showCompass: false }),
            "top-right",
          );
          map.addControl(
            new lib.AttributionControl({ compact: false }),
            "bottom-right",
          );
          map.on("load", () => {
            if (disposed) return;
            map.addSource("journey", {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            });
            map.addLayer({
              id: "journey-line",
              type: "line",
              source: "journey",
              paint: { "line-color": "#146b54", "line-width": 5 },
              layout: { "line-cap": "round", "line-join": "round" },
            });
            setReady(true);
          });
          map.on("error", () => {
            if (!disposed) setFailed(true);
          });
          map.on("click", (event) => {
            if (current.current.picking)
              current.current.onPick({
                lat: Number(event.lngLat.lat.toFixed(6)),
                lon: Number(event.lngLat.lng.toFixed(6)),
              });
          });
          const observer = new ResizeObserver(() => map.resize());
          observer.observe(host);
          map.once("remove", () => observer.disconnect());
        } catch {
          if (!disposed) setFailed(true);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      markers.current.forEach((marker) => marker.remove());
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Locale changes rebuild the controls so their screen-reader labels stay translated.
  }, [props.enabled, props.provider, props.locale]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let disposed = false;
    import("maplibre-gl").then((lib) => {
      if (disposed) return;
      markers.current.forEach((marker) => marker.remove());
      const next: Marker[] = [];
      props.places.forEach((place) => {
        const button = document.createElement("button");
        const index = props.selectedIds.indexOf(place.id);
        button.className = `map-marker ${place.id === props.activeId ? "active" : ""} ${index >= 0 ? "selected" : ""}`;
        button.type = "button";
        button.textContent = index >= 0 ? String(index + 1) : "•";
        button.setAttribute(
          "aria-label",
          `${t(props.locale, "showMap")}: ${place.name}`,
        );
        button.setAttribute(
          "aria-pressed",
          String(place.id === props.activeId),
        );
        button.onclick = (event) => {
          event.stopPropagation();
          current.current.onSelect(place.id);
        };
        next.push(
          new lib.Marker({ element: button })
            .setLngLat([place.location.lon, place.location.lat])
            .addTo(map),
        );
      });
      if (props.origin) {
        const element = document.createElement("div");
        element.className = "origin-marker";
        element.setAttribute("role", "img");
        element.setAttribute("aria-label", t(props.locale, "startMarker"));
        next.push(
          new lib.Marker({ element })
            .setLngLat([props.origin.lon, props.origin.lat])
            .addTo(map),
        );
      }
      markers.current = next;
      const geometry = routeGeometry(props.route);
      (map.getSource("journey") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: geometry
          ? [{ type: "Feature", properties: {}, geometry }]
          : [],
      });
    });
    map.getCanvas().style.cursor = props.picking ? "crosshair" : "";
    return () => {
      disposed = true;
    };
  }, [
    ready,
    props.places,
    props.origin,
    props.activeId,
    props.selectedIds,
    props.route,
    props.locale,
    props.picking,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const active = props.places.find((p) => p.id === props.activeId);
    const point = active?.location ?? props.origin;
    if (point)
      map.easeTo({ center: [point.lon, point.lat], zoom: 14, duration: 0 });
  }, [ready, props.activeId, props.origin, props.places]);

  useEffect(() => {
    const geometry = routeGeometry(props.route);
    if (!ready || !mapRef.current || !geometry) return;
    const xs = geometry.coordinates.map((point) => point[0]);
    const ys = geometry.coordinates.map((point) => point[1]);
    mapRef.current.fitBounds(
      [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
      ],
      { padding: 65, maxZoom: 16, duration: 0 },
    );
  }, [ready, props.route]);

  return (
    <section
      className="map-panel"
      aria-labelledby="map-heading"
      data-testid="map-panel"
      data-route-geometry={routeGeometry(props.route) ? "routed" : "none"}
    >
      <div className="map-heading">
        <div>
          <p className="eyebrow">ASTANA / COMPASS</p>
          <h2 id="map-heading">{t(props.locale, "map")}</h2>
          <p>{t(props.locale, "mapHint")}</p>
        </div>
        <Compass size={35} strokeWidth={1.3} aria-hidden="true" />
      </div>
      <div
        className={`map-canvas ${props.picking ? "picking" : ""}`}
        ref={container}
        role="region"
        aria-label={t(props.locale, "map")}
      />
      {!props.enabled && (
        <div className="map-cover">
          <div className="map-orbit" aria-hidden="true">
            <MapPin size={35} />
          </div>
          <p>
            {t(
              props.locale,
              props.provider === "osm" ? "mapPrivacy" : "tilesOff",
            )}
          </p>
          <button type="button" className="secondary" onClick={props.onEnable}>
            <MapIcon size={18} />
            {t(props.locale, "loadMap")}
          </button>
        </div>
      )}
      {props.picking && (
        <p className="map-callout" role="status">
          {t(props.locale, "picking")}
        </p>
      )}
      {failed && (
        <p className="map-callout bottom" role="status">
          {t(props.locale, "mapUnavailable")}
        </p>
      )}
      {props.enabled && props.provider === "none" && (
        <span className="map-no-tiles">{t(props.locale, "tilesOff")}</span>
      )}
      <div className="map-footer">
        <span>
          <i className="legend-dot" />
          {t(props.locale, "startMarker")}
        </span>
        {props.route && (
          <span>
            {t(
              props.locale,
              routeGeometry(props.route) ? "routed" : "approximate",
            )}
          </span>
        )}
        {props.provider === "osm" && (
          <a
            href="https://www.openstreetmap.org/fixthemap"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t(props.locale, "mapIssue")}
          </a>
        )}
      </div>
    </section>
  );
}
