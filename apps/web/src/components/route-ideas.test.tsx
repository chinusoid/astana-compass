import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RecommendationResponse } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { locales, t } from "@/lib/i18n";
import RouteIdeas, { ideasCopy } from "./route-ideas";

const seed = examples.cases.find(
  (entry) => entry.name === "recommendations_valid",
)!.instance as RecommendationResponse;
const place = seed.places[0];
const suggestion = {
  place_id: place.id,
  why: "An optional extra from the catalogue",
  suggested_activity: "Look at the building",
  constraint_evaluations: [],
};
it.each(locales)(
  "labels optional ideas and offers explicit actions in %s",
  (locale) => {
    const onAdd = vi.fn(),
      onDetails = vi.fn();
    const { rerender } = render(
      <RouteIdeas
        suggestions={[suggestion]}
        places={[place]}
        selectedIds={[]}
        locale={locale}
        onAdd={onAdd}
        onDetails={onDetails}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: new RegExp(ideasCopy[locale].title),
      }),
    ).toBeVisible();
    expect(screen.getByText(ideasCopy[locale].proposal)).toBeVisible();
    expect(screen.getByText(suggestion.why)).toBeVisible();
    expect(screen.getByText(suggestion.suggested_activity)).toBeVisible();
    expect(screen.getByTestId("place-cover")).toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: `${ideasCopy[locale].add}: ${place.name}`,
      }),
    );
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(place);
    fireEvent.click(
      screen.getByRole("button", {
        name: `${t(locale, "details")}: ${place.name}`,
      }),
    );
    expect(onDetails).toHaveBeenCalledExactlyOnceWith(place.id);
    rerender(
      <RouteIdeas
        suggestions={[suggestion]}
        places={[place]}
        selectedIds={[place.id]}
        locale={locale}
        onAdd={onAdd}
        onDetails={onDetails}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: `${ideasCopy[locale].selected}: ${place.name}`,
      }),
    ).toBeDisabled();
    rerender(
      <RouteIdeas
        suggestions={[suggestion]}
        places={[place]}
        selectedIds={Array.from({ length: 6 }, (_, index) => `other-${index}`)}
        locale={locale}
        onAdd={onAdd}
        onDetails={onDetails}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: `${ideasCopy[locale].add}: ${place.name}`,
      }),
    ).toBeDisabled();
    expect(screen.getByText(ideasCopy[locale].full)).toBeVisible();
  },
);
it("does not render missing places or an empty ideas section", () => {
  const { container } = render(
    <RouteIdeas
      suggestions={[suggestion]}
      places={[]}
      selectedIds={[]}
      locale="en"
      onAdd={vi.fn()}
      onDetails={vi.fn()}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});
