"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapPin,
  Map as MapIcon,
  LocateFixed,
  RotateCcw,
  Crosshair,
  CarFront,
  Route,
  Search,
  X,
} from "lucide-react";
import type {
  CommunityEvent,
  Location,
  Place,
  RouteEstimate,
  SharedLocation,
  TrafficResponse,
} from "@astana/api-client";
import type { Map as LibreMap, Marker } from "maplibre-gl";
import { t, type Locale } from "@/lib/i18n";
import { mapText } from "@/lib/map-copy";
import { buildingLookupPoint } from "@/lib/map-building";
import { LOCATION_TIMEOUT_MS } from "@/lib/geolocation";
import { keepPopupInMap } from "@/lib/map-popup-bounds";
import {
  ASTANA_VIEW,
  BUILDING_LAYER,
  basemapStyle,
  installBuildings,
  pickedLocation,
  validatedRouteGeometry,
  type MapProvider,
} from "@/lib/map-style";
import { startMapMotion, type MotionStatus } from "@/lib/map-motion";
import { valid } from "@/lib/contracts";
import {
  bindMarkerPopup,
  animateJourney,
  categorySymbol,
  fitJourney,
  installJourney,
  placePopup,
  stopTitle,
} from "@/lib/map-route";
import { journeyColor } from "@/lib/map-route-segments";
import {
  fetchMapFeatures,
  MapFeatureError,
  safeSourceUrl,
  type MapFeaturesResult,
} from "@/lib/map-feature";
import {
  fetchTraffic,
  sampleVisibleRoads,
  startTrafficLayer,
  trafficText,
  TrafficError,
  TRAFFIC_REFRESH_MS,
  type TrafficNotice,
} from "@/lib/map-traffic";

type Props = {
  places: Place[];
  origin: Location | null;
  activeId: string | null;
  selectedIds: string[];
  routeStopIds?: string[];
  overviewRequest?: number;
  bottomInset?: number;
  locationFoundRequest?: number;
  route: RouteEstimate | null;
  locale: Locale;
  picking: boolean;
  enabled: boolean;
  provider: MapProvider;
  communityEvents?: CommunityEvent[];
  sharedLocations?: SharedLocation[];
  onEnable: () => void;
  onPick: (point: Location) => void;
  onSelect: (id: string) => void;
  onDetails?: (id: string) => void;
  onLocationFound?: () => void;
};

type Camera = { center: [number, number]; zoom: number; bearing: number };

export default function CityMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const mapLibrary = useRef<typeof import("maplibre-gl") | null>(null);
  const current = useRef(props);
  const markers = useRef<Marker[]>([]);
  const inspectionMarker = useRef<Marker | null>(null);
  const camera = useRef<Camera | null>(null);
  const featureRequest = useRef<AbortController | null>(null);
  const [inspection, setInspection] = useState<{
    point: Location;
    state: "loading" | "ready" | "error" | "busy";
    result?: MapFeaturesResult;
  } | null>(null);
  const inspectionPoint = inspection?.point;
  const mode = useRef(true);
  const stopMotion = useRef<(() => void) | null>(null);
  const stopJourney = useRef<(() => void) | null>(null);
  const retryJourneyFit = useRef<(() => void) | null>(null);
  const lastJourneyFit = useRef<{
    map: LibreMap;
    geometry: typeof geometry;
    points: Location[];
    overview: number | undefined;
  } | null>(null);
  const stopTraffic = useRef<(() => void) | null>(null);
  const trafficRequest = useRef<AbortController | null>(null);
  const lastTrafficRequest = useRef(0);
  const trafficCooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [traffic, setTraffic] = useState<TrafficResponse | null>(null);
  const [trafficNotice, setTrafficNotice] = useState<TrafficNotice | null>(
    null,
  );
  const [trafficBusy, setTrafficBusy] = useState(false);
  const [trafficCooldown, setTrafficCooldown] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [transient, setTransient] = useState(false);
  const [buildings, setBuildings] = useState(false);
  const [threeD, setThreeD] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState(false);
  const [followState, setFollowState] = useState<
    "idle" | "loading" | "following" | "paused" | "denied" | "unavailable"
  >("idle");
  const followMode = useRef<"idle" | "following" | "paused">("idle");
  const clearFollowError = useRef<(() => void) | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [motionStatus, setMotionStatus] = useState<MotionStatus>("empty");
  const [revealingRoute, setRevealingRoute] = useState(false);
  // An inspection can recreate its parent's route object. Compare coordinates
  // so it never restarts the reveal or recentres a route the user is browsing.
  const geometryKey = JSON.stringify(validatedRouteGeometry(props.route));
  const geometry = useMemo(
    () => JSON.parse(geometryKey) as ReturnType<typeof validatedRouteGeometry>,
    [geometryKey],
  );
  const stopIdKey = JSON.stringify(props.routeStopIds ?? props.selectedIds);
  const stopIds: string[] = useMemo(() => JSON.parse(stopIdKey), [stopIdKey]);
  const journeyPointKey = JSON.stringify([
    ...(props.origin ? [props.origin] : []),
    ...stopIds.flatMap((id) => {
      const place = props.places.find((item) => item.id === id);
      return place ? [place.location] : [];
    }),
  ]);
  const journeyPoints: Location[] = useMemo(
    () => JSON.parse(journeyPointKey),
    [journeyPointKey],
  );
  const destinationKey = JSON.stringify(
    stopIds.flatMap((id) => {
      const place = props.places.find((item) => item.id === id);
      return place ? [place.location] : [];
    }),
  );
  const destinations: Location[] = useMemo(
    () => JSON.parse(destinationKey),
    [destinationKey],
  );
  const hasJourney =
    props.route !== null && (geometry !== null || stopIds.length > 0);
  const ready = status === "ready";
  const has3D = props.provider === "openfreemap" && buildings;
  const is3D = has3D && threeD;
  const text = (key: Parameters<typeof mapText>[1]) =>
    mapText(props.locale, key);

  useEffect(() => {
    current.current = props;
  });

  useEffect(() => {
    if (props.locationFoundRequest) clearFollowError.current?.();
  }, [props.locationFoundRequest]);

  useEffect(() => {
    if (!props.enabled || !container.current) return;
    let disposed = false;
    let localMap: LibreMap | null = null;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    let followTimer: ReturnType<typeof setTimeout> | undefined;
    let hasFollowFix = false;
    let followFailed = false;
    let followDenied = false;
    let replaceGeolocate: (() => void) | undefined;
    const clearFollowTimer = () => {
      clearTimeout(followTimer);
      followTimer = undefined;
    };
    const waitForFollowFix = () => {
      if (followFailed) return;
      setFollowState("loading");
      // A native watch continues after temporary errors. Give it the same
      // bounded recovery window as the planner rather than announcing failure.
      if (followTimer === undefined)
        followTimer = setTimeout(() => {
          followTimer = undefined;
          followFailed = true;
          if (!disposed) setFollowState("unavailable");
        }, LOCATION_TIMEOUT_MS);
    };
    clearFollowError.current = () => {
      // A browser-confirmed planner fix proves that location access recovered.
      // MapLibre disables a denied control's native button, so replace it via
      // its public lifecycle rather than only clearing our feedback text.
      if (followDenied) replaceGeolocate?.();
      followDenied = false;
      followFailed = false;
      clearFollowTimer();
      setFollowState((state) =>
        state === "denied" || state === "unavailable" || state === "loading"
          ? "idle"
          : state,
      );
    };
    const host = container.current;
    const clearLoadingTimer = () => {
      if (loadingTimer) clearTimeout(loadingTimer);
    };
    import("maplibre-gl")
      .then((lib) => {
        if (disposed) return;
        mapLibrary.current = lib;
        try {
          setStatus("loading");
          setTransient(false);
          setBuildings(false);
          setFollowState("idle");
          followMode.current = "idle";
          lib.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
          const map = new lib.Map({
            container: host,
            ...(camera.current ?? ASTANA_VIEW),
            pitch:
              props.provider === "openfreemap" && mode.current
                ? ASTANA_VIEW.pitch
                : 0,
            minZoom: 3,
            maxZoom: 20,
            maxPitch: 70,
            renderWorldCopies: false,
            canvasContextAttributes: { antialias: true },
            attributionControl: false,
            style: basemapStyle(props.provider),
            locale: {
              "NavigationControl.ZoomIn": mapText(props.locale, "zoomIn"),
              "NavigationControl.ZoomOut": mapText(props.locale, "zoomOut"),
              "NavigationControl.ResetBearing": mapText(props.locale, "north"),
              "AttributionControl.ToggleAttribution": mapText(
                props.locale,
                "attribution",
              ),
              "Popup.Close": mapText(props.locale, "closePopup"),
              "GeolocateControl.FindMyLocation": mapText(
                props.locale,
                "followLocation",
              ),
              "GeolocateControl.LocationNotAvailable": mapText(
                props.locale,
                "followUnavailable",
              ),
            },
          });
          localMap = map;
          mapRef.current = map;
          map
            .getCanvas()
            .setAttribute("aria-label", mapText(props.locale, "interactive"));
          map
            .getCanvas()
            .setAttribute("aria-describedby", "map-keyboard-instructions");
          map.addControl(
            new lib.NavigationControl({
              showCompass: true,
              visualizePitch: true,
            }),
            "top-right",
          );
          // Native control requests location only on its own button press. It
          // follows the camera without touching the planner's origin/route,
          // pauses following on pan, and clears its watch when map.remove runs.
          let geolocate: import("maplibre-gl").GeolocateControl;
          const createGeolocate = () => {
            const control = new lib.GeolocateControl({
              positionOptions: {
                enableHighAccuracy: false,
                timeout: 10000,
                maximumAge: 30000,
              },
              trackUserLocation: true,
              showUserLocation: true,
              showAccuracyCircle: true,
              fitBoundsOptions: { maxZoom: 16 },
            });
            const stale = () => disposed || control !== geolocate;
            control.on("trackuserlocationstart", () => {
              if (stale()) return;
              followMode.current = "following";
              followDenied = false;
              followFailed = false;
              clearFollowTimer();
              if (hasFollowFix) {
                setFollowState("following");
              } else waitForFollowFix();
            });
            control.on("trackuserlocationend", () => {
              if (stale()) return;
              followMode.current = "paused";
              clearFollowTimer();
              setFollowState("paused");
            });
            control.on("geolocate", () => {
              if (stale()) return;
              hasFollowFix = true;
              followDenied = false;
              followFailed = false;
              clearFollowTimer();
              setFollowState(followMode.current);
              current.current.onLocationFound?.();
            });
            control.on("error", (event) => {
              if (stale()) return;
              hasFollowFix = false;
              if (event.code === 1) {
                followDenied = true;
                followFailed = true;
                clearFollowTimer();
                setFollowState("denied");
              } else waitForFollowFix();
            });
            return control;
          };
          geolocate = createGeolocate();
          map.addControl(geolocate, "top-right");
          replaceGeolocate = () => {
            map.removeControl(geolocate);
            geolocate = createGeolocate();
            hasFollowFix = false;
            followMode.current = "idle";
            map.addControl(geolocate, "top-right");
          };
          map.addControl(
            new lib.ScaleControl({ maxWidth: 100, unit: "metric" }),
            "bottom-left",
          );
          map.addControl(
            new lib.AttributionControl({ compact: true }),
            "bottom-right",
          );
          loadingTimer = setTimeout(() => {
            if (!disposed) setStatus("failed");
          }, 18_000);
          map.on("load", () => {
            if (disposed) return;
            clearLoadingTimer();
            try {
              setBuildings(
                props.provider === "openfreemap" && installBuildings(map),
              );
              installJourney(map);
              setStatus("ready");
            } catch {
              setStatus("failed");
            }
          });
          map.on("error", () => {
            if (disposed) return;
            // A missing tile/glyph must not replace an otherwise usable map with
            // a full-screen failure. A missing root style cannot be rendered.
            if (!map.getStyle()) {
              clearLoadingTimer();
              setStatus("failed");
            } else setTransient(true);
          });
          map.on("webglcontextlost", () => {
            if (!disposed) setStatus("failed");
          });
          map.on("webglcontextrestored", () => {
            if (!disposed && map.isStyleLoaded()) setStatus("ready");
          });
          map.on("moveend", () => {
            const center = map.getCenter();
            camera.current = {
              center: [center.lng, center.lat],
              zoom: map.getZoom(),
              bearing: map.getBearing(),
            };
          });
          map.on("click", (event) => {
            if (
              (event.originalEvent?.target as Element | null)?.closest?.(
                ".map-marker, .origin-marker, .maplibregl-popup",
              )
            )
              return;
            const point = pickedLocation(event.lngLat.lng, event.lngLat.lat);
            if (!point) return;
            if (current.current.picking) {
              closeInspection();
              setPicked(true);
              current.current.onPick(point);
            } else {
              let lookupPoint = point;
              if (mode.current && event.point && map.getLayer(BUILDING_LAYER)) {
                try {
                  // The rendered extrusion hit-test includes its roof/walls;
                  // event.lngLat alone projects onto the ground behind it.
                  const building = map.queryRenderedFeatures(event.point, {
                    layers: [BUILDING_LAYER],
                  })[0];
                  lookupPoint =
                    buildingLookupPoint(building?.geometry) ?? point;
                } catch {
                  // A tile/style changing during the click keeps ground lookup.
                }
              }
              void inspectPoint(lookupPoint);
            }
          });
          observer = new ResizeObserver(() => {
            if (retryJourneyFit.current) retryJourneyFit.current();
            else map.resize();
          });
          observer.observe(host);
        } catch {
          clearLoadingTimer();
          if (!disposed) setStatus("failed");
        }
      })
      .catch(() => {
        if (!disposed) setStatus("failed");
      });
    return () => {
      disposed = true;
      clearLoadingTimer();
      clearFollowTimer();
      clearFollowError.current = null;
      observer?.disconnect();
      retryJourneyFit.current = null;
      stopMotion.current?.();
      stopMotion.current = null;
      stopJourney.current?.();
      stopJourney.current = null;
      trafficRequest.current?.abort();
      featureRequest.current?.abort();
      stopTraffic.current?.();
      stopTraffic.current = null;
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      inspectionMarker.current?.remove();
      inspectionMarker.current = null;
      localMap?.remove();
      if (mapRef.current === localMap) mapRef.current = null;
    };
    // Rebuilding translated native controls retains the user's camera.
  }, [props.enabled, props.provider, props.locale, attempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let disposed = false;
    const expiryTimers: ReturnType<typeof setTimeout>[] = [];
    import("maplibre-gl")
      .then((lib) => {
        if (disposed) return;
        // Selection can refresh parent arrays or route geometry. Preserve an
        // actually open place popup when replacing markers with updated data.
        const openPlaceId = markers.current
          .find(
            (marker) =>
              marker.getElement().dataset.placeId &&
              marker.getPopup()?.isOpen(),
          )
          ?.getElement().dataset.placeId;
        markers.current.forEach((marker) => marker.remove());
        const next: Marker[] = [];
        props.places.forEach((place) => {
          const button = document.createElement("button");
          const index = stopIds.indexOf(place.id);
          button.className = `map-marker ${place.id === current.current.activeId ? "active" : ""} ${index >= 0 ? "selected" : ""}`;
          button.type = "button";
          button.dataset.placeId = place.id;
          const symbol = document.createElement("span");
          symbol.className = "map-marker-symbol";
          symbol.setAttribute("aria-hidden", "true");
          symbol.textContent =
            index >= 0 ? String(index + 1) : categorySymbol(place.categories);
          button.append(symbol);
          button.title = `${index >= 0 ? `${stopTitle(props.locale, index)} · ` : ""}${place.name}`;
          if (index >= 0) {
            button.style.backgroundColor = journeyColor(index);
            button.style.outlineColor = journeyColor(index);
            const caption = document.createElement("span");
            caption.className = "map-marker-caption";
            caption.textContent = `${place.name}${geometry && !props.route?.includes_return && index === stopIds.length - 1 ? ` · ${mapText(props.locale, "endRoute")}` : ""}`;
            button.append(caption);
          }
          button.setAttribute(
            "aria-label",
            `${index >= 0 ? stopTitle(props.locale, index) : mapText(props.locale, "place")}: ${place.name}`,
          );
          button.setAttribute(
            "aria-pressed",
            String(place.id === current.current.activeId),
          );
          const marker = new lib.Marker({ element: button })
            .setLngLat([place.location.lon, place.location.lat])
            .setPopup(
              new lib.Popup({
                offset: 26,
                maxWidth: "min(330px, calc(100% - 24px))",
                focusAfterOpen: false,
              }).setDOMContent(
                placePopup(place, props.locale, index, () =>
                  (current.current.onDetails ?? current.current.onSelect)(
                    place.id,
                  ),
                ),
              ),
            )
            .addTo(map);
          keepPopupInMap(map, marker.getPopup()!);
          bindMarkerPopup(button, marker, () => {
            closeInspection();
            for (const other of markers.current)
              if (other !== marker) other.getPopup()?.remove();
            current.current.onSelect(place.id);
            current.current.onDetails?.(place.id);
          });
          if (place.id === openPlaceId) marker.togglePopup();
          next.push(marker);
        });
        if (props.origin) {
          const element = document.createElement("button");
          element.type = "button";
          element.className = "origin-marker";
          element.textContent = "S";
          const title = mapText(
            props.locale,
            props.route?.includes_return ? "returnStart" : "start",
          );
          element.setAttribute("aria-label", title);
          element.title = title;
          const content = document.createElement("p");
          content.textContent = title;
          const marker = new lib.Marker({ element })
            .setLngLat([props.origin.lon, props.origin.lat])
            .setPopup(new lib.Popup({ offset: 24 }).setDOMContent(content))
            .addTo(map);
          bindMarkerPopup(element, marker);
          next.push(marker);
        }
        for (const event of props.communityEvents ?? []) {
          const remaining = Date.parse(event.ends_at) - Date.now();
          if (!valid("CommunityEvent", event) || remaining <= 0) continue;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "map-marker community-event-marker";
          button.textContent = "◇";
          button.setAttribute(
            "aria-label",
            `${mapText(props.locale, "community")}: ${event.title}`,
          );
          const content = document.createElement("div");
          content.className = "map-community-popup";
          for (const [tag, value] of [
            ["strong", event.title],
            ["p", mapText(props.locale, "community")],
            ["p", event.description],
          ]) {
            const element = document.createElement(tag);
            element.textContent = value;
            content.append(element);
          }
          const marker = new lib.Marker({ element: button })
            .setLngLat([event.location.lon, event.location.lat])
            .setPopup(new lib.Popup({ offset: 24 }).setDOMContent(content))
            .addTo(map);
          bindMarkerPopup(button, marker);
          next.push(marker);
          if (remaining < 2_147_483_647)
            expiryTimers.push(setTimeout(() => marker.remove(), remaining));
        }
        for (const shared of props.sharedLocations ?? []) {
          const remaining = Date.parse(shared.expires_at) - Date.now();
          if (!valid("SharedLocation", shared) || remaining <= 0) continue;
          const element = document.createElement("div");
          element.className = "map-marker shared-location-marker";
          element.textContent = Array.from(shared.profile.name)[0] ?? "•";
          element.setAttribute("role", "img");
          element.setAttribute(
            "aria-label",
            `${mapText(props.locale, "shared")}: ${shared.profile.name}`,
          );
          element.title = `${mapText(props.locale, "shared")}: ${shared.profile.name}`;
          element.onclick = (click) => click.stopPropagation();
          const marker = new lib.Marker({ element })
            .setLngLat([shared.coordinates.lon, shared.coordinates.lat])
            .addTo(map);
          next.push(marker);
          // Do not retain a friend's position after its consent TTL, even when no
          // subsequent network response or React rerender arrives.
          expiryTimers.push(
            setTimeout(
              () => marker.remove(),
              Math.min(remaining, 2_147_483_647),
            ),
          );
        }
        markers.current = next;
      })
      .catch(() => {
        if (!disposed) setTransient(true);
      });
    map.getCanvas().style.cursor = props.picking ? "crosshair" : "";
    return () => {
      disposed = true;
      expiryTimers.forEach(clearTimeout);
    };
  }, [
    ready,
    props.places,
    props.origin,
    stopIds,
    props.route?.includes_return,
    geometry,
    props.locale,
    props.picking,
    props.communityEvents,
    props.sharedLocations,
  ]);

  useEffect(() => {
    const buttons = container.current?.querySelectorAll<HTMLButtonElement>(
      "button.map-marker[aria-pressed]",
    );
    for (const button of buttons ?? []) {
      const active = button.dataset.placeId === props.activeId;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }, [ready, props.activeId]);

  useEffect(() => {
    const map = mapRef.current;
    const lib = mapLibrary.current;
    if (!ready || !map || !lib || !inspectionPoint || props.picking) return;
    inspectionMarker.current?.remove();
    const element = document.createElement("div");
    element.className = "map-inspection-pin";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", mapText(props.locale, "inspect"));
    inspectionMarker.current = new lib.Marker({ element })
      .setLngLat([inspectionPoint.lon, inspectionPoint.lat])
      .addTo(map);
    return () => {
      inspectionMarker.current?.remove();
      inspectionMarker.current = null;
    };
  }, [ready, inspectionPoint, props.picking, props.locale]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (map.getLayer(BUILDING_LAYER))
      map.setLayoutProperty(
        BUILDING_LAYER,
        "visibility",
        is3D ? "visible" : "none",
      );
    map.easeTo({ pitch: is3D ? ASTANA_VIEW.pitch : 0, duration: 0 });
  }, [ready, is3D]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !motionEnabled || props.provider !== "openfreemap")
      return;
    const stop = startMapMotion(map, setMotionStatus);
    stopMotion.current = stop;
    return () => {
      stop();
      if (stopMotion.current === stop) stopMotion.current = null;
    };
  }, [ready, motionEnabled, props.provider]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !traffic) return;
    let active = true;
    try {
      const stop = startTrafficLayer(map, traffic, () => {
        if (active) {
          setTraffic(null);
          setTrafficNotice("stale");
        }
      });
      stopTraffic.current = stop;
      return () => {
        active = false;
        stop();
        if (stopTraffic.current === stop) stopTraffic.current = null;
      };
    } catch {
      queueMicrotask(() => {
        if (active) {
          setTraffic(null);
          setTrafficNotice("invalid");
        }
      });
      return () => {
        active = false;
      };
    }
  }, [ready, traffic]);

  useEffect(
    () => () => {
      trafficRequest.current?.abort();
      stopTraffic.current?.();
      if (trafficCooldownTimer.current)
        clearTimeout(trafficCooldownTimer.current);
    },
    [],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || props.route) return;
    const point =
      props.places.find((place) => place.id === props.activeId)?.location ??
      props.origin;
    if (point)
      map.easeTo({
        center: [point.lon, point.lat],
        zoom: Math.max(map.getZoom(), ASTANA_VIEW.zoom),
        duration: 0,
      });
  }, [ready, props.activeId, props.origin, props.places, props.route]);

  useEffect(() => {
    retryJourneyFit.current = null;
    const map = mapRef.current;
    if (!ready || !map || !hasJourney) {
      lastJourneyFit.current = null;
      return;
    }
    const previous = lastJourneyFit.current;
    // A sheet resize updates framing once without a second camera animation.
    const animate =
      !previous ||
      previous.map !== map ||
      previous.geometry !== geometry ||
      previous.points !== journeyPoints ||
      previous.overview !== props.overviewRequest;
    lastJourneyFit.current = {
      map,
      geometry,
      points: journeyPoints,
      overview: props.overviewRequest,
    };
    const fit = () => {
      retryJourneyFit.current = fitJourney(
        map,
        geometry,
        journeyPoints,
        animate,
        props.bottomInset,
      )
        ? null
        : fit;
    };
    fit();
    return () => {
      retryJourneyFit.current = null;
    };
  }, [
    ready,
    geometry,
    hasJourney,
    journeyPoints,
    props.overviewRequest,
    props.bottomInset,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setRevealingRoute(geometry !== null);
    const stop = animateJourney(
      map,
      geometry,
      destinations,
      props.route?.includes_return,
      () => setRevealingRoute(false),
    );
    stopJourney.current = stop;
    return () => {
      stop();
      if (stopJourney.current === stop) stopJourney.current = null;
    };
  }, [ready, geometry, destinations, props.route?.includes_return]);

  function closeInspection() {
    featureRequest.current?.abort();
    featureRequest.current = null;
    setInspection(null);
  }
  async function inspectPoint(point: Location) {
    featureRequest.current?.abort();
    const controller = new AbortController();
    featureRequest.current = controller;
    setInspection({ point, state: "loading" });
    try {
      const result = await fetchMapFeatures(
        point,
        current.current.locale,
        controller.signal,
      );
      if (!controller.signal.aborted && featureRequest.current === controller)
        setInspection({ point, state: "ready", result });
    } catch (error) {
      if (!controller.signal.aborted && featureRequest.current === controller)
        setInspection({
          point,
          state:
            error instanceof MapFeatureError && error.code === "busy"
              ? "busy"
              : "error",
        });
    } finally {
      if (featureRequest.current === controller) featureRequest.current = null;
    }
  }

  function setDimension(value: boolean) {
    mode.current = value;
    setThreeD(value);
    if (value && mapRef.current)
      mapRef.current.easeTo({
        zoom: Math.max(mapRef.current.getZoom(), ASTANA_VIEW.zoom),
        duration: 0,
      });
  }
  function confirmCentre() {
    const center = mapRef.current?.getCenter();
    const point = center && pickedLocation(center.lng, center.lat);
    if (point && ready && props.picking) {
      setPicked(true);
      props.onPick(point);
    }
  }

  async function loadTraffic() {
    const map = mapRef.current;
    if (!ready || !map || trafficRequest.current) return;
    if (Date.now() - lastTrafficRequest.current < TRAFFIC_REFRESH_MS) {
      setTrafficNotice("cooldown");
      return;
    }
    let points: Location[];
    try {
      points = sampleVisibleRoads(map);
    } catch {
      points = [];
    }
    if (!points.length) {
      setTrafficNotice("no_roads");
      return;
    }
    const controller = new AbortController();
    trafficRequest.current = controller;
    lastTrafficRequest.current = Date.now();
    setTrafficCooldown(true);
    if (trafficCooldownTimer.current)
      clearTimeout(trafficCooldownTimer.current);
    trafficCooldownTimer.current = setTimeout(
      () => setTrafficCooldown(false),
      TRAFFIC_REFRESH_MS,
    );
    stopTraffic.current?.();
    setTraffic(null);
    setTrafficBusy(true);
    setTrafficNotice("loading");
    try {
      const result = await fetchTraffic(points, controller.signal);
      if (controller.signal.aborted) return;
      setTrafficNotice(result.status);
      if (result.status === "live" || result.status === "partial") {
        stopMotion.current?.();
        setMotionEnabled(false);
        setTraffic(result);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setTrafficNotice(
          error instanceof TrafficError ? error.code : "unavailable",
        );
    } finally {
      if (trafficRequest.current === controller) trafficRequest.current = null;
      setTrafficBusy(false);
    }
  }

  return (
    <section
      className="map-panel"
      aria-labelledby="map-heading"
      data-testid="map-panel"
      data-route-geometry={geometry ? "routed" : "none"}
      data-route-revealing={revealingRoute}
      data-map-mode={is3D ? "3d" : "2d"}
      data-map-status={status}
    >
      <div className="map-heading">
        <div>
          <p className="eyebrow">ASTANA / COMPASS</p>
          <h2 id="map-heading">{text("title")}</h2>
          <p>{text("hint")}</p>
        </div>
      </div>
      <div className="map-viewport">
        <div
          className={`map-canvas ${props.picking ? "picking" : ""}`}
          ref={container}
          role="region"
          aria-label={text("title")}
        />
        {props.enabled && ready && hasJourney && !props.picking && (
          <div
            className="map-journey-summary"
            data-testid="map-journey-summary"
          >
            <p role="status" aria-live="polite">
              <Route size={17} aria-hidden="true" />
              {text(
                revealingRoute
                  ? "routeAppearing"
                  : geometry
                    ? "routeReady"
                    : "routePointsReady",
              )}
            </p>
            {geometry && (
              <ol className="map-journey-legs" aria-label={text("routeLegs")}>
                {stopIds.map((id, index) => {
                  const name = props.places.find(
                    (place) => place.id === id,
                  )?.name;
                  return (
                    <li
                      key={id}
                      style={{ color: journeyColor(index) }}
                      title={name}
                    >
                      <span aria-hidden="true">●</span> {index ? index : "S"} →{" "}
                      {index + 1}
                    </li>
                  );
                })}
                {props.route?.includes_return && (
                  <li style={{ color: journeyColor(stopIds.length, true) }}>
                    <span aria-hidden="true">●</span> {stopIds.length} → S
                  </li>
                )}
              </ol>
            )}
          </div>
        )}
        {props.enabled && (
          <div
            className="map-toolbar"
            role="group"
            aria-label={text("controls")}
          >
            <button
              type="button"
              className="map-tool"
              data-testid="map-mode-2d"
              aria-label={text("mode2d")}
              aria-pressed={!is3D}
              disabled={!ready}
              onClick={() => setDimension(false)}
            >
              2D
            </button>
            <button
              type="button"
              className="map-tool"
              data-testid="map-mode-3d"
              aria-label={text("mode3d")}
              aria-pressed={is3D}
              disabled={!ready || !has3D}
              title={!has3D ? text("no3d") : text("mode3d")}
              onClick={() => setDimension(true)}
            >
              3D
            </button>
            <button
              type="button"
              className="map-tool"
              data-testid="map-recenter"
              aria-label={text("recenter")}
              title={text("recenter")}
              disabled={!ready}
              onClick={() =>
                mapRef.current?.easeTo({
                  ...ASTANA_VIEW,
                  pitch: is3D ? ASTANA_VIEW.pitch : 0,
                  duration: 0,
                })
              }
            >
              <LocateFixed size={20} aria-hidden="true" />
            </button>
            {hasJourney && (
              <button
                type="button"
                className="map-tool"
                data-testid="map-route-overview"
                disabled={!ready}
                onClick={() => {
                  const map = mapRef.current;
                  if (!map) return;
                  const fit = () => {
                    retryJourneyFit.current = fitJourney(
                      map,
                      geometry,
                      journeyPoints,
                      false,
                      props.bottomInset,
                    )
                      ? null
                      : fit;
                  };
                  fit();
                }}
              >
                <Route size={18} aria-hidden="true" />
                {text("overview")}
              </button>
            )}
            {!props.picking && (
              <button
                type="button"
                className="map-tool"
                disabled={!ready}
                onClick={() => {
                  const center = mapRef.current?.getCenter();
                  const point =
                    center && pickedLocation(center.lng, center.lat);
                  if (point) void inspectPoint(point);
                }}
              >
                <Search size={18} aria-hidden="true" />
                {text("inspectCentre")}
              </button>
            )}
            {props.provider === "openfreemap" && (
              <button
                type="button"
                className="map-tool map-motion-toggle"
                data-testid="map-motion-toggle"
                aria-pressed={motionEnabled}
                disabled={!ready || traffic !== null}
                onClick={() => setMotionEnabled((value) => !value)}
              >
                {text("motion")}
              </button>
            )}
            {props.provider === "openfreemap" && (
              <>
                <button
                  type="button"
                  className="map-tool map-traffic-toggle"
                  data-testid="map-traffic-toggle"
                  aria-pressed={traffic !== null}
                  disabled={
                    !ready || trafficBusy || (!traffic && trafficCooldown)
                  }
                  title={
                    trafficCooldown && !traffic
                      ? trafficText(props.locale, "cooldown")
                      : undefined
                  }
                  onClick={() => {
                    if (traffic) {
                      stopTraffic.current?.();
                      setTraffic(null);
                      setTrafficNotice(null);
                    } else void loadTraffic();
                  }}
                >
                  <CarFront size={18} aria-hidden="true" />
                  {trafficText(props.locale, traffic ? "hide" : "action")}
                </button>
                {traffic && (
                  <button
                    type="button"
                    className="map-tool"
                    aria-label={trafficText(props.locale, "refresh")}
                    title={trafficText(
                      props.locale,
                      trafficCooldown ? "cooldown" : "refresh",
                    )}
                    disabled={trafficBusy || trafficCooldown}
                    onClick={() => void loadTraffic()}
                  >
                    <RotateCcw size={18} />
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {!props.enabled && (
          <div className="map-cover">
            <div className="map-orbit" aria-hidden="true">
              <MapPin size={35} />
            </div>
            <p>{text(props.provider === "none" ? "offline" : "privacy")}</p>
            <button
              type="button"
              className="secondary"
              onClick={props.onEnable}
            >
              <MapIcon size={18} aria-hidden="true" />
              {text("load")}
            </button>
          </div>
        )}
        {props.enabled && status === "loading" && (
          <div className="map-cover map-loading" role="status">
            <MapIcon size={28} aria-hidden="true" />
            <p>{text("loading")}</p>
          </div>
        )}
        {props.enabled && status === "failed" && (
          <div className="map-cover map-failure" role="status">
            <MapIcon size={28} aria-hidden="true" />
            <p>{text("failed")}</p>
            <button
              type="button"
              className="secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCcw size={18} aria-hidden="true" />
              {text("retry")}
            </button>
          </div>
        )}
        {props.enabled && ready && transient && (
          <div className="map-status" role="status">
            <p>{text("transient")}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {text("retry")}
            </button>
          </div>
        )}
        {props.enabled && ready && props.picking && (
          <>
            <span className="map-center-crosshair" aria-hidden="true">
              <Crosshair size={26} />
            </span>
            <div className="map-pick-panel" role="status">
              <p>{text("picking")}</p>
              <p id="map-keyboard-instructions">{text("keyboard")}</p>
              <button
                type="button"
                className="secondary"
                data-testid="map-confirm-origin"
                onClick={confirmCentre}
              >
                {text("confirm")}
              </button>
            </div>
          </>
        )}
        {props.enabled && ready && !props.picking && inspection && (
          <aside
            className="map-inspection"
            aria-labelledby="map-inspection-heading"
            data-testid="map-inspection"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeInspection();
            }}
          >
            <div className="map-inspection-heading">
              <h3 id="map-inspection-heading">{text("inspect")}</h3>
              <button
                type="button"
                className="map-tool"
                aria-label={text("closePopup")}
                onClick={closeInspection}
              >
                <X size={18} />
              </button>
            </div>
            <p className="map-inspection-coordinate">
              {inspection.point.lat.toFixed(5)},{" "}
              {inspection.point.lon.toFixed(5)}
            </p>
            {inspection.state === "loading" && (
              <p role="status">{text("inspectLoading")}</p>
            )}
            {(inspection.state === "error" || inspection.state === "busy") && (
              <div role="status">
                <p>
                  {text(
                    inspection.state === "busy"
                      ? "inspectSlow"
                      : "inspectError",
                  )}
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void inspectPoint(inspection.point)}
                >
                  {text("retry")}
                </button>
              </div>
            )}
            {inspection.result?.status === "empty" && (
              <p role="status">{text("inspectEmpty")}</p>
            )}
            {!!inspection.result?.features.length && (
              <>
                {inspection.result.features.map((feature) => (
                  <article key={feature.id}>
                    <p className="map-feature-match">
                      {text(
                        feature.match === "contains"
                          ? "contains"
                          : "nearbyMatch",
                      )}
                      {feature.match === "nearby"
                        ? ` · ${Math.round(feature.distance_meters)} ${text("meters")}`
                        : ""}
                    </p>
                    <h4>{feature.name}</h4>
                    <p>{feature.kind}</p>
                    <p>{feature.address ?? text("addressUnknown")}</p>
                    <p>
                      {feature.description ?? text("inspectDescriptionUnknown")}
                    </p>
                    <dl>
                      {feature.attributes.map((attribute, index) => (
                        <div key={`${attribute.label}-${index}`}>
                          <dt>{attribute.label}</dt>
                          <dd>{attribute.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {safeSourceUrl(feature.source_url) && (
                      <a
                        href={safeSourceUrl(feature.source_url)!}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {feature.source_label || text("inspectSource")}
                      </a>
                    )}
                  </article>
                ))}
                <small>{text("sourceClaim")}</small>
              </>
            )}
            {inspection.result && (
              <footer>
                <p>{inspection.result.attribution}</p>
                <p>
                  {text("retrieved")}:{" "}
                  <time dateTime={inspection.result.retrieved_at}>
                    {new Intl.DateTimeFormat(props.locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(inspection.result.retrieved_at))}
                  </time>
                </p>
              </footer>
            )}
          </aside>
        )}
        {(!props.enabled || !ready || !props.picking) && (
          <span id="map-keyboard-instructions" className="sr-only">
            {text("keyboard")}
          </span>
        )}
      </div>
      <div className="map-footer map-footer-compact">
        <div className="map-footer-bar">
          {props.provider !== "none" && (
            <span className="map-attribution" data-testid="map-attribution">
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noopener noreferrer"
              >
                © OpenStreetMap
              </a>
              {props.provider === "openfreemap" && (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href="https://openfreemap.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    OpenFreeMap
                  </a>
                </>
              )}
              {traffic && (
                <span className="traffic-attribution">
                  {" "}
                  · {traffic.attribution}
                </span>
              )}
            </span>
          )}
          {motionEnabled && props.provider === "openfreemap" && (
            <span
              className="map-simulation-badge"
              data-testid="map-motion-summary"
              title={text("simulation")}
            >
              {text("motion")}
            </span>
          )}
          <details className="map-about" data-testid="map-about">
            <summary>{text("privacyLabel")}</summary>
            <div className="map-about-content">
              <span>
                <b className="map-legend-origin" aria-hidden="true">
                  S
                </b>{" "}
                {props.route?.includes_return
                  ? text("returnStart")
                  : picked && !props.picking
                    ? text("selected")
                    : text("start")}
              </span>
              <span>
                <b aria-hidden="true">☕ ♧ ▥</b> {text("placesLegend")}
              </span>
              {!!stopIds.length && (
                <span>
                  <b className="map-legend-stop" aria-hidden="true">
                    1
                  </b>{" "}
                  {text("stopsLegend")}
                </span>
              )}
              {geometry && (
                <span>
                  <b
                    className="map-legend-route"
                    aria-hidden="true"
                    style={{ color: journeyColor(0) }}
                  >
                    ➜
                  </b>{" "}
                  {text("routeLegend")}
                </span>
              )}
              {!props.picking && (
                <span className="map-inspect-hint">{text("inspectHint")}</span>
              )}
              {!props.picking && props.enabled && (
                <span className="map-inspect-privacy">
                  {text("inspectPrivacy")}
                </span>
              )}
              {props.route && (
                <span>
                  {t(props.locale, geometry ? "routed" : "approximate")}
                </span>
              )}
              {props.provider === "openfreemap" && (
                <span className="map-height-note">{text("heights")}</span>
              )}
              {motionEnabled && props.provider === "openfreemap" && (
                <span className="map-motion-status" role="status">
                  <span className="motion-car">{text("cars")}</span> ·{" "}
                  <span className="motion-walker">{text("walkers")}</span> ·{" "}
                  {text("simulation")}{" "}
                  {motionStatus !== "running" &&
                    text(
                      motionStatus === "paused"
                        ? "motionPaused"
                        : "motionEmpty",
                    )}
                </span>
              )}
              {traffic && (
                <div className="map-traffic-details">
                  <p>{traffic.attribution}</p>
                  <p>{trafficText(props.locale, "illustration")}</p>
                  <p>{trafficText(props.locale, "colors")}</p>
                </div>
              )}
              {props.provider !== "none" && (
                <>
                  <p>{text("privacy")}</p>
                  <p>{text("followHint")}</p>
                  <a
                    href="https://www.openstreetmap.org/fixthemap"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {text("issue")}
                  </a>
                </>
              )}
            </div>
          </details>
        </div>
        {followState !== "idle" && (
          <span className="map-footer-notice" role="status" aria-live="polite">
            {text(
              followState === "loading"
                ? "followLoading"
                : followState === "following"
                  ? "following"
                  : followState === "paused"
                    ? "followPaused"
                    : followState === "denied"
                      ? "followDenied"
                      : "followUnavailable",
            )}
          </span>
        )}
        {trafficNotice && (
          <span
            className="map-footer-notice map-traffic-notice"
            role="status"
            data-testid="map-traffic-notice"
          >
            {trafficText(props.locale, trafficNotice)}
          </span>
        )}
        {props.enabled && props.provider === "none" && (
          <span className="map-footer-notice">{text("offline")}</span>
        )}
      </div>
    </section>
  );
}
