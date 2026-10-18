import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  IntentResponse,
  ItineraryRequest,
  ItineraryResponse,
  Place,
  RecommendationRequest,
} from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import CompassApp from "./compass-app";
import { locales, t } from "@/lib/i18n";
import { intentText } from "@/lib/intent-copy";
import { useSharedPlanner } from "@/lib/shared-planner";

const navigation = vi.hoisted(() => ({ pathname: "/walk" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
// Exercise the planner/map boundary without a WebGL renderer in jsdom.
vi.mock("next/dynamic", () => ({
  default: () =>
    function MapStub(props: {
      enabled: boolean;
      picking: boolean;
      selectedIds: string[];
      origin: { lat: number; lon: number } | null;
      route: unknown;
      onPick: (point: { lat: number; lon: number }) => void;
    }) {
      return (
        <div
          data-testid="map"
          data-enabled={props.enabled}
          data-picking={props.picking}
          data-selected={props.selectedIds.join(",")}
          data-origin={JSON.stringify(props.origin)}
          data-route={JSON.stringify(props.route)}
        >
          <button
            type="button"
            onClick={() => props.onPick({ lat: 51.09, lon: 71.42 })}
          >
            Map pick
          </button>
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
      const constraint = screen.getByRole("combobox", { name: t("ru", key) });
      await user.selectOptions(constraint, strength);
      await user.selectOptions(
        screen.getByRole("combobox", {
          name: t("ru", "wheelchair_accessible"),
        }),
        "required",
      );
      await user.click(screen.getByRole("button", { name: t("ru", preset) }));
      expect(constraint).toHaveValue(strength || "preferred");
      await user.click(screen.getByRole("button", { name: "Map pick" }));
      await user.click(screen.getByRole("button", { name: t("ru", "find") }));
      await waitFor(() => expect(submitted).toBeDefined());
      expect(submitted?.constraints).toEqual(
        expect.arrayContaining([
          { key, value: true, strength: strength || "preferred" },
          { key: "wheelchair_accessible", value: true, strength: "required" },
        ]),
      );
      await screen.findByRole("alert");
    });
  }
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
    await user.selectOptions(
      screen.getByRole("combobox", { name: t(locale, "indoor") }),
      "preferred",
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
  await user.clear(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
  );
  await user.type(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
    "45",
  );
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
  await user.selectOptions(
    screen.getByRole("combobox", { name: t("ru", "indoor") }),
    "required",
  );
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  );
  await screen.findByRole("button", { name: intentText("ru", "apply") });
  expect(
    screen.getByRole("spinbutton", { name: t("ru", "timeBudget") }),
  ).toHaveValue(60);
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
