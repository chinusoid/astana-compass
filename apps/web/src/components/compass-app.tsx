"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bookmark,
  CalendarDays,
  ChevronRight,
  Compass,
  Footprints,
  Globe2,
  Info,
  LocateFixed,
  MapPin,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import type {
  CommunityEvent,
  SharedLocation,
  Constraint,
  DataStatusResponse,
  ItineraryResponse,
  Place,
  RecommendationRequest,
  RecommendationResponse,
} from "@astana/api-client";
import { ApiError, asApiError, createApi, type DataMode } from "@/lib/api";
import { astanaInstant, dateTime, duration, safeUrl } from "@/lib/format";
import {
  constraintKeys,
  label,
  locales,
  t,
  type Locale,
  type MessageKey,
} from "@/lib/i18n";
import { valid } from "@/lib/contracts";
import { SocialPlannerContext } from "@/lib/shared-planner";
import {
  Dialog,
  ErrorNotice,
  PlaceFacts,
  RouteNotes,
  Warnings,
} from "./details";
import PlaceCard from "./place-card";
import IntentReview from "./intent-review";
import OsmAttribution, { isOsmSourceUrl } from "./osm-attribution";
import { applyIntentConstraints } from "@/lib/intent";
import { intentText } from "@/lib/intent-copy";
import { mapText } from "@/lib/map-copy";
import { stopTitle } from "@/lib/map-route";
import { sourceDescription } from "@/lib/place-presentation";
import TimeBudgetNote from "./time-budget-note";
import scenarioStyles from "./scenario-feedback.module.css";

const CityMap = dynamic(() => import("./city-map"), { ssr: false });
const FAVORITES_KEY = "astana-compass:favorites:v1";
const walkPresets: {
  label: MessageKey;
  query: MessageKey;
  preference?: string;
}[] = [
  { label: "parkWalk", query: "parkWalkQuery" },
  { label: "riversideWalk", query: "riversideWalkQuery" },
  { label: "architectureWalk", query: "architectureWalkQuery" },
  { label: "mixedWalk", query: "mixedWalkQuery" },
  { label: "indoors", query: "indoorsQuery", preference: "indoor" },
  { label: "family", query: "familyQuery", preference: "child_friendly" },
];
type Favorite = Pick<Place, "id" | "name" | "is_synthetic">;
type FormState = {
  query: string;
  minutes: string;
  start: string;
  lat: string;
  lon: string;
  returnToOrigin: boolean;
  constraints: Record<string, "" | Constraint["strength"]>;
};
type DialogState = "place" | null;

function scenarioKey(form: FormState, locale: Locale) {
  return JSON.stringify([
    locale,
    form.query.trim(),
    form.minutes,
    form.start,
    form.lat,
    form.lon,
    form.returnToOrigin,
    Object.entries(form.constraints)
      .filter(([, strength]) => strength)
      .sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

export default function CompassApp({
  initialStart,
  allowFixtures,
  mapProvider,
  children,
}: {
  initialStart: string;
  allowFixtures: boolean;
  mapProvider: "openfreemap" | "osm" | "none";
  children?: React.ReactNode;
}) {
  const pathname = usePathname();
  const view =
    pathname === "/walk"
      ? "walk"
      : pathname === "/saved"
        ? "saved"
        : pathname === "/about"
          ? "about"
          : pathname === "/party"
            ? "party"
            : pathname === "/events"
              ? "events"
              : "discover";
  const [locale, setLocale] = useState<Locale>("ru");
  const [form, setForm] = useState<FormState>({
    query: "",
    minutes: "60",
    start: initialStart,
    lat: "",
    lon: "",
    returnToOrigin: true,
    constraints: {},
  });
  const [mode, setMode] = useState<DataMode>("unknown");
  const api = useMemo(() => createApi(allowFixtures, setMode), [allowFixtures]);
  const [result, setResult] = useState<RecommendationResponse | null>(null);
  const [resultError, setResultError] = useState<ApiError | null>(null);
  const [searching, setSearching] = useState(false);
  const [submittedScenario, setSubmittedScenario] = useState<{
    key: string;
    query: string;
  } | null>(null);
  const [formError, setFormError] = useState(false);
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<Place[]>([]);
  const [itinerary, setItinerary] = useState<ItineraryResponse | null>(null);
  const [communityEvents, setCommunityEvents] = useState<CommunityEvent[]>([]);
  const [sharedLocations, setSharedLocations] = useState<SharedLocation[]>([]);
  const [sharedItinerary, setSharedItinerary] =
    useState<ItineraryResponse | null>(null);
  const [itineraryError, setItineraryError] = useState<ApiError | null>(null);
  const [building, setBuilding] = useState(false);
  const [catalog, setCatalog] = useState<Place[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [loadedQuery, setLoadedQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<ApiError | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overviewRequest, setOverviewRequest] = useState(0);
  const [mapEnabled, setMapEnabled] = useState(true);
  const [picking, setPicking] = useState(true);
  const [geoState, setGeoState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [dialog, setDialog] = useState<DialogState>(null);
  const [detail, setDetail] = useState<Place | null>(null);
  const [detailError, setDetailError] = useState<ApiError | null>(null);
  const [data, setData] = useState<DataStatusResponse | null>(null);
  const [dataError, setDataError] = useState<ApiError | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [storageError, setStorageError] = useState(false);
  const [feedbackState, setFeedbackState] = useState<
    "idle" | "loading" | "sent"
  >("idle");
  const [feedbackError, setFeedbackError] = useState<ApiError | null>(null);
  const requests = useRef<Record<string, AbortController>>({});
  const searchPending = useRef(false);
  const plannerSnapshot = useRef({ form, selected });
  useEffect(() => {
    // Geolocation may finish after the user edits their text or selected stops.
    plannerSnapshot.current = { form, selected };
  }, [form, selected]);
  const geoVersion = useRef(0);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const planHeading = useRef<HTMLHeadingElement>(null);

  const begin = useCallback((name: string) => {
    requests.current[name]?.abort();
    const controller = new AbortController();
    requests.current[name] = controller;
    return controller;
  }, []);
  useEffect(() => {
    const controllers = requests.current;
    return () => {
      Object.values(controllers).forEach((c) => c.abort());
      // Async callback generation counter, intentionally invalidate on unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      geoVersion.current++;
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(FAVORITES_KEY) ?? "[]",
      );
      if (Array.isArray(stored)) {
        const safe = stored
          .filter((p): p is Favorite =>
            Boolean(
              p &&
              typeof p === "object" &&
              typeof p.id === "string" &&
              typeof p.name === "string" &&
              typeof p.is_synthetic === "boolean" &&
              p.id.length <= 512 &&
              p.name.length <= 1000,
            ),
          )
          .slice(0, 100)
          .map(({ id, name, is_synthetic }) => ({ id, name, is_synthetic }));
        // Hydrate device-local favorites after SSR; no location or query is persisted.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFavorites(safe);
      }
    } catch {
      setStorageError(true);
    }
  }, []);
  const loadCatalog = useCallback(
    async (query: string, next?: string) => {
      const controller = begin("catalog");
      setCatalogLoading(true);
      setCatalogError(null);
      if (!next) {
        setCatalog([]);
        setCursor(null);
      }
      try {
        const response = await api.places(controller.signal, query, next);
        if (!controller.signal.aborted) {
          setCatalog((previous) =>
            next
              ? [
                  ...new Map(
                    [...previous, ...response.places].map((p) => [p.id, p]),
                  ).values(),
                ]
              : response.places,
          );
          setCursor(response.next_cursor);
          setLoadedQuery(query);
        }
      } catch (error) {
        if (!controller.signal.aborted) setCatalogError(asApiError(error));
      } finally {
        if (!controller.signal.aborted) setCatalogLoading(false);
      }
    },
    [api, begin],
  );
  useEffect(() => {
    const controllers = requests.current;
    // Initial read hydrates the catalog from the actual API, without synthetic fallback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCatalog("");
    return () => controllers.catalog?.abort();
  }, [loadCatalog]);

  function invalidatePlan() {
    requests.current.itinerary?.abort();
    setBuilding(false);
    setItinerary(null);
    setItineraryError(null);
  }
  function invalidateSearch() {
    requests.current.recommendation?.abort();
    requests.current.feedback?.abort();
    setSearching(false);
    searchPending.current = false;
    setResult(null);
    setResultError(null);
    setFormError(false);
    setFeedbackState("idle");
    setFeedbackError(null);
    invalidatePlan();
  }
  function updateForm(patch: Partial<FormState>, rebuild = false) {
    const next = { ...plannerSnapshot.current.form, ...patch };
    invalidateSearch();
    if ("lat" in patch || "lon" in patch) {
      geoVersion.current++;
      setGeoState("idle");
    }
    setForm((previous) => ({ ...previous, ...patch }));
    if (rebuild || "returnToOrigin" in patch)
      rebuildSelected(plannerSnapshot.current.selected, next);
  }
  function changeLocale(value: Locale) {
    invalidateSearch();
    setLocale(value);
    setAnswer("");
    requests.current.detail?.abort();
    setDialog(null);
  }
  function requestFromForm(
    query = form.query,
    snapshot = form,
  ): RecommendationRequest {
    if (
      !query.trim() ||
      query.length > 2000 ||
      !snapshot.lat.trim() ||
      !snapshot.lon.trim() ||
      !snapshot.minutes.trim()
    )
      throw new Error("invalid form");
    const seconds = Number(snapshot.minutes) * 60;
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400)
      throw new Error("invalid budget");
    const request: RecommendationRequest = {
      query: query.trim(),
      locale,
      origin: { lat: Number(snapshot.lat), lon: Number(snapshot.lon) },
      start_at: astanaInstant(snapshot.start),
      timezone: "Asia/Almaty",
      available_seconds: seconds,
      transport: "walking",
      return_to_origin: snapshot.returnToOrigin,
      constraints: Object.entries(snapshot.constraints).flatMap(
        ([key, strength]) => (strength ? [{ key, value: true, strength }] : []),
      ),
      limit: 3,
    };
    if (!valid("RecommendationRequest", request))
      throw new Error("invalid form");
    return request;
  }
  async function recommend(query = form.query) {
    // The ref also covers repeated Enter presses before React renders busy state.
    if (searchPending.current) return;
    invalidateSearch();
    let body: RecommendationRequest;
    try {
      body = requestFromForm(query);
    } catch {
      setFormError(true);
      document
        .getElementById("planner-form")
        ?.scrollIntoView?.({ block: "start" });
      return;
    }
    const controller = begin("recommendation");
    setSelected([]);
    setPicking(false);
    searchPending.current = true;
    setSubmittedScenario({
      key: scenarioKey({ ...form, query }, locale),
      query: body.query,
    });
    setSearching(true);
    try {
      const response = await api.recommend(body, controller.signal);
      if (!controller.signal.aborted) {
        setResult(response);
        const stops = response.recommendations.flatMap((recommendation) => {
          const place = response.places.find(
            (p) => p.id === recommendation.place_id,
          );
          return place ? [place] : [];
        });
        setSelected(stops);
        if (stops.length) void buildItinerary(stops, response.request);
        setAnswer("");
        resultHeading.current?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) setResultError(asApiError(error));
    } finally {
      if (!controller.signal.aborted) {
        searchPending.current = false;
        setSearching(false);
      }
    }
  }
  async function buildItinerary(
    stops = selected,
    request?: RecommendationRequest,
  ) {
    invalidatePlan();
    if (!stops.length) return;
    let body: RecommendationRequest;
    try {
      body =
        request ??
        requestFromForm(
          form.query.trim() || mapText(locale, "selectedWalkQuery"),
        );
    } catch {
      setFormError(true);
      document
        .getElementById("planner-form")
        ?.scrollIntoView?.({ block: "start" });
      return;
    }
    const controller = begin("itinerary");
    setPicking(false);
    setBuilding(true);
    try {
      const response = await api.itinerary(
        { ...body, place_ids: stops.map((place) => place.id) },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setItinerary(response);
        if (response.stops.length) showRouteOverview();
        planHeading.current?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) setItineraryError(asApiError(error));
    } finally {
      if (!controller.signal.aborted) setBuilding(false);
    }
  }
  function rebuildSelected(stops: Place[], snapshot = form) {
    // Event-driven recalculation cancels the old request immediately, even when
    // a second edit arrives before React has rendered the previous busy state.
    invalidatePlan();
    if (!stops.length) return;
    let request: RecommendationRequest;
    try {
      request = requestFromForm(
        snapshot.query.trim() || mapText(locale, "selectedWalkQuery"),
        snapshot,
      );
    } catch {
      // Stops can be selected in the catalogue before a starting point exists.
      return;
    }
    void buildItinerary(stops, request);
  }
  function updateStops(stops: Place[]) {
    if (searchPending.current) invalidateSearch();
    setSelected(stops);
    rebuildSelected(stops);
  }
  function showRouteOverview() {
    setMapEnabled(true);
    setOverviewRequest((value) => value + 1);
    document.getElementById("map-heading")?.scrollIntoView?.({
      block: "nearest",
      behavior: "instant",
    });
  }
  function selectStop(place: Place) {
    if (selected.length >= 3 || selected.some((p) => p.id === place.id)) return;
    updateStops([...selected, place]);
  }
  function moveStop(index: number, direction: number) {
    const next = [...selected];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    updateStops(next);
  }
  function saveFavorites(next: Favorite[]) {
    setFavorites(next);
    try {
      if (next.length)
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      else localStorage.removeItem(FAVORITES_KEY);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }
  function toggleFavorite(place: Favorite) {
    saveFavorites(
      favorites.some((p) => p.id === place.id)
        ? favorites.filter((p) => p.id !== place.id)
        : [
            ...favorites,
            {
              id: place.id,
              name: place.name,
              is_synthetic: place.is_synthetic,
            },
          ].slice(-100),
    );
  }
  async function showDetails(id: string) {
    const controller = begin("detail");
    setDetail(null);
    setDetailError(null);
    setDialog("place");
    setActiveId(id);
    try {
      const place = await api.place(id, controller.signal);
      if (!controller.signal.aborted) setDetail(place);
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(asApiError(error));
    }
  }
  const showData = useCallback(async () => {
    const controller = begin("data");
    setData(null);
    setDataError(null);
    try {
      const response = await api.dataStatus(controller.signal);
      if (!controller.signal.aborted) setData(response);
    } catch (error) {
      if (!controller.signal.aborted) setDataError(asApiError(error));
    }
  }, [api, begin]);
  useEffect(() => {
    const controllers = requests.current;
    // Entering the data page loads its live status; abort when navigation leaves it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pathname === "/about") void showData();
    return () => controllers.data?.abort();
  }, [pathname, showData]);
  useEffect(() => {
    requests.current.detail?.abort();
    // A route transition also closes overlays when navigation came from browser Back.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDialog(null);
  }, [pathname]);
  function closeDialog() {
    requests.current.detail?.abort();
    setDialog(null);
  }
  function locate() {
    const version = ++geoVersion.current;
    setGeoState("loading");
    if (!navigator.geolocation) {
      setGeoState("error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (version !== geoVersion.current) return;
        updateForm(
          {
            lat: position.coords.latitude.toFixed(6),
            lon: position.coords.longitude.toFixed(6),
          },
          true,
        );
        setGeoState("idle");
        setPicking(false);
      },
      () => {
        if (version === geoVersion.current) setGeoState("error");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }
  async function feedback(rating: "helpful" | "not_helpful") {
    if (!result) return;
    const controller = begin("feedback");
    setFeedbackState("loading");
    setFeedbackError(null);
    try {
      await api.feedback(
        { request_id: result.request_id, rating, comment: null },
        controller.signal,
      );
      if (!controller.signal.aborted) setFeedbackState("sent");
    } catch (error) {
      if (!controller.signal.aborted) {
        setFeedbackError(asApiError(error));
        setFeedbackState("idle");
      }
    }
  }
  const origin = useMemo(() => {
    const point = { lat: Number(form.lat), lon: Number(form.lon) };
    return form.lat.trim() && form.lon.trim() && valid("Location", point)
      ? point
      : null;
  }, [form.lat, form.lon]);
  const scenarioDirty =
    submittedScenario !== null &&
    submittedScenario.key !== scenarioKey(form, locale);
  const scenarioState = formError
    ? "invalid"
    : searching
      ? "pending"
      : scenarioDirty
        ? "dirty"
        : resultError
          ? "error"
          : result
            ? result.status
            : "draft";
  const scenarioMessage = intentText(
    locale,
    formError
      ? !form.query.trim()
        ? "scenarioNeedsQuery"
        : !origin
          ? "scenarioNeedsOrigin"
          : "scenarioInvalid"
      : searching
        ? "scenarioPending"
        : scenarioDirty
          ? "scenarioDirty"
          : resultError
            ? "scenarioError"
            : result?.status === "no_match"
              ? "scenarioNoMatch"
              : result?.status === "needs_clarification"
                ? "scenarioClarify"
                : result
                  ? "scenarioApplied"
                  : "scenarioDraft",
  );
  const mapPlaces = useMemo(
    () => [
      ...new Map(
        [
          ...catalog,
          ...selected,
          ...(result?.places ?? []),
          ...(itinerary?.places ?? []),
          ...(detail ? [detail] : []),
          ...(view === "party" ? (sharedItinerary?.places ?? []) : []),
        ].map((p) => [p.id, p]),
      ).values(),
    ],
    [catalog, result, itinerary, selected, detail, view, sharedItinerary],
  );
  const selectedIds = useMemo(() => selected.map((p) => p.id), [selected]);
  // A journey has one ordered route. Inspecting a recommendation must never
  // replace it with an independent origin-to-place preview.
  const displayedRoute =
    view === "party"
      ? (sharedItinerary?.route ?? null)
      : (itinerary?.route ?? null);
  const routeStopIds = useMemo(
    () =>
      view === "party"
        ? (sharedItinerary?.stops.map((stop) => stop.place_id) ?? [])
        : selectedIds,
    [view, sharedItinerary, selectedIds],
  );
  function focusPlace(id: string) {
    setActiveId(id);
    setMapEnabled(true);
    (
      document.getElementById(`place-result-${id}`) ??
      document.getElementById(`place-catalog-${id}`)
    )?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }
  const card = (
    place: Place,
    recommendation?: RecommendationResponse["recommendations"][number],
  ) => (
    <PlaceCard
      key={place.id}
      place={place}
      recommendation={recommendation}
      budgetSeconds={
        recommendation ? result?.request.available_seconds : undefined
      }
      locale={locale}
      active={activeId === place.id}
      selected={selectedIds.includes(place.id)}
      full={selected.length >= 3}
      saved={favorites.some((p) => p.id === place.id)}
      onSelect={() => focusPlace(place.id)}
      onDetails={() => void showDetails(place.id)}
      onAdd={() => selectStop(place)}
      onSave={() => toggleFavorite(place)}
    />
  );
  const showFixture = allowFixtures || mode === "fixture";
  const navItems = [
    { href: "/", key: "discover" as const, icon: MapPin },
    { href: "/walk", key: "walk" as const, icon: Footprints },
    { href: "/saved", key: "saved" as const, icon: Bookmark },
    { href: "/party", key: "party" as const, icon: Users },
    { href: "/events", key: "events" as const, icon: CalendarDays },
    { href: "/about", key: "about" as const, icon: Info },
  ];

  const startCard = (
    <section className="start-card" aria-labelledby="start-heading">
      <div className="start-summary">
        <MapPin size={20} aria-hidden="true" />
        <div>
          <h2 id="start-heading">
            {t(locale, view === "events" ? "eventPoint" : "origin")}
          </h2>
          <p>
            {t(
              locale,
              view === "events"
                ? origin
                  ? "eventPointChosen"
                  : "chooseEventPoint"
                : origin
                  ? "startChosen"
                  : "chooseStart",
            )}
          </p>
          {origin && (
            <small>
              {origin.lat.toFixed(5)}, {origin.lon.toFixed(5)}
            </small>
          )}
        </div>
      </div>
      <div className="start-actions">
        <button
          type="button"
          className="secondary"
          aria-pressed={picking}
          onClick={() => {
            setPicking(true);
            setMapEnabled(true);
          }}
        >
          {t(locale, origin ? "changeStart" : "pickMap")}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={locate}
          disabled={geoState === "loading"}
        >
          <LocateFixed size={15} />
          {t(locale, geoState === "loading" ? "locating" : "locate")}
        </button>
      </div>
      {picking && (
        <p className="field-hint" role="status">
          {t(locale, "picking")}
        </p>
      )}
      {geoState === "error" && (
        <p className="small warning-text" role="status">
          {t(locale, "geoDenied")}
        </p>
      )}
      <details className="advanced-origin">
        <summary>{t(locale, "manualOrigin")}</summary>
        <p className="field-hint">{t(locale, "manualOriginHint")}</p>
        <div className="coordinate-grid">
          <label className="field">
            <span>{t(locale, "latitude")}</span>
            <input
              name="latitude"
              type="number"
              inputMode="decimal"
              min="-90"
              max="90"
              step="any"
              placeholder="51.1283"
              value={form.lat}
              onChange={(e) => updateForm({ lat: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t(locale, "longitude")}</span>
            <input
              name="longitude"
              type="number"
              inputMode="decimal"
              min="-180"
              max="180"
              step="any"
              placeholder="71.4305"
              value={form.lon}
              onChange={(e) => updateForm({ lon: e.target.value })}
            />
          </label>
        </div>
        <button
          type="button"
          className="text-button"
          disabled={!origin}
          onClick={() => {
            setPicking(false);
            rebuildSelected(selected);
          }}
        >
          {t(locale, "useEnteredStart")}
        </button>
      </details>
    </section>
  );

  return (
    <SocialPlannerContext.Provider
      value={{
        locale,
        allowFixtures,
        origin,
        beginOriginPick: () => {
          setPicking(true);
          setMapEnabled(true);
        },
        setCommunityEvents,
        setSharedLocations,
        currentRequest: () => {
          try {
            return requestFromForm();
          } catch {
            return null;
          }
        },
        selectedPlaceIds: selectedIds,
        setSharedItinerary,
      }}
    >
      <a className="skip-link" href="#sidebar-content">
        {t(locale, "skip")}
      </a>
      <div className="app-shell">
        <nav className="app-rail" aria-label={t(locale, "navigation")}>
          <Link href="/" className="rail-brand" aria-label="Astana Compass">
            <Compass size={30} />
          </Link>
          {navItems.map(({ href, key, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              scroll={false}
              className="rail-link"
              aria-current={view === key ? "page" : undefined}
              onClick={closeDialog}
            >
              <Icon size={23} aria-hidden="true" />
              <span>{t(locale, key)}</span>
              {key === "walk" && selected.length > 0 && (
                <span className="count">{selected.length}</span>
              )}
            </Link>
          ))}
          <label className="rail-language language-select">
            <Globe2 size={18} />
            <span className="sr-only">{t(locale, "language")}</span>
            <select
              value={locale}
              onChange={(e) => changeLocale(e.target.value as Locale)}
            >
              {locales.map((l) => (
                <option key={l} value={l}>
                  {{ ru: "РУС", kk: "ҚАЗ", en: "ENG" }[l]}
                </option>
              ))}
            </select>
          </label>
        </nav>
        <main className="app-sidebar" id="sidebar-content" tabIndex={-1}>
          <header className="sidebar-header">
            <p className="eyebrow">ASTANA COMPASS</p>
            <h1>{t(locale, view)}</h1>
            <span className="city-pill">Астана · Asia/Almaty</span>
          </header>
          {showFixture && (
            <div className="fixture-banner" role="status">
              <ShieldCheck size={17} />
              {t(locale, "fixtureBanner")}
            </div>
          )}
          <div className="sidebar-content">
            {(view === "discover" || view === "walk" || view === "events") &&
              startCard}
            {children}
            {view === "discover" && (
              <>
                <div className="discovery-intro">
                  <p>{t(locale, "discoveryIntro")}</p>
                  <Link href="/walk" className="primary" scroll={false}>
                    {t(locale, "planWalk")}
                    <ArrowRight size={17} />
                  </Link>
                </div>
                <section className="catalog" aria-labelledby="catalog-heading">
                  <div className="catalog-heading">
                    <h2 id="catalog-heading">{t(locale, "browse")}</h2>
                    <ChevronRight size={22} />
                  </div>
                  <p className="field-hint">{t(locale, "browseHint")}</p>
                  <form
                    className="catalog-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadCatalog(catalogQuery);
                    }}
                  >
                    <label className="sr-only" htmlFor="catalog-query">
                      {t(locale, "catalogSearch")}
                    </label>
                    <input
                      id="catalog-query"
                      value={catalogQuery}
                      maxLength={2000}
                      placeholder={t(locale, "catalogSearch")}
                      aria-describedby="catalog-query-hint"
                      onChange={(e) => {
                        requests.current.catalog?.abort();
                        setCatalogLoading(false);
                        setCursor(null);
                        setCatalogQuery(e.target.value);
                      }}
                    />
                    <button
                      className="secondary"
                      disabled={catalogLoading}
                      type="submit"
                    >
                      {t(locale, "search")}
                    </button>
                  </form>
                  <p className="field-hint" id="catalog-query-hint">
                    {t(locale, "catalogQueryHint")}
                  </p>
                  {!catalogLoading &&
                    catalogQuery.trim() !== loadedQuery.trim() && (
                      <p className="notice amber small" role="status">
                        {t(locale, "catalogPendingQuery")}
                      </p>
                    )}
                  {!catalogLoading && loadedQuery.trim() && (
                    <p className="field-hint">
                      {t(locale, "catalogResultsFor")}: «{loadedQuery}»
                    </p>
                  )}
                  <ErrorNotice
                    error={catalogError}
                    locale={locale}
                    retry={() => void loadCatalog(catalogQuery)}
                  />
                  <div className="catalog-cards">
                    {catalog.map((place) => card(place))}
                  </div>
                  {catalogLoading ? (
                    <p role="status">{t(locale, "catalogLoading")}</p>
                  ) : !catalog.length && !catalogError ? (
                    loadedQuery.trim() ? (
                      <div className="catalog-empty" role="status">
                        <p>{t(locale, "catalogNoMatch")}</p>
                        <p className="field-hint">
                          {t(locale, "catalogNoMatchHint")}
                        </p>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => {
                            setCatalogQuery("");
                            void loadCatalog("");
                          }}
                        >
                          {t(locale, "catalogShowAll")}
                        </button>
                      </div>
                    ) : (
                      <p>{t(locale, "empty")}</p>
                    )
                  ) : null}
                  {cursor && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={catalogLoading}
                      onClick={() => void loadCatalog(loadedQuery, cursor)}
                    >
                      {t(locale, "more")}
                    </button>
                  )}
                </section>
              </>
            )}
            {view === "walk" && (
              <>
                <form
                  id="planner-form"
                  className="planner panel"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void recommend();
                  }}
                >
                  <div className="section-label">
                    <span>01</span>
                    {t(locale, "explore")}
                  </div>
                  <h2>{t(locale, "planPrompt")}</h2>
                  <label className="field">
                    <span>{t(locale, "query")}</span>
                    <textarea
                      name="query"
                      value={form.query}
                      required
                      maxLength={2000}
                      rows={3}
                      placeholder={t(locale, "queryPlaceholder")}
                      aria-describedby="query-hint scenario-keyboard-hint scenario-status"
                      onChange={(e) => updateForm({ query: e.target.value })}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing &&
                          event.keyCode !== 229
                        ) {
                          event.preventDefault();
                          void recommend();
                        }
                      }}
                    />
                  </label>
                  <p id="query-hint" className="field-hint">
                    {t(locale, "queryHint")}
                  </p>
                  <div className={scenarioStyles.action}>
                    <button
                      className="primary"
                      type="submit"
                      disabled={searching}
                    >
                      {searching ? (
                        <span className="spinner" aria-hidden="true" />
                      ) : (
                        <Search size={18} aria-hidden="true" />
                      )}
                      {intentText(
                        locale,
                        searching ? "scenarioFinding" : "scenarioFind",
                      )}
                    </button>
                    <p id="scenario-keyboard-hint" className="field-hint">
                      {intentText(locale, "scenarioKeyboard")}
                    </p>
                  </div>
                  <div
                    id="scenario-status"
                    className={scenarioStyles.status}
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    data-state={scenarioState}
                  >
                    <p>{scenarioMessage}</p>
                    {submittedScenario && !scenarioDirty && !formError && (
                      <p className={scenarioStyles.query}>
                        «{submittedScenario.query}»
                        {result &&
                          ` · ${intentText(locale, "scenarioCount")}: ${result.recommendations.length}`}
                      </p>
                    )}
                    {formError && !origin && form.query.trim() && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setPicking(true);
                          setMapEnabled(true);
                          document
                            .getElementById("start-heading")
                            ?.scrollIntoView?.({ block: "nearest" });
                        }}
                      >
                        {t(locale, "pickMap")}
                      </button>
                    )}
                  </div>
                  <IntentReview
                    query={form.query}
                    locale={locale}
                    onApply={(selection) =>
                      updateForm({
                        constraints: applyIntentConstraints(
                          form.constraints,
                          selection.constraints,
                        ),
                        ...(selection.available_seconds !== null
                          ? {
                              minutes: String(selection.available_seconds / 60),
                            }
                          : {}),
                      })
                    }
                  />
                  <div className="preset-row">
                    {walkPresets.map(
                      ({ label: presetLabel, query, preference }) => (
                        <button
                          className="chip"
                          type="button"
                          key={presetLabel}
                          onClick={() =>
                            updateForm({
                              query: t(locale, query),
                              ...(preference
                                ? {
                                    constraints: {
                                      ...form.constraints,
                                      [preference]:
                                        form.constraints[preference] ||
                                        "preferred",
                                    },
                                  }
                                : {}),
                            })
                          }
                        >
                          <Footprints size={14} aria-hidden="true" />
                          {t(locale, presetLabel)}
                        </button>
                      ),
                    )}
                  </div>
                  <div className="time-grid">
                    <label className="field">
                      <span>{t(locale, "timeBudget")}</span>
                      <input
                        name="minutes"
                        type="number"
                        min="1"
                        max="1440"
                        step="any"
                        required
                        value={form.minutes}
                        onChange={(e) =>
                          updateForm({ minutes: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>{t(locale, "startTime")}</span>
                      <input
                        name="start"
                        type="datetime-local"
                        required
                        value={form.start}
                        onChange={(e) => updateForm({ start: e.target.value })}
                      />
                    </label>
                  </div>
                  <p className="field-hint">{t(locale, "timeBudgetHint")}</p>
                  <label className="return-control">
                    <input
                      type="checkbox"
                      name="return"
                      checked={form.returnToOrigin}
                      onChange={(e) =>
                        updateForm({ returnToOrigin: e.target.checked })
                      }
                    />
                    <RotateCcw size={18} aria-hidden="true" />
                    <span>
                      <strong>{t(locale, "return")}</strong>
                      <small>{t(locale, "returnHint")}</small>
                    </span>
                  </label>
                  <details className="constraint-details" open>
                    <summary>{t(locale, "constraints")}</summary>
                    <p className="field-hint">{t(locale, "constraintsHint")}</p>
                    <div className="constraint-list preference-list">
                      {constraintKeys.map((key) => (
                        <label key={key}>
                          <input
                            type="checkbox"
                            aria-label={t(locale, key)}
                            checked={Boolean(form.constraints[key])}
                            disabled={form.constraints[key] === "required"}
                            onChange={(e) =>
                              updateForm({
                                constraints: {
                                  ...form.constraints,
                                  [key]: e.target.checked ? "preferred" : "",
                                },
                              })
                            }
                          />
                          <span>{t(locale, key)}</span>
                          {form.constraints[key] === "required" && (
                            <small className="required-badge">
                              {t(locale, "required")}
                            </small>
                          )}
                        </label>
                      ))}
                    </div>
                    <details className="strict-constraints">
                      <summary>
                        {t(locale, "strictConstraints")}
                        {Object.values(form.constraints).some(
                          (strength) => strength === "required",
                        ) && (
                          <strong className="required-count">
                            {" "}
                            ·{" "}
                            {
                              Object.values(form.constraints).filter(
                                (strength) => strength === "required",
                              ).length
                            }
                          </strong>
                        )}
                      </summary>
                      <p className="field-hint">
                        {t(locale, "strictConstraintsHint")}
                      </p>
                      <div className="constraint-list">
                        {constraintKeys.map((key) => (
                          <label key={key}>
                            <span>{t(locale, key)}</span>
                            <select
                              aria-label={t(locale, key)}
                              value={form.constraints[key] ?? ""}
                              onChange={(e) =>
                                updateForm({
                                  constraints: {
                                    ...form.constraints,
                                    [key]: e.target.value as
                                      Constraint["strength"] | "",
                                  },
                                })
                              }
                            >
                              <option value="">
                                {t(locale, "indifferent")}
                              </option>
                              <option value="preferred">
                                {t(locale, "preferred")}
                              </option>
                              <option value="required">
                                {t(locale, "required")}
                              </option>
                            </select>
                          </label>
                        ))}
                      </div>
                    </details>
                  </details>
                  {formError && (
                    <p className="notice error" role="alert">
                      {t(locale, "invalidForm")}
                    </p>
                  )}
                  <button
                    className="primary find-button"
                    type="submit"
                    disabled={searching}
                  >
                    <Sparkles size={18} />
                    {t(locale, searching ? "finding" : "find")}
                    <ArrowRight size={18} />
                  </button>
                  <p className="privacy-note">{t(locale, "privacy")}</p>
                </form>

                <section
                  className="results"
                  aria-labelledby="results-heading"
                  aria-busy={searching}
                >
                  <div className="results-heading">
                    <div>
                      <div className="section-label">
                        <span>02</span>
                        {t(locale, "recommendations")}
                      </div>
                      <h2
                        id="results-heading"
                        ref={resultHeading}
                        tabIndex={-1}
                      >
                        {t(locale, "recommendations")}
                      </h2>
                    </div>
                    {result && (
                      <span className="result-count">
                        {result.recommendations.length
                          .toString()
                          .padStart(2, "0")}
                      </span>
                    )}
                  </div>
                  <ErrorNotice
                    error={resultError}
                    locale={locale}
                    retry={() => void recommend()}
                  />
                  {searching && (
                    <div className="loading-state" role="status">
                      <span className="spinner" />
                      {t(locale, "finding")}
                    </div>
                  )}
                  {!result && !searching && !resultError && (
                    <div className="empty-results">
                      <div className="empty-icon">
                        <Compass size={32} strokeWidth={1.3} />
                      </div>
                      <h3>{t(locale, "readyTitle")}</h3>
                      <p>{t(locale, "readyText")}</p>
                      <span className="empty-decoration" aria-hidden="true">
                        ↗
                      </span>
                    </div>
                  )}
                  {result && (
                    <>
                      {(result.status === "matched" ||
                        result.status === "partial") && (
                        <>
                          <p className="result-status" role="status">
                            <ShieldCheck size={17} />
                            {t(locale, result.status)}
                          </p>
                          <p className="field-hint alternatives">
                            {t(locale, "alternatives")}
                          </p>
                          {building && (
                            <p className="loading-state" role="status">
                              <span className="spinner" />
                              {mapText(locale, "connectingStops")}
                            </p>
                          )}
                          {itinerary?.route?.geometry && (
                            <p className="result-status" role="status">
                              <Footprints size={18} aria-hidden="true" />
                              {mapText(locale, "connectedStops").replace(
                                "{count}",
                                String(itinerary.stops.length),
                              )}
                            </p>
                          )}
                          {itineraryError && (
                            <p className="notice amber" role="status">
                              {mapText(locale, "connectionFailed")}
                            </p>
                          )}
                          {itinerary?.route && !itinerary.route.geometry && (
                            <p className="notice amber" role="status">
                              {t(locale, "approximateHint")}
                            </p>
                          )}
                          {result.recommendations.length < 3 && (
                            <p className="field-hint">
                              {mapText(locale, "fewerStops")}
                            </p>
                          )}
                        </>
                      )}
                      {result.status === "no_match" && (
                        <div className="empty-results" role="status">
                          <h3>{t(locale, "noMatch")}</h3>
                          <p>{t(locale, "noMatchHint")}</p>
                        </div>
                      )}
                      {result.status === "needs_clarification" && (
                        <form
                          className="clarification panel"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const query = `${form.query}\n${answer}`;
                            setForm((previous) => ({ ...previous, query }));
                            void recommend(query);
                          }}
                        >
                          <h3>{t(locale, "clarify")}</h3>
                          {result.clarification_questions.map((q) => (
                            <p key={q}>{q}</p>
                          ))}
                          <label className="field">
                            <span>{t(locale, "answer")}</span>
                            <input
                              required
                              maxLength={Math.max(0, 1999 - form.query.length)}
                              value={answer}
                              onChange={(e) => setAnswer(e.target.value)}
                            />
                          </label>
                          <button className="primary" type="submit">
                            {t(locale, "sendAnswer")}
                            <ArrowRight size={16} />
                          </button>
                        </form>
                      )}
                      <div className="result-cards">
                        {result.recommendations.map((recommendation) => {
                          const place = result.places.find(
                            (p) => p.id === recommendation.place_id,
                          );
                          return place && card(place, recommendation);
                        })}
                      </div>
                      <Warnings
                        warnings={result.warnings}
                        locale={locale}
                        expanded={result.status === "no_match"}
                      />
                      <div className="feedback">
                        <p>
                          {feedbackState === "sent"
                            ? t(locale, "thanks")
                            : t(locale, "feedback")}
                        </p>
                        {feedbackState !== "sent" && (
                          <div>
                            <button
                              type="button"
                              className="chip"
                              disabled={feedbackState === "loading"}
                              onClick={() => void feedback("helpful")}
                            >
                              {t(locale, "helpful")}
                            </button>
                            <button
                              type="button"
                              className="chip"
                              disabled={feedbackState === "loading"}
                              onClick={() => void feedback("not_helpful")}
                            >
                              {t(locale, "notHelpful")}
                            </button>
                          </div>
                        )}
                        <small>{t(locale, "feedbackHint")}</small>
                        <ErrorNotice error={feedbackError} locale={locale} />
                      </div>
                    </>
                  )}
                </section>

                <section
                  className="journey panel"
                  aria-labelledby="plan-heading"
                >
                  <div className="section-label">
                    <span>03</span>
                    {t(locale, "walking")}
                  </div>
                  <h2 id="plan-heading" ref={planHeading} tabIndex={-1}>
                    {t(locale, "plan")}
                    <span className="count">{selected.length}/3</span>
                  </h2>
                  <p className="field-hint">{t(locale, "planHint")}</p>
                  {selected.length === 0 ? (
                    <div className="empty-plan">
                      <Plus size={20} />
                      <p>{t(locale, "emptyPlan")}</p>
                    </div>
                  ) : (
                    <>
                      <ol
                        className="selected-stops"
                        data-testid="selected-stops"
                      >
                        {selected.map((place, index) => (
                          <li key={place.id}>
                            <span className="stop-number">{index + 1}</span>
                            <strong>{place.name}</strong>
                            <div className="stop-actions">
                              <button
                                type="button"
                                className="icon-button"
                                disabled={index === 0}
                                aria-label={`${t(locale, "moveUp")}: ${place.name}`}
                                onClick={() => moveStop(index, -1)}
                              >
                                <ArrowUp size={16} />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                disabled={index === selected.length - 1}
                                aria-label={`${t(locale, "moveDown")}: ${place.name}`}
                                onClick={() => moveStop(index, 1)}
                              >
                                <ArrowDown size={16} />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`${t(locale, "remove")}: ${place.name}`}
                                onClick={() => {
                                  updateStops(
                                    selected.filter((p) => p.id !== place.id),
                                  );
                                }}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <p className="return-summary">
                        <RotateCcw size={15} />
                        {t(
                          locale,
                          form.returnToOrigin ? "withReturn" : "oneWay",
                        )}
                      </p>
                      {building ? (
                        <p className="loading-state" role="status">
                          <span className="spinner" />
                          {mapText(locale, "connectingStops")}
                        </p>
                      ) : !itinerary?.route?.geometry ? (
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void buildItinerary()}
                        >
                          {t(locale, "buildPlan")}
                          <ArrowRight size={17} />
                        </button>
                      ) : null}
                      {!itinerary && !building && (
                        <p className="field-hint">
                          {origin
                            ? t(locale, "needsRebuild")
                            : mapText(locale, "journeyNeedsOrigin")}
                        </p>
                      )}
                    </>
                  )}
                  <ErrorNotice error={itineraryError} locale={locale} />
                  {itinerary && (
                    <div className="itinerary-result" aria-live="polite">
                      {itinerary.status === "no_match" ||
                      itinerary.status === "needs_clarification" ? (
                        <>
                          <h3>
                            {t(
                              locale,
                              itinerary.status === "no_match"
                                ? "noMatch"
                                : "clarify",
                            )}
                          </h3>
                          <p>{t(locale, "keptSelection")}</p>
                          {itinerary.clarification_questions.map((q) => (
                            <p key={q}>{q}</p>
                          ))}
                        </>
                      ) : (
                        <>
                          <p className="result-status" role="status">
                            <ShieldCheck size={17} />
                            {t(
                              locale,
                              itinerary.status === "partial"
                                ? "partial"
                                : "matched",
                            )}
                          </p>
                          <div className="journey-total">
                            <span>{t(locale, "total")}</span>
                            <strong>
                              {duration(
                                itinerary.total_duration_seconds,
                                locale,
                              )}
                            </strong>
                          </div>
                          <TimeBudgetNote
                            totalSeconds={itinerary.total_duration_seconds}
                            budgetSeconds={itinerary.request.available_seconds}
                            locale={locale}
                          />
                          <button
                            type="button"
                            className="secondary"
                            onClick={showRouteOverview}
                          >
                            <MapPin size={18} aria-hidden="true" />
                            {mapText(locale, "overview")}
                          </button>
                          <p className="field-hint">
                            {mapText(locale, "routePersists")}
                          </p>
                          <p>
                            {t(
                              locale,
                              itinerary.request.return_to_origin
                                ? "withReturn"
                                : "oneWay",
                            )}
                          </p>
                          <ol className="itinerary-visits">
                            {itinerary.stops.map((stop, index) => {
                              const place = itinerary.places.find(
                                (p) => p.id === stop.place_id,
                              );
                              const description =
                                place && sourceDescription(place, locale);
                              const compromises =
                                stop.constraint_evaluations.filter(
                                  (evaluation) =>
                                    evaluation.strength === "preferred" &&
                                    evaluation.outcome !== "satisfied",
                                );
                              return (
                                <li key={stop.place_id}>
                                  <small>{stopTitle(locale, index)}</small>
                                  <b>{place?.name}</b>
                                  {description && <p>{description.text}</p>}
                                  <span>
                                    {t(locale, "visit")}{" "}
                                    {duration(
                                      stop.visit_duration_seconds,
                                      locale,
                                    )}
                                  </span>
                                  <p>
                                    <small>{t(locale, "suggestion")}</small>
                                    {stop.suggested_activity}
                                  </p>
                                  {compromises.map((evaluation) => (
                                    <div
                                      className="evaluation"
                                      key={evaluation.key}
                                    >
                                      <strong>
                                        {label(locale, evaluation.key)}
                                      </strong>
                                      <span>
                                        {t(locale, evaluation.strength)} ·{" "}
                                        {t(locale, evaluation.outcome)}
                                      </span>
                                      <p>{evaluation.explanation}</p>
                                    </div>
                                  ))}
                                  {place && (
                                    <button
                                      type="button"
                                      className="text-button"
                                      onClick={() =>
                                        void showDetails(stop.place_id)
                                      }
                                    >
                                      {t(locale, "details")}
                                    </button>
                                  )}
                                </li>
                              );
                            })}
                          </ol>
                          {itinerary.route && (
                            <>
                              <p>
                                {t(locale, "travel")}:{" "}
                                {duration(
                                  itinerary.route.duration_seconds,
                                  locale,
                                )}
                              </p>
                              {(itinerary.route.method === "approximate" ||
                                !itinerary.route.geometry) && (
                                <p className="notice amber">
                                  {t(locale, "approximateHint")}
                                </p>
                              )}
                              <RouteNotes
                                route={itinerary.route}
                                locale={locale}
                              />
                            </>
                          )}
                        </>
                      )}
                      <Warnings warnings={itinerary.warnings} locale={locale} />
                    </div>
                  )}
                </section>

                <Link href="/" className="text-button">
                  {t(locale, "browse")}
                </Link>
              </>
            )}
            {view === "saved" && (
              <section className="saved-page">
                <>
                  <p>{t(locale, "savedHint")}</p>
                  {storageError && (
                    <p className="notice amber" role="status">
                      {t(locale, "storageError")}
                    </p>
                  )}
                  {favorites.length === 0 ? (
                    <p>{t(locale, "empty")}</p>
                  ) : (
                    <>
                      <ul className="favorites">
                        {favorites.map((place) => (
                          <li key={place.id}>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => void showDetails(place.id)}
                            >
                              {place.name}
                              <ArrowRight size={16} />
                            </button>
                            {place.is_synthetic && (
                              <span className="badge amber">
                                {t(locale, "synthetic")}
                              </span>
                            )}
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => toggleFavorite(place)}
                              aria-label={`${t(locale, "unsave")}: ${place.name}`}
                            >
                              <Trash2 size={17} />
                            </button>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => saveFavorites([])}
                      >
                        {t(locale, "clearSaved")}
                      </button>
                    </>
                  )}
                </>
              </section>
            )}
            {view === "about" && (
              <section className="about-page">
                <div className="privacy-panel">
                  <h2>{t(locale, "privacyTitle")}</h2>
                  <p>{t(locale, "privacyDetail")}</p>
                  <p>{t(locale, "mapDataNotice")}</p>
                </div>
                <>
                  <ErrorNotice
                    error={dataError}
                    locale={locale}
                    retry={() => void showData()}
                  />
                  {!data && !dataError && (
                    <p role="status">{t(locale, "loading")}</p>
                  )}
                  {data && (
                    <>
                      {showFixture && (
                        <p className="notice amber">
                          {t(locale, "fixtureBanner")}
                        </p>
                      )}
                      <div className="data-total">
                        <strong>{data.total_places}</strong>
                        <span>{t(locale, "placesCount")}</span>
                      </div>
                      <p className="small">
                        {t(locale, "checked")}:{" "}
                        {dateTime(data.checked_at, locale)}
                      </p>
                      <p className="field-hint">{t(locale, "freshness")}</p>
                      {data.sources.some((source) =>
                        isOsmSourceUrl(source.source_url),
                      ) && <OsmAttribution locale={locale} />}
                      {!data.sources.length && <p>{t(locale, "noSources")}</p>}
                      {data.sources.map((source, index) => (
                        <article
                          className="source-status"
                          key={`${source.source_name}-${index}`}
                        >
                          <h3>
                            {safeUrl(source.source_url) ? (
                              <a
                                href={safeUrl(source.source_url)}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                {source.source_name}
                              </a>
                            ) : (
                              source.source_name
                            )}
                          </h3>
                          <span className="badge">
                            {t(locale, source.status)}
                          </span>
                          <p>
                            {t(locale, "placesCount")}: {source.place_count}
                          </p>
                          {source.last_success_at && (
                            <p className="small">
                              {t(locale, "retrieved")}:{" "}
                              {dateTime(source.last_success_at, locale)}
                            </p>
                          )}
                          <Warnings
                            warnings={source.warnings}
                            locale={locale}
                          />
                        </article>
                      ))}
                    </>
                  )}
                </>
              </section>
            )}
            {view !== "walk" && selected.length > 0 && (
              <Link
                href="/walk"
                className="selection-shortcut primary"
                scroll={false}
              >
                <Footprints size={18} />
                {t(locale, "plan")} · {selected.length}/3
                <ArrowRight size={18} />
              </Link>
            )}
          </div>
        </main>
        <div className="app-map-stage">
          <CityMap
            places={mapPlaces}
            communityEvents={communityEvents}
            sharedLocations={view === "party" ? sharedLocations : []}
            origin={
              view === "party"
                ? (sharedItinerary?.request.origin ?? origin)
                : origin
            }
            activeId={activeId}
            selectedIds={
              view === "party"
                ? (sharedItinerary?.stops.map((stop) => stop.place_id) ?? [])
                : selectedIds
            }
            route={displayedRoute}
            routeStopIds={routeStopIds}
            overviewRequest={overviewRequest}
            locale={locale}
            picking={
              picking &&
              (view === "discover" || view === "walk" || view === "events")
            }
            enabled={mapEnabled}
            provider={mapProvider}
            onEnable={() => setMapEnabled(true)}
            onPick={(point) => {
              updateForm(
                { lat: String(point.lat), lon: String(point.lon) },
                true,
              );
              setPicking(false);
            }}
            onSelect={focusPlace}
            onDetails={(id) => void showDetails(id)}
          />
        </div>
      </div>
      {dialog === "place" && (
        <Dialog
          title={detail?.name ?? t(locale, "details")}
          locale={locale}
          close={closeDialog}
        >
          <>
            <ErrorNotice error={detailError} locale={locale} />
            {!detail && !detailError && (
              <p role="status">{t(locale, "loading")}</p>
            )}
            {detail && (
              <>
                {detail.is_synthetic && (
                  <p className="notice amber">{t(locale, "fixtureBanner")}</p>
                )}
                <PlaceFacts place={detail} locale={locale} />
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      selected.length >= 3 || selectedIds.includes(detail.id)
                    }
                    onClick={() => selectStop(detail)}
                  >
                    {t(
                      locale,
                      selectedIds.includes(detail.id) ? "added" : "add",
                    )}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => toggleFavorite(detail)}
                  >
                    {t(
                      locale,
                      favorites.some((p) => p.id === detail.id)
                        ? "unsave"
                        : "save",
                    )}
                  </button>
                </div>
              </>
            )}
          </>
        </Dialog>
      )}
    </SocialPlannerContext.Provider>
  );
}
