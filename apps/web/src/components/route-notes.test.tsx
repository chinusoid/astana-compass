import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { RecommendationResponse } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { locales, t } from "@/lib/i18n";
import { RouteNotes } from "./details";

const seed = examples.cases.find((c) => c.name === "recommendations_valid")!
  .instance as RecommendationResponse;

for (const locale of locales) {
  it(`shows TomTom entrance limitations before opening source details in ${locale}`, () => {
    const route = structuredClone(seed.recommendations[0].route);
    route.provider = "TomTom Maps";
    route.method = "routed";
    const { container } = render(<RouteNotes route={route} locale={locale} />);
    expect(screen.getByTestId("route-access-note")).toBeVisible();
    expect(screen.getByTestId("route-access-note")).toHaveTextContent(
      t(locale, "routeAccessNote"),
    );
    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });
}

it("does not attach a TomTom access guarantee to OSRM fallback or approximate estimates", () => {
  const route = structuredClone(seed.recommendations[0].route);
  route.provider = "OSRM";
  route.method = "routed";
  route.assumptions.push(
    "TomTom pedestrian routing unavailable; verified OSRM foot route used.",
  );
  const { rerender } = render(<RouteNotes route={route} locale="ru" />);
  expect(screen.queryByTestId("route-access-note")).not.toBeInTheDocument();
  route.provider = "TomTom Maps";
  route.method = "approximate";
  rerender(<RouteNotes route={route} locale="ru" />);
  expect(screen.queryByTestId("route-access-note")).not.toBeInTheDocument();
});
