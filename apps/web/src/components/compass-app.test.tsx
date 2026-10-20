import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  IntentResponse,
  ItineraryRequest,
  ItineraryResponse,
  Place,
  RecommendationRequest,
  RecommendationResponse,
} from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import CompassApp from "./compass-app";
import { locales, t } from "@/lib/i18n";
import { intentText } from "@/lib/intent-copy";
import { mapText } from "@/lib/map-copy";
import { useSharedPlanner } from "@/lib/shared-planner";
import { walkText } from "@/lib/walk-copy";
import { LOCATION_TIMEOUT_MS } from "@/lib/geolocation";

const navigation = vi.hoisted(() => ({ pathname: "/walk" }));
const intentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intent")>()),
  interpretIntent: intentMock,
}));
beforeEach(() => {
  intentMock
    .mockReset()
    .mockRejectedValue(new Error("Interpretation unavailable in this test"));
});
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
// Exercise the planner/map boundary without a WebGL renderer in jsdom.
vi.mock("next/dynamic", () => ({
  default: () =>
    function MapStub(props: {
      enabled: boolean;
      provider: string;
      picking: boolean;
      selectedIds: string[];
      routeStopIds: string[];
      overviewRequest: number;
      locationFoundRequest: number;
      places: Place[];
      origin: { lat: number; lon: number } | null;
      route: unknown;
      onPick: (point: { lat: number; lon: number }) => void;
      onSelect: (id: string) => void;
      onLocationFound: () => void;
    }) {
      return (
        <div
          data-testid="map"
          data-enabled={props.enabled}
          data-provider={props.provider}
          data-picking={props.picking}
          data-selected={props.selectedIds.join(",")}
          data-origin={JSON.stringify(props.origin)}
          data-route={JSON.stringify(props.route)}
          data-stops={props.routeStopIds.join(",")}
          data-overview={props.overviewRequest}
          data-location-found={props.locationFoundRequest}
        >
          <button type="button" onClick={props.onLocationFound}>
            Map location found
          </button>
          <button
            type="button"
            onClick={() => props.onPick({ lat: 51.09, lon: 71.42 })}
          >
            Map pick
          </button>
          {props.places.map((place) => (
            <button
              key={place.id}
              type="button"
              onClick={() => props.onSelect(place.id)}
            >
              Map select {place.id}
            </button>
          ))}
        </div>
      );
    },
}));
const dialogMethods = ["showModal", "close"] as const;
const originalDialogMethods = dialogMethods.map((name) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
);
afterEach(() => {
  cleanup();
  navigation.pathname = "/walk";
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dialogMethods.forEach((name, index) => {
    const descriptor = originalDialogMethods[index];
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
});

function scenarioResponse(
  request: RecommendationRequest,
  status: "matched" | "no_match" = "no_match",
): RecommendationResponse {
  const seed = structuredClone(
    examples.cases.find(
      (entry) =>
        entry.name ===
        (status === "matched" ? "recommendations_valid" : "no_match_valid"),
    )!.instance,
  ) as RecommendationResponse;
  return {
    ...seed,
    status,
    request,
    recommendations: seed.recommendations.map((recommendation) => ({
      ...recommendation,
      constraint_evaluations: [],
      route: {
        ...recommendation.route,
        includes_return: request.return_to_origin,
      },
    })),
  };
}

it.each([false, true])(
  "mobile planner collapses only after a successful itinerary, preserves edits (failure=%s)",
  async (failure) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-width"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const seed = structuredClone(
      examples.cases.find((entry) => entry.name === "itinerary_valid")!
        .instance,
    ) as ItineraryResponse;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/v1/places?"))
          return Response.json({ places: seed.places, next_cursor: null });
        const body = JSON.parse(String(init?.body));
        if (url.endsWith("/recommendations"))
          return Response.json(scenarioResponse(body, "matched"));
        if (failure) throw new TypeError("Itinerary unavailable");
        return Response.json(orderedJourneyResponse(body, seed.places));
      }),
    );
    const user = userEvent.setup();
    const { container } = render(
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />,
    );
    const shell = container.querySelector(".app-shell")!;
    expect(shell).toHaveAttribute("data-sheet-snap", "collapsed");
    expect(container.querySelector("#mobile-sheet-content")).toHaveAttribute(
      "inert",
    );
    await user.click(
      screen.getByRole("link", { name: "Открыть планирование" }),
    );
    expect(shell).toHaveAttribute("data-sheet-snap", "expanded");
    await user.click(screen.getByRole("button", { name: "Map pick" }));
    const wish = screen.getByRole("textbox", { name: t("ru", "query") });
    await user.type(wish, "Музей и кофе");
    await user.click(screen.getByRole("button", { name: "Фильтры" }));
    await user.type(
      screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
      "180",
    );
    await user.click(
      screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
    );
    if (failure) {
      await waitFor(() =>
        expect(
          container.querySelector(".itinerary-error") ??
            screen.queryByRole("alert"),
        ).not.toBeNull(),
      );
      expect(shell).toHaveAttribute("data-sheet-snap", "expanded");
    } else {
      await waitFor(() =>
        expect(shell).toHaveAttribute("data-sheet-snap", "collapsed"),
      );
      await waitFor(() =>
        expect(container.querySelector("[data-sheet-handle]")).toHaveFocus(),
      );
      expect(
        Number(screen.getByTestId("map").getAttribute("data-overview")),
      ).toBeGreaterThan(0);
      const route = screen.getByTestId("map").getAttribute("data-route");
      await user.click(
        screen.getByRole("link", { name: "Открыть планирование" }),
      );
      expect(screen.getByTestId("map")).toHaveAttribute("data-route", route!);
    }
    expect(wish).toHaveValue("Музей и кофе");
    expect(
      screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
    ).toHaveValue(180);
    expect(screen.getByTestId("map")).toHaveAttribute(
      "data-origin",
      JSON.stringify({ lat: 51.09, lon: 71.42 }),
    );
    expect(screen.getByTestId("map").getAttribute("data-selected")).not.toBe(
      "",
    );
  },
);

it.each(locales)(
  "geolocation denial in %s clears when the map finds a fix and preserves manual start",
  async (locale) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ places: [], next_cursor: null })),
    );
    const getCurrentPosition = vi.fn(
      (_ok: PositionCallback, fail: PositionErrorCallback) =>
        fail({ code: 1 } as GeolocationPositionError),
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    const user = userEvent.setup();
    const { container } = render(
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />,
    );
    await user.click(screen.getByText(t("ru", "manualOrigin")));
    await user.type(
      screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
      "51.09",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: t("ru", "longitude") }),
      "71.42",
    );
    if (locale !== "ru")
      await user.selectOptions(
        screen.getByRole("combobox", { name: t("ru", "language") }),
        locale,
      );
    await user.click(screen.getByRole("button", { name: t(locale, "locate") }));
    expect(screen.getByText(t(locale, "geoPermissionDenied"))).toBeVisible();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "Map location found" }),
    );
    expect(container.querySelector(".start-card .warning-text")).toBeNull();
    expect(
      screen.getByRole("spinbutton", { name: t(locale, "latitude") }),
    ).toHaveValue(51.09);
    expect(
      screen.getByRole("spinbutton", { name: t(locale, "longitude") }),
    ).toHaveValue(71.42);
  },
);

it("geolocation success clears an earlier denial and ignores callbacks after a manual edit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ places: [], next_cursor: null })),
  );
  const attempts: Array<{ ok: PositionCallback; fail: PositionErrorCallback }> =
    [];
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: vi.fn((ok, fail) => attempts.push({ ok, fail })),
    },
  });
  const user = userEvent.setup();
  const { container } = render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: t("ru", "locate") }));
  act(() => attempts[0].fail({ code: 1 } as GeolocationPositionError));
  expect(screen.getByText(t("ru", "geoPermissionDenied"))).toBeVisible();
  await user.click(screen.getByRole("button", { name: t("ru", "locate") }));
  expect(container.querySelector(".start-card .warning-text")).toBeNull();
  act(() =>
    attempts[1].ok({
      coords: { latitude: 51.123456, longitude: 71.456789 },
    } as GeolocationPosition),
  );
  expect(screen.getByTestId("map")).toHaveAttribute("data-location-found", "1");
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify({ lat: 51.123456, lon: 71.456789 }),
  );
  await user.click(screen.getByRole("button", { name: t("ru", "locate") }));
  await user.click(screen.getByText(t("ru", "manualOrigin")));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
    { target: { value: "51.095" } },
  );
  act(() =>
    attempts[2].ok({
      coords: { latitude: 52, longitude: 72 },
    } as GeolocationPosition),
  );
  act(() => attempts[2].fail({ code: 1 } as GeolocationPositionError));
  expect(
    screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
  ).toHaveValue(51.095);
  expect(container.querySelector(".start-card .warning-text")).toBeNull();
});

it("a map fix suppresses later temporary planner errors without replacing a manual start", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ places: [], next_cursor: null })),
  );
  const attempts: Array<{ ok: PositionCallback; fail: PositionErrorCallback }> =
    [];
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: vi.fn((ok, fail) => attempts.push({ ok, fail })),
    },
  });
  const user = userEvent.setup();
  const { container } = render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByText(t("ru", "manualOrigin")));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
    { target: { value: "51.095" } },
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: t("ru", "longitude") }),
    { target: { value: "71.42" } },
  );
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: t("ru", "locate") }));
    act(() => attempts[0].fail({ code: 2 } as GeolocationPositionError));
    act(() => vi.advanceTimersByTime(800));
    expect(attempts).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: t("ru", "locating") }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Map location found" }));
    expect(
      screen.getByRole("button", { name: t("ru", "locate") }),
    ).toBeEnabled();
    act(() => {
      attempts[1].fail({ code: 2 } as GeolocationPositionError);
      vi.advanceTimersByTime(LOCATION_TIMEOUT_MS);
      attempts[1].ok({
        coords: { latitude: 52, longitude: 72 },
      } as GeolocationPosition);
      attempts[1].fail({ code: 1 } as GeolocationPositionError);
    });
    expect(attempts).toHaveLength(3);
    expect(container.querySelector(".start-card .warning-text")).toBeNull();
    expect(
      screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
    ).toHaveValue(51.095);
    expect(
      screen.getByRole("spinbutton", { name: t("ru", "longitude") }),
    ).toHaveValue(71.42);
    expect(screen.getByTestId("map")).toHaveAttribute(
      "data-origin",
      JSON.stringify({ lat: 51.095, lon: 71.42 }),
    );
    // A later user request still reports its own real permission denial.
    fireEvent.click(screen.getByRole("button", { name: t("ru", "locate") }));
    fireEvent.click(screen.getByRole("button", { name: "Map location found" }));
    act(() => attempts[3].fail({ code: 1 } as GeolocationPositionError));
    expect(screen.getByText(t("ru", "geoPermissionDenied"))).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

it("ordinary map fixes preserve the manual start while a pending planner fix can still apply requested GPS coordinates", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ places: [], next_cursor: null })),
  );
  let accept!: PositionCallback;
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: vi.fn((ok) => {
        accept = ok;
      }),
    },
  });
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.click(screen.getByRole("button", { name: "Map location found" }));
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify({ lat: 51.09, lon: 71.42 }),
  );
  await user.click(screen.getByRole("button", { name: t("ru", "locate") }));
  await user.click(screen.getByRole("button", { name: "Map location found" }));
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify({ lat: 51.09, lon: 71.42 }),
  );
  act(() =>
    accept({
      coords: { latitude: 51.123456, longitude: 71.456789 },
    } as GeolocationPosition),
  );
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify({ lat: 51.123456, lon: 71.456789 }),
  );
  expect(screen.getByTestId("map")).toHaveAttribute("data-location-found", "1");
  expect(screen.getByRole("button", { name: t("ru", "locate") })).toBeEnabled();
});

it("automatically connects all three recommendations and keeps the whole path while browsing", async () => {
  const seed = structuredClone(
    examples.cases.find((entry) => entry.name === "itinerary_valid")!.instance,
  ) as ItineraryResponse;
  const places = [1, 2, 3, 4].map((number) => ({
    ...structuredClone(seed.places[0]),
    id: `synthetic:place:route-${number}`,
    name: `SYNTHETIC route place ${number}`,
    description: `Source description for stop ${number}`,
  }));
  const submitted: ItineraryRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Response.json({ places, next_cursor: null });
      const request = JSON.parse(String(init?.body));
      if (url.endsWith("/recommendations")) {
        const response = scenarioResponse(request, "matched");
        return Response.json({
          ...response,
          places: places.slice(0, 3),
          recommendations: places.slice(0, 3).map((place, index) => ({
            ...response.recommendations[0],
            place_id: place.id,
            rank: index + 1,
          })),
        });
      }
      submitted.push(request);
      return Response.json(orderedJourneyResponse(request, places));
    }),
  );
  const user = userEvent.setup();
  const { container } = render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByText(t("ru", "manualOrigin")));
  await user.type(
    screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
    "51.09",
  );
  await user.type(
    screen.getByRole("spinbutton", { name: t("ru", "longitude") }),
    "71.42",
  );
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    "Красивые места",
  );
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
  );
  const map = screen.getByTestId("map");
  expect(map).toHaveAttribute("data-picking", "false");
  await waitFor(() =>
    expect(container.querySelectorAll(".itinerary-visits > li")).toHaveLength(
      3,
    ),
  );
  expect(submitted).toHaveLength(1);
  expect(submitted[0].place_ids).toEqual(
    places.slice(0, 3).map((place) => place.id),
  );
  expect(map).toHaveAttribute("data-stops", submitted[0].place_ids.join(","));
  expect(map).toHaveAttribute("data-picking", "false");
  const fullRoute = map.getAttribute("data-route");
  for (const [index, stop] of Array.from(
    container.querySelectorAll<HTMLElement>(".itinerary-visits > li"),
  ).entries()) {
    expect(
      within(stop).getByText(`Source description for stop ${index + 1}`),
    ).toBeVisible();
    expect(
      within(stop).getByRole("button", { name: t("ru", "details") }),
    ).toBeVisible();
  }
  await user.click(
    screen.getByRole("button", { name: `Map select ${places[3].id}` }),
  );
  expect(map).toHaveAttribute("data-route", fullRoute);
  const overview = Number(map.getAttribute("data-overview"));
  const visiblePlan = container.querySelector<HTMLElement>(".journey-preview")!;
  await user.click(
    within(visiblePlan).getByRole("button", {
      name: walkText("ru", "viewRoute"),
    }),
  );
  expect(map).toHaveAttribute("data-overview", String(overview + 1));
  expect(visiblePlan).toBeVisible();
  await user.click(
    within(visiblePlan).getByRole("button", {
      name: `${walkText("ru", "remove")}: ${places[1].name}`,
    }),
  );
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[1].place_ids).toEqual([places[0].id, places[2].id]);
  await waitFor(() =>
    expect(map).toHaveAttribute(
      "data-stops",
      [places[0].id, places[2].id].join(","),
    ),
  );
});

function orderedJourneyResponse(
  request: ItineraryRequest,
  places: Place[],
): ItineraryResponse {
  const seed = structuredClone(
    examples.cases.find((entry) => entry.name === "itinerary_valid")!.instance,
  ) as ItineraryResponse;
  const ordered = request.place_ids.map((id) =>
    places.find((place) => place.id === id)!,
  );
  return {
    ...seed,
    request,
    places: ordered,
    route: { ...seed.route!, includes_return: request.return_to_origin },
    stops: ordered.map((place, index) => ({
      ...seed.stops[0],
      order: index + 1,
      place_id: place.id,
      visit_duration_seconds: 60,
      constraint_evaluations: [],
    })),
    total_duration_seconds: seed.route!.duration_seconds + ordered.length * 60,
  };
}

function journeyPlaces() {
  const seed = examples.cases.find((entry) => entry.name === "itinerary_valid")!
    .instance as ItineraryResponse;
  return ["Coffee", "Park", "Museum"].map((name, index) => ({
    ...structuredClone(seed.places[0]),
    id: `synthetic:place:journey-${index}`,
    name: `SYNTHETIC ${name}`,
  }));
}

it("starts without active filters, a time target or a return journey", async () => {
  const requests: RecommendationRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Response.json({ places: [], next_cursor: null });
      const request = JSON.parse(String(init?.body)) as RecommendationRequest;
      requests.push(request);
      return Response.json(scenarioResponse(request));
    }),
  );
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  expect(screen.getByText(walkText("ru", "noFilters"))).toBeVisible();
  expect(
    screen.queryByRole("spinbutton", { name: t("ru", "timeBudget") }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  ).toHaveAttribute("aria-expanded", "false");
  await user.click(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  );
  const filters = screen.getByRole("region", {
    name: walkText("ru", "filters"),
  });
  expect(
    within(filters).getByRole("spinbutton", { name: t("ru", "timeBudget") }),
  ).toHaveValue(null);
  expect(
    within(filters).getByRole("checkbox", {
      name: new RegExp(t("ru", "return")),
    }),
  ).not.toBeChecked();
  for (const checkbox of within(filters).getAllByRole("checkbox"))
    expect(checkbox).not.toBeChecked();
  await user.click(
    within(filters).getByRole("button", { name: walkText("ru", "done") }),
  );
  expect(filters).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    "Парки{Enter}",
  );
  await screen.findByText(intentText("ru", "scenarioNoMatch"));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    available_seconds: 86400,
    return_to_origin: false,
    constraints: [],
  });
});

it("automatically interprets two hours and preferences without rewriting manual filters or weakening must-haves", async () => {
  const { interpretIntent } =
    await vi.importActual<typeof import("@/lib/intent")>("@/lib/intent");
  intentMock.mockImplementation(interpretIntent);
  const query = "Хочу погулять два часа, в помещении с Wi-Fi";
  const intent: IntentResponse = {
    provider: "rules",
    locale: "ru",
    available_seconds: 7200,
    time_evidence: "два часа",
    anchor_text: null,
    categories: ["cafe"],
    constraints: [
      {
        constraint: { key: "indoor", value: true, strength: "preferred" },
        source_quote: "в помещении",
      },
      {
        constraint: { key: "has_wifi", value: true, strength: "required" },
        source_quote: "Wi-Fi",
      },
    ],
    clarification_questions: [],
    warnings: [],
  };
  const requests: RecommendationRequest[] = [];
  const intentRequests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Response.json({ places: [], next_cursor: null });
      if (url === "/api/v1/intent") {
        intentRequests.push(JSON.parse(String(init?.body)));
        return Response.json(intent);
      }
      const request = JSON.parse(String(init?.body)) as RecommendationRequest;
      requests.push(request);
      return Response.json(scenarioResponse(request));
    }),
  );
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.click(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  );
  const time = screen.getByRole("spinbutton", { name: t("ru", "timeBudget") });
  await user.type(time, "45");
  await user.click(screen.getByText(t("ru", "strictConstraints")));
  await user.selectOptions(
    screen.getByRole("combobox", { name: t("ru", "wheelchair_accessible") }),
    "required",
  );
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    query,
  );
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
  );
  await screen.findByText(intentText("ru", "scenarioNoMatch"));
  expect(intentRequests).toEqual([{ query, locale: "ru" }]);
  expect(requests).toHaveLength(1);
  expect(requests[0].available_seconds).toBe(7200);
  expect(requests[0].constraints).toEqual([
    { key: "wheelchair_accessible", value: true, strength: "required" },
    { key: "indoor", value: true, strength: "preferred" },
    { key: "has_wifi", value: true, strength: "preferred" },
  ]);
  expect(time).toHaveValue(45);
  expect(
    screen.getByRole("combobox", { name: t("ru", "wheelchair_accessible") }),
  ).toHaveValue("required");
  expect(
    screen.getByRole("checkbox", { name: t("ru", "indoor") }),
  ).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Wi-Fi" })).not.toBeChecked();
  expect(
    screen.getByText(new RegExp(walkText("ru", "inferred"))),
  ).toBeVisible();
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify({ lat: 51.09, lon: 71.42 }),
  );
});

it("shows every ordered stop while connecting and never substitutes a single-place path on failure", async () => {
  const places = journeyPlaces().slice(0, 2);
  let finish!: (response: Response) => void;
  let submitted!: ItineraryRequest;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Promise.resolve(Response.json({ places, next_cursor: null }));
      const request = JSON.parse(String(init?.body));
      if (url.endsWith("/recommendations")) {
        const response = scenarioResponse(request, "matched");
        return Promise.resolve(
          Response.json({
            ...response,
            places,
            recommendations: places.map((place, index) => ({
              ...response.recommendations[0],
              place_id: place.id,
              rank: index + 1,
            })),
          }),
        );
      }
      submitted = request;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }),
  );
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    "Сначала кофе, затем парк{Enter}",
  );
  const map = screen.getByTestId("map");
  await waitFor(() =>
    expect(submitted?.place_ids).toEqual(places.map((p) => p.id)),
  );
  expect(map).toHaveAttribute("data-stops", places.map((p) => p.id).join(","));
  expect(map).toHaveAttribute("data-route", "null");
  expect(
    screen.getAllByText(mapText("ru", "connectingStops"))[0],
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: `Map select ${places[0].id}` }),
  );
  expect(map).toHaveAttribute("data-route", "null");
  await act(async () =>
    finish(
      Response.json(
        {
          request_id: "chain-unavailable",
          error: {
            code: "provider_unavailable",
            message: "Unavailable",
            details: [],
            retryable: true,
          },
        },
        { status: 503 },
      ),
    ),
  );
  expect(
    await screen.findByRole("button", { name: t("ru", "buildPlan") }),
  ).toBeEnabled();
  expect(map).toHaveAttribute("data-route", "null");
  expect(map).toHaveAttribute("data-stops", places.map((p) => p.id).join(","));
  expect(screen.getByText(mapText("ru", "connectionFailed"))).toBeVisible();
  await user.click(screen.getByRole("button", { name: t("ru", "buildPlan") }));
  await act(async () =>
    finish(Response.json(orderedJourneyResponse(submitted, places))),
  );
  await waitFor(() => expect(map.getAttribute("data-route")).not.toBe("null"));
  expect(Number(map.getAttribute("data-overview"))).toBeGreaterThan(0);
});

for (const locale of locales)
  it(`automatically connects catalogue selections without a wishlist in ${locale}`, async () => {
    const places = journeyPlaces();
    const submitted: ItineraryRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/v1/places?"))
          return Response.json({ places, next_cursor: null });
        const request = JSON.parse(String(init?.body)) as ItineraryRequest;
        submitted.push(request);
        return Response.json(orderedJourneyResponse(request, places));
      }),
    );
    const user = userEvent.setup();
    navigation.pathname = "/";
    const app = (
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />
    );
    const { rerender } = render(app);
    await user.selectOptions(
      screen.getByRole("combobox", { name: t("ru", "language") }),
      locale,
    );
    const add = await screen.findAllByRole("button", {
      name: t(locale, "add"),
    });
    await user.click(add[0]);
    await user.click(add[1]);
    expect(submitted).toHaveLength(0);
    navigation.pathname = "/walk";
    rerender(
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />,
    );
    expect(
      screen.getByText(mapText(locale, "journeyNeedsOrigin")),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Map pick" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0].query).toBe(mapText(locale, "selectedWalkQuery"));
    expect(submitted[0].place_ids).toEqual(places.slice(0, 2).map((p) => p.id));
    expect(
      screen.getByRole("textbox", { name: t(locale, "query") }),
    ).toHaveValue("");
    await waitFor(() =>
      expect(screen.getByTestId("map").getAttribute("data-route")).not.toBe(
        "null",
      ),
    );
    await user.click(
      screen.getByRole("button", { name: walkText(locale, "filters") }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: new RegExp(t(locale, "return")) }),
    );
    await waitFor(() => expect(submitted).toHaveLength(2));
    expect(submitted[1].return_to_origin).toBe(true);
    expect(submitted[1].place_ids).toEqual(submitted[0].place_ids);
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("map").getAttribute("data-route")!),
      ).toMatchObject({ includes_return: true }),
    );
  });

it("recalculates edits during a pending journey and ignores late responses from superseded orders", async () => {
  const places = journeyPlaces();
  const pending: {
    request: ItineraryRequest;
    signal: AbortSignal | null | undefined;
    finish: () => void;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Promise.resolve(Response.json({ places, next_cursor: null }));
      const request = JSON.parse(String(init?.body)) as ItineraryRequest;
      return new Promise<Response>((resolve) =>
        pending.push({
          request,
          signal: init?.signal,
          finish: () =>
            resolve(Response.json(orderedJourneyResponse(request, places))),
        }),
      );
    }),
  );
  const user = userEvent.setup();
  navigation.pathname = "/";
  const { rerender } = render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  const add = await screen.findAllByRole("button", { name: t("ru", "add") });
  await user.click(add[0]);
  await user.click(add[1]);
  await user.click(add[2]);
  expect(pending).toHaveLength(3);
  expect(pending.slice(0, 2).every((item) => item.signal?.aborted)).toBe(true);
  navigation.pathname = "/walk";
  rerender(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(
    screen.getByRole("button", {
      name: `${t("ru", "moveUp")}: ${places[1].name}`,
    }),
  );
  expect(pending[2].signal?.aborted).toBe(true);
  expect(pending[3].request.place_ids).toEqual([
    places[1].id,
    places[0].id,
    places[2].id,
  ]);
  await user.click(
    screen.getByRole("button", {
      name: `${t("ru", "remove")}: ${places[2].name}`,
    }),
  );
  expect(pending[3].signal?.aborted).toBe(true);
  expect(pending[4].request.place_ids).toEqual([places[1].id, places[0].id]);
  const map = screen.getByTestId("map");
  expect(map).toHaveAttribute("data-route", "null");
  expect(map).toHaveAttribute(
    "data-stops",
    [places[1].id, places[0].id].join(","),
  );
  await act(async () => pending[4].finish());
  const fullRoute = map.getAttribute("data-route");
  const overview = map.getAttribute("data-overview");
  expect(fullRoute).not.toBe("null");
  await act(async () => {
    for (const item of pending.slice(0, 4).reverse()) item.finish();
  });
  expect(map).toHaveAttribute("data-route", fullRoute);
  expect(map).toHaveAttribute("data-overview", overview);
  expect(map).toHaveAttribute(
    "data-stops",
    [places[1].id, places[0].id].join(","),
  );
  await user.click(
    screen.getByRole("button", {
      name: `${t("ru", "remove")}: ${places[0].name}`,
    }),
  );
  await user.click(
    screen.getByRole("button", {
      name: `${t("ru", "remove")}: ${places[1].name}`,
    }),
  );
  expect(pending[5].signal?.aborted).toBe(true);
  expect(pending).toHaveLength(6);
  await act(async () => pending[5].finish());
  expect(map).toHaveAttribute("data-route", "null");
  expect(map).toHaveAttribute("data-stops", "");
});

it("submits the wishlist with Enter, shows progress immediately, and prevents duplicate requests", async () => {
  let resolve!: (response: Response) => void;
  let submitted!: RecommendationRequest;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/v1/places?"))
      return Promise.resolve(Response.json({ places: [], next_cursor: null }));
    submitted = JSON.parse(String(init?.body)) as RecommendationRequest;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  const input = screen.getByRole("textbox", { name: t("ru", "query") });
  await user.type(input, "Хочу самые красивые места");
  await user.keyboard("{Shift>}{Enter}{/Shift}И парк");
  expect(input).toHaveValue("Хочу самые красивые места\nИ парк");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(
    fetcher.mock.calls.filter(([url]) => url === "/api/v1/recommendations"),
  ).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(
    screen.getByRole("button", { name: intentText("ru", "scenarioFinding") }),
  ).toBeDisabled();
  expect(screen.getByText(intentText("ru", "scenarioPending"))).toBeVisible();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/api/v1/recommendations"),
    ).toHaveLength(1),
  );
  expect(submitted.query).toBe("Хочу самые красивые места\nИ парк");
  expect(submitted.constraints).toEqual([]);
  await act(async () => resolve(Response.json(scenarioResponse(submitted))));
  expect(
    await screen.findByText(intentText("ru", "scenarioNoMatch")),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
  ).toBeEnabled();
});

for (const locale of locales)
  it(`confirms a completed wishlist search in ${locale}`, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.startsWith("/api/v1/places?")
          ? Response.json({ places: [], next_cursor: null })
          : Response.json(
              scenarioResponse(JSON.parse(String(init?.body)), "matched"),
            ),
      ),
    );
    const user = userEvent.setup();
    render(
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: t("ru", "language") }),
      locale,
    );
    await user.click(screen.getByRole("button", { name: "Map pick" }));
    await user.type(
      screen.getByRole("textbox", { name: t(locale, "query") }),
      "Beautiful places",
    );
    await user.click(
      screen.getByRole("button", { name: intentText(locale, "scenarioFind") }),
    );
    expect(
      await screen.findByText(intentText(locale, "scenarioApplied")),
    ).toBeVisible();
    expect(
      screen.getByText(
        `«Beautiful places» · ${intentText(locale, "scenarioCount")}: 1`,
      ),
    ).toBeVisible();
    expect(document.getElementById("scenario-status")).toHaveAttribute(
      "data-state",
      "matched",
    );
  });

it("marks text, time, constraints, start and return edits as unapplied until the next search", async () => {
  const submitted: RecommendationRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Response.json({ places: [], next_cursor: null });
      const request = JSON.parse(String(init?.body)) as RecommendationRequest;
      submitted.push(request);
      return Response.json(scenarioResponse(request));
    }),
  );
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  const input = screen.getByRole("textbox", { name: t("ru", "query") });
  await user.type(input, "Красивые места");
  await user.click(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  );
  async function search() {
    await user.click(
      screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
    );
    await screen.findByText(intentText("ru", "scenarioNoMatch"));
    expect(
      screen.queryByText(intentText("ru", "scenarioDirty")),
    ).not.toBeInTheDocument();
  }
  const changes = [
    async () => user.type(input, " и парк"),
    async () => user.click(screen.getByRole("checkbox", { name: "Wi-Fi" })),
    async () => {
      const time = screen.getByRole("spinbutton", {
        name: t("ru", "timeBudget"),
      });
      await user.clear(time);
      await user.type(time, "90");
    },
    async () =>
      fireEvent.change(screen.getByLabelText(t("ru", "startTime")), {
        target: { value: "2026-10-20T13:00" },
      }),
    async () => {
      await user.click(screen.getByText(t("ru", "manualOrigin")));
      fireEvent.change(
        screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
        { target: { value: "51.12" } },
      );
    },
    async () =>
      user.click(
        screen.getByRole("checkbox", { name: new RegExp(t("ru", "return")) }),
      ),
  ];
  await search();
  for (const change of changes) {
    await change();
    expect(screen.getByText(intentText("ru", "scenarioDirty"))).toBeVisible();
    expect(
      screen.queryByText(intentText("ru", "scenarioNoMatch")),
    ).not.toBeInTheDocument();
    await search();
  }
  expect(submitted).toHaveLength(7);
  expect(submitted.at(-1)).toMatchObject({
    query: "Красивые места и парк",
    available_seconds: 5400,
    origin: { lat: 51.12, lon: 71.42 },
    return_to_origin: true,
    constraints: [{ key: "has_wifi", value: true, strength: "preferred" }],
  });
});

it("ignores an old search after an edit and marks a language change as unapplied", async () => {
  let finishOldSearch!: () => void;
  let oldSignal: AbortSignal | null | undefined;
  let searches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Promise.resolve(
          Response.json({ places: [], next_cursor: null }),
        );
      const request = JSON.parse(String(init?.body)) as RecommendationRequest;
      if (url.endsWith("/itineraries"))
        return Promise.resolve(Response.json({}));
      searches++;
      if (searches === 1) {
        oldSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          finishOldSearch = () =>
            resolve(Response.json(scenarioResponse(request, "matched")));
        });
      }
      return Promise.resolve(
        Response.json(scenarioResponse(request, "matched")),
      );
    }),
  );
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  const input = screen.getByRole("textbox", { name: t("ru", "query") });
  await user.type(input, "Парк{Enter}");
  expect(screen.getByText(intentText("ru", "scenarioPending"))).toBeVisible();
  await user.type(input, " у реки");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finishOldSearch());
  expect(screen.getByText(intentText("ru", "scenarioDirty"))).toBeVisible();
  expect(
    screen.queryByText(intentText("ru", "scenarioApplied")),
  ).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByText(intentText("ru", "scenarioApplied")),
  ).toBeVisible();
  expect(searches).toBe(2);
  await user.selectOptions(
    screen.getByRole("combobox", { name: t("ru", "language") }),
    "en",
  );
  expect(screen.getByText(intentText("en", "scenarioDirty"))).toBeVisible();
  expect(
    screen.queryByText(intentText("en", "scenarioApplied")),
  ).not.toBeInTheDocument();
});

it("explains a missing origin next to the wishlist and reports a failed search without claiming it applied", async () => {
  const fetcher = vi.fn(async (url: string) =>
    url.startsWith("/api/v1/places?")
      ? Response.json({ places: [], next_cursor: null })
      : Response.json(
          {
            request_id: "test-unavailable",
            error: {
              code: "provider_unavailable",
              message: "offline",
              details: [],
              retryable: true,
            },
          },
          { status: 503 },
        ),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures={false}
      mapProvider="none"
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    "Красивые места{Enter}",
  );
  expect(
    screen.getByText(intentText("ru", "scenarioNeedsOrigin")),
  ).toBeVisible();
  expect(
    fetcher.mock.calls.filter(([url]) => url === "/api/v1/recommendations"),
  ).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
  );
  expect(
    await screen.findByText(intentText("ru", "scenarioError")),
  ).toBeVisible();
  expect(
    screen.queryByText(intentText("ru", "scenarioApplied")),
  ).not.toBeInTheDocument();
});

it("credits the live OSM catalogue on the data page when the map is disabled", async () => {
  navigation.pathname = "/about";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.includes("/data-status")
          ? {
              total_places: 300,
              checked_at: "2026-10-19T03:30:43+05:00",
              sources: [
                {
                  source_name: "OpenStreetMap contributors (offline snapshot)",
                  source_url: "https://www.openstreetmap.org/copyright",
                  status: "ready",
                  place_count: 300,
                  last_success_at: "2026-10-19T03:30:43+05:00",
                  warnings: [],
                },
              ],
            }
          : { places: [], next_cursor: null },
        { headers: { "x-astana-data-mode": "live" } },
      ),
    ),
  );
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures={false}
      mapProvider="none"
    />,
  );
  expect(await screen.findByRole("link", { name: "ODbL 1.0" })).toBeVisible();
  expect(screen.getByTestId("map")).toHaveAttribute("data-provider", "none");
  expect(screen.queryByText(t("ru", "fixtureBanner"))).not.toBeInTheDocument();
});

it("distinguishes an unsubmitted name query from an empty catalog result and can reset it", async () => {
  navigation.pathname = "/";
  const queries: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      queries.push(
        new URL(url, "http://test.local").searchParams.get("query") ?? "",
      );
      return Response.json(
        { places: [], next_cursor: null },
        { headers: { "x-astana-data-mode": "live" } },
      );
    }),
  );
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures={false}
      mapProvider="none"
    />,
  );
  await screen.findByText(t("ru", "empty"));
  const input = screen.getByRole("textbox", { name: t("ru", "catalogSearch") });
  await user.type(input, "Unknown place");
  expect(screen.getByText(t("ru", "catalogPendingQuery"))).toBeVisible();
  expect(queries).toEqual([""]);
  await user.click(screen.getByRole("button", { name: t("ru", "search") }));
  expect(await screen.findByText(t("ru", "catalogNoMatch"))).toBeVisible();
  expect(screen.queryByText(t("ru", "empty"))).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: t("ru", "catalogShowAll") }),
  );
  await screen.findByText(t("ru", "empty"));
  expect(input).toHaveValue("");
  expect(queries).toEqual(["", "Unknown place", ""]);
});

it("submits explicit Wi-Fi and toilets requirements without weakening them", async () => {
  let submitted: RecommendationRequest | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Response.json({ places: [], next_cursor: null });
      submitted = JSON.parse(String(init?.body)) as RecommendationRequest;
      return Response.json(
        {
          request_id: "amenity-test",
          error: {
            code: "provider_unavailable",
            message: "Offline test response",
            details: [],
            retryable: true,
          },
        },
        { status: 503 },
      );
    }),
  );
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures={false}
      mapProvider="none"
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    "Кафе",
  );
  await user.click(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  );
  await user.click(screen.getByText(t("ru", "strictConstraints")));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Wi-Fi" }),
    "required",
  );
  await user.click(screen.getByRole("checkbox", { name: t("ru", "toilets") }));
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
  );
  await waitFor(() => expect(submitted).toBeDefined());
  expect(submitted?.constraints).toEqual(
    expect.arrayContaining([
      { key: "has_wifi", value: true, strength: "required" },
      { key: "toilets", value: true, strength: "preferred" },
    ]),
  );
  await screen.findByRole("alert");
});

for (const [key, preset] of [
  ["indoor", "indoors"],
  ["child_friendly", "family"],
] as const) {
  for (const strength of ["required", "preferred", ""] as const) {
    it(`${preset} preserves ${strength || "unset"} constraints in the submitted request`, async () => {
      let submitted: RecommendationRequest | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.startsWith("/api/v1/places?"))
            return Response.json({ places: [], next_cursor: null });
          submitted = JSON.parse(String(init?.body)) as RecommendationRequest;
          return Response.json(
            {
              request_id: "preset-test",
              error: {
                code: "provider_unavailable",
                message: "Offline test response",
                details: [],
                retryable: true,
              },
            },
            { status: 503 },
          );
        }),
      );
      const user = userEvent.setup();
      render(
        <CompassApp
          initialStart="2026-10-19T12:00"
          allowFixtures={false}
          mapProvider="none"
        />,
      );
      await user.click(
        screen.getByRole("button", { name: walkText("ru", "filters") }),
      );
      await user.click(screen.getByText(t("ru", "strictConstraints")));
      const constraint = screen.getByRole("combobox", { name: t("ru", key) });
      await user.selectOptions(constraint, strength);
      await user.selectOptions(
        screen.getByRole("combobox", {
          name: t("ru", "wheelchair_accessible"),
        }),
        "required",
      );
      await user.click(screen.getByRole("button", { name: t("ru", preset) }));
      expect(constraint).toHaveValue(strength);
      await user.click(screen.getByRole("button", { name: "Map pick" }));
      await user.click(
        screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
      );
      await waitFor(() => expect(submitted).toBeDefined());
      expect(submitted?.constraints).toEqual(
        expect.arrayContaining([
          ...(strength ? [{ key, value: true, strength }] : []),
          { key: "wheelchair_accessible", value: true, strength: "required" },
        ]),
      );
      await screen.findByRole("alert");
    });
  }
}

it("keeps the wishlist intact and sends ordinary amenities only as removable preferences", async () => {
  const submitted: RecommendationRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/places?"))
        return Response.json({ places: [], next_cursor: null });
      const request = JSON.parse(String(init?.body)) as RecommendationRequest;
      submitted.push(request);
      return Response.json(scenarioResponse(request));
    }),
  );
  const user = userEvent.setup();
  const { container } = render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    />,
  );
  const strict = container.querySelector(".strict-constraints")!;
  expect(strict).not.toHaveAttribute("open");
  expect(
    screen.queryByRole("combobox", { name: "Wi-Fi" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Wi-Fi" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  );
  const query = "Хочу прогулку по живописным местам, а по пути кофе";
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    query,
  );
  await user.click(screen.getByRole("checkbox", { name: "Wi-Fi" }));
  await user.click(screen.getByRole("checkbox", { name: t("ru", "indoor") }));
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
  );
  await screen.findByText(intentText("ru", "scenarioNoMatch"));
  expect(submitted[0].query).toBe(query);
  expect(submitted[0].constraints).toEqual(
    expect.arrayContaining([
      { key: "has_wifi", value: true, strength: "preferred" },
      { key: "indoor", value: true, strength: "preferred" },
    ]),
  );
  expect(submitted[0].constraints).toHaveLength(2);
  await user.click(screen.getByRole("checkbox", { name: "Wi-Fi" }));
  await user.click(screen.getByRole("checkbox", { name: t("ru", "indoor") }));
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "scenarioFind") }),
  );
  await screen.findByText(intentText("ru", "scenarioNoMatch"));
  expect(submitted[1].query).toBe(query);
  expect(submitted[1].constraints).toEqual([]);
  expect(strict).not.toHaveAttribute("open");
});

for (const locale of locales) {
  it(`offers four meaningful walk presets without weakening explicit must-haves in ${locale}`, async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ places: [], next_cursor: null })),
    );
    const { container } = render(
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: t("ru", "language") }),
      locale,
    );
    await user.click(
      screen.getByRole("button", { name: walkText(locale, "filters") }),
    );
    const strict = container.querySelector(".strict-constraints")!;
    expect(strict).not.toHaveAttribute("open");
    await user.click(
      within(strict as HTMLElement).getByText(t(locale, "strictConstraints")),
    );
    await user.selectOptions(
      screen.getByRole("combobox", {
        name: t(locale, "wheelchair_accessible"),
      }),
      "required",
    );
    const requiredCheckbox = screen.getByRole("checkbox", {
      name: t(locale, "wheelchair_accessible"),
    });
    expect(requiredCheckbox).toBeChecked();
    expect(requiredCheckbox).toBeDisabled();
    await user.click(strict.querySelector("summary")!);
    expect(strict).not.toHaveAttribute("open");
    expect(strict.querySelector("summary")).toHaveTextContent("1");
    for (const [preset, queryKey] of [
      ["parkWalk", "parkWalkQuery"],
      ["riversideWalk", "riversideWalkQuery"],
      ["architectureWalk", "architectureWalkQuery"],
      ["mixedWalk", "mixedWalkQuery"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: t(locale, preset) }));
      expect(
        screen.getByRole("textbox", { name: t(locale, "query") }),
      ).toHaveValue(t(locale, queryKey));
      expect(requiredCheckbox).toBeChecked();
      expect(requiredCheckbox).toBeDisabled();
    }
    await user.click(strict.querySelector("summary")!);
    expect(
      screen.getByRole("combobox", {
        name: t(locale, "wheelchair_accessible"),
      }),
    ).toHaveValue("required");
    await user.selectOptions(
      screen.getByRole("combobox", {
        name: t(locale, "wheelchair_accessible"),
      }),
      "preferred",
    );
    expect(requiredCheckbox).toBeEnabled();
    await user.click(requiredCheckbox);
    expect(
      screen.getByRole("combobox", {
        name: t(locale, "wheelchair_accessible"),
      }),
    ).toHaveValue("");
  });
}

for (const locale of locales) {
  it(`discloses each itinerary preference compromise and its sources in ${locale}`, async () => {
    const seed = structuredClone(
      examples.cases.find((entry) => entry.name === "itinerary_valid")!
        .instance,
    ) as ItineraryResponse;
    const places: Place[] = [false, null].map((value, index) => ({
      ...structuredClone(seed.places[0]),
      id: `synthetic:place:compromise-${index}`,
      name: `SYNTHETIC stop ${index + 1}`,
      facts: [
        {
          key: "indoor",
          status: value === null ? "unknown" : "known",
          value,
          evidence_ids: value === null ? [] : [seed.places[0].evidence[0].id],
        },
      ],
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/v1/places?"))
          return Response.json({ places, next_cursor: null });
        if (url.startsWith("/api/v1/places/"))
          return Response.json(
            places.find(
              (place) =>
                place.id === decodeURIComponent(url.split("/").at(-1)!),
            ),
          );
        const request = JSON.parse(String(init?.body)) as ItineraryRequest;
        const response: ItineraryResponse = {
          ...seed,
          status: "partial",
          request,
          route: { ...seed.route!, includes_return: request.return_to_origin },
          places,
          stops: places.map((place, index) => ({
            ...seed.stops[0],
            place_id: place.id,
            order: index + 1,
            visit_duration_seconds: 60,
            constraint_evaluations: [
              {
                key: "indoor",
                strength: "preferred",
                outcome: index === 0 ? "unsatisfied" : "unknown",
                evidence_ids: place.facts[0].evidence_ids,
                explanation:
                  index === 0
                    ? "Synthetic source confirms this is outdoors."
                    : "Synthetic source has no indoor information.",
              },
            ],
          })),
          total_duration_seconds: seed.route!.duration_seconds + 120,
        };
        return Response.json(response);
      }),
    );
    // jsdom does not supply the browser's top-layer dialog behavior.
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
    const user = userEvent.setup();
    navigation.pathname = "/";
    const { container, rerender } = render(
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: t("ru", "language") }),
      locale,
    );
    for (const button of await screen.findAllByRole("button", {
      name: t(locale, "add"),
    }))
      await user.click(button);
    navigation.pathname = "/walk";
    rerender(
      <CompassApp
        initialStart="2026-10-19T12:00"
        allowFixtures
        mapProvider="none"
      />,
    );
    await user.click(screen.getByText(t(locale, "manualOrigin")));
    await user.type(
      screen.getByRole("textbox", { name: t(locale, "query") }),
      "Synthetic test",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: t(locale, "latitude") }),
      "51.09",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: t(locale, "longitude") }),
      "71.42",
    );
    await user.click(
      screen.getByRole("button", { name: walkText(locale, "filters") }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: t(locale, "indoor") }),
    );
    await user.click(
      screen.getByRole("button", { name: t(locale, "buildPlan") }),
    );
    await waitFor(() =>
      expect(
        container.querySelector(".itinerary-result .result-status"),
      ).toHaveTextContent(t(locale, "partial")),
    );
    const stops = container.querySelectorAll<HTMLElement>(
      ".itinerary-visits > li",
    );
    expect(stops).toHaveLength(2);
    expect(
      within(stops[0]).getByText(
        `${t(locale, "preferred")} · ${t(locale, "unsatisfied")}`,
      ),
    ).toBeVisible();
    expect(
      within(stops[1]).getByText(
        `${t(locale, "preferred")} · ${t(locale, "unknown")}`,
      ),
    ).toBeVisible();
    expect(
      within(stops[0]).getByText("Synthetic source confirms this is outdoors."),
    ).toBeVisible();
    expect(
      within(stops[1]).getByText("Synthetic source has no indoor information."),
    ).toBeVisible();
    await user.click(
      within(stops[0]).getByRole("button", { name: t(locale, "details") }),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getAllByRole("link", {
          name: seed.places[0].evidence[0].source_name,
        })[0],
      ).toHaveAttribute("href", seed.places[0].evidence[0].source_url),
    );
  });
}

it("keeps the planner in memory across pages and isolates a group's map route", async () => {
  const shared = structuredClone(
    examples.cases.find((entry) => entry.name === "itinerary_valid")!.instance,
  ) as ItineraryResponse;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ places: shared.places, next_cursor: null }),
    ),
  );
  function GroupBridge() {
    const { currentRequest, setSharedItinerary, selectedPlaceIds } =
      useSharedPlanner();
    return (
      <>
        <button onClick={() => setSharedItinerary(shared)}>
          Show group route
        </button>
        <output data-testid="request-snapshot">
          {JSON.stringify(currentRequest())}
        </output>
        <output data-testid="local-selection">
          {selectedPlaceIds.join(",")}
        </output>
      </>
    );
  }
  const app = () => (
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures
      mapProvider="none"
    >
      <GroupBridge />
    </CompassApp>
  );
  const user = userEvent.setup();
  navigation.pathname = "/";
  const { rerender } = render(app());
  expect(screen.getByTestId("map")).toHaveAttribute("data-enabled", "true");
  expect(screen.getByTestId("map")).toHaveAttribute("data-picking", "true");
  expect(
    screen
      .getByRole("spinbutton", { name: t("ru", "latitude") })
      .closest("details"),
  ).not.toHaveAttribute("open");
  for (const href of ["/", "/walk", "/saved", "/party", "/events", "/about"]) {
    expect(
      within(screen.getByRole("navigation"))
        .getAllByRole("link")
        .some((link) => link.getAttribute("href") === href),
    ).toBe(true);
  }
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  expect(screen.getByTestId("map")).toHaveAttribute("data-picking", "false");
  await user.click(
    (await screen.findAllByRole("button", { name: t("ru", "add") }))[0],
  );
  navigation.pathname = "/walk";
  rerender(app());
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    "Тихая прогулка",
  );
  await user.click(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  );
  await user.clear(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
  );
  await user.type(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
    "45",
  );
  await user.click(screen.getByText(t("ru", "strictConstraints")));
  await user.selectOptions(
    screen.getByRole("combobox", { name: t("ru", "wheelchair_accessible") }),
    "required",
  );
  const snapshot = JSON.parse(
    screen.getByTestId("request-snapshot").textContent!,
  );
  expect(snapshot).toMatchObject({
    origin: { lat: 51.09, lon: 71.42 },
    query: "Тихая прогулка",
    available_seconds: 2700,
    constraints: [
      { key: "wheelchair_accessible", value: true, strength: "required" },
    ],
  });
  navigation.pathname = "/saved";
  rerender(app());
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    t("ru", "saved"),
  );
  expect(
    screen.queryByRole("textbox", { name: t("ru", "query") }),
  ).not.toBeInTheDocument();
  expect(screen.getByTestId("local-selection")).toHaveTextContent(
    shared.places[0].id,
  );
  navigation.pathname = "/party";
  rerender(app());
  expect(screen.getByTestId("map")).toHaveAttribute("data-route", "null");
  await user.click(screen.getByRole("button", { name: "Show group route" }));
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-route",
    JSON.stringify(shared.route),
  );
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify(shared.request.origin),
  );
  navigation.pathname = "/walk";
  rerender(app());
  expect(screen.getByRole("textbox", { name: t("ru", "query") })).toHaveValue(
    "Тихая прогулка",
  );
  expect(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
  ).toHaveValue(45);
  expect(
    screen.getByRole("combobox", { name: t("ru", "wheelchair_accessible") }),
  ).toHaveValue("required");
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify(snapshot.origin),
  );
  expect(screen.getByTestId("map")).toHaveAttribute("data-route", "null");
  expect(
    JSON.parse(screen.getByTestId("request-snapshot").textContent!),
  ).toEqual(snapshot);
  expect(localStorage.length).toBe(0);
});

it("applies reviewed intent without lowering must-haves or moving the origin", async () => {
  const query = "30 минут у Байтерека, в помещении с розеткой";
  const intent: IntentResponse = {
    provider: "rules",
    locale: "ru",
    available_seconds: 1800,
    time_evidence: "30 минут",
    anchor_text: "Байтерека",
    categories: ["cafe"],
    constraints: [
      {
        constraint: { key: "indoor", value: true, strength: "preferred" },
        source_quote: "в помещении",
      },
      {
        constraint: {
          key: "has_power_outlets",
          value: true,
          strength: "required",
        },
        source_quote: "с розеткой",
      },
    ],
    clarification_questions: [],
    warnings: [],
  };
  const fetcher = vi.fn(async (url: string) =>
    url === "/api/v1/intent"
      ? Response.json(intent)
      : Response.json({ places: [], next_cursor: null }),
  );
  intentMock.mockResolvedValue(intent);
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(
    <CompassApp
      initialStart="2026-10-19T12:00"
      allowFixtures={false}
      mapProvider="none"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Map pick" }));
  await user.type(
    screen.getByRole("textbox", { name: t("ru", "query") }),
    query,
  );
  await user.click(
    screen.getByRole("button", { name: walkText("ru", "filters") }),
  );
  await user.click(screen.getByText(t("ru", "strictConstraints")));
  await user.selectOptions(
    screen.getByRole("combobox", { name: t("ru", "indoor") }),
    "required",
  );
  await user.click(screen.getByText(walkText("ru", "advancedIntent")));
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  );
  await screen.findByRole("button", { name: intentText("ru", "apply") });
  expect(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
  ).toHaveValue(null);
  expect(
    screen.getByRole("combobox", { name: t("ru", "has_power_outlets") }),
  ).toHaveValue("");
  await user.click(screen.getByRole("checkbox", { name: /Применить время/ }));
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "apply") }),
  );
  expect(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
  ).toHaveValue(30);
  expect(screen.getByRole("combobox", { name: t("ru", "indoor") })).toHaveValue(
    "required",
  );
  expect(
    screen.getByRole("combobox", { name: t("ru", "has_power_outlets") }),
  ).toHaveValue("required");
  expect(screen.getByTestId("map")).toHaveAttribute(
    "data-origin",
    JSON.stringify({ lat: 51.09, lon: 71.42 }),
  );
  expect(fetcher.mock.calls.map(([url]) => url)).not.toContain(
    "/api/v1/recommendations",
  );
});
