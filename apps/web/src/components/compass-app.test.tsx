import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ItineraryRequest,
  ItineraryResponse,
  Place,
  RecommendationRequest,
} from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import CompassApp from "./compass-app";
import { locales, t } from "@/lib/i18n";

// Map rendering is independent of preset/constraint handling and needs WebGL.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
const dialogMethods = ["showModal", "close"] as const;
const originalDialogMethods = dialogMethods.map((name) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dialogMethods.forEach((name, index) => {
    const descriptor = originalDialogMethods[index];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
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
      await user.type(
        screen.getByRole("spinbutton", { name: t("ru", "latitude") }),
        "51.09",
      );
      await user.type(
        screen.getByRole("spinbutton", { name: t("ru", "longitude") }),
        "71.42",
      );
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
    for (const button of await screen.findAllByRole("button", {
      name: t(locale, "add"),
    }))
      await user.click(button);
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
