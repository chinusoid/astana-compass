import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RecommendationResponse } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import PlaceCard from "./place-card";
import { PlaceFacts, Warnings } from "./details";
import { locales, t } from "@/lib/i18n";

const seed = examples.cases.find((c) => c.name === "recommendations_valid")!
  .instance as RecommendationResponse;
for (const locale of locales) {
  it(`offers usable actions and separates suggestions from facts in ${locale}`, () => {
    const onAdd = vi.fn(),
      onDetails = vi.fn();
    render(
      <PlaceCard
        place={seed.places[0]}
        recommendation={seed.recommendations[0]}
        locale={locale}
        selected={false}
        full={false}
        active={false}
        saved={false}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onAdd={onAdd}
        onDetails={onDetails}
      />,
    );
    expect(screen.getByText(t(locale, "suggestion"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: t(locale, "add") }));
    expect(onAdd).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: t(locale, "details") }));
    expect(onDetails).toHaveBeenCalledOnce();
  });
}
it("shows unknown and conflicting facts without inventing boolean values", () => {
  const place = structuredClone(seed.places[0]);
  place.facts = [
    {
      key: "wheelchair_accessible",
      status: "unknown",
      value: null,
      evidence_ids: [],
    },
    {
      key: "free_entry",
      status: "conflicting",
      value: null,
      evidence_ids: place.evidence.map((e) => e.id),
    },
  ];
  render(<PlaceFacts place={place} locale="ru" />);
  expect(screen.getByText(t("ru", "unknown"))).toBeVisible();
  expect(screen.getByText(t("ru", "conflicting"))).toBeVisible();
  expect(screen.queryByText("Нет", { exact: true })).not.toBeInTheDocument();
});
it("keeps the model failure visible alongside the natural fallback label", () => {
  render(
    <Warnings
      locale="ru"
      warnings={[
        "Генератор объяснений недоступен или вернул неподтверждённые ссылки. Использовано объяснение по данным.",
      ]}
    />,
  );
  expect(screen.getByText(t("ru", "fallback"))).toBeVisible();
  fireEvent.click(screen.getByText(t("ru", "warnings"), { exact: false }));
  expect(screen.getByText(/Генератор объяснений недоступен/)).toBeVisible();
});
