import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Place } from "@astana/api-client";
import { expect, it, vi } from "vitest";
import { locales } from "@/lib/i18n";
import { placeText } from "@/lib/place-presentation";
import { visitText } from "@/lib/place-visit-guide";
import PlaceVisitGuide from "./place-visit-guide";
import { PlaceFacts } from "./details";
import { directoryText } from "./place-directory";

vi.mock("./place-photo", () => ({
  default: () => <div data-testid="photo-placeholder" />,
}));
const places = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "../../data/samples/astana-osm.json"),
    "utf8",
  ),
).places as Place[];
const opera = places.find((place) => place.id === "osm:way/917478479")!;
const botanical = places.find((place) => place.id === "osm:way/1196402246")!;

for (const locale of locales)
  it(`separates attributed highlights, category ideas and estimated visit times in ${locale}`, () => {
    render(<PlaceVisitGuide place={botanical} locale={locale} />);
    expect(
      screen.getByRole("region", { name: visitText(locale, "practical") }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: visitText(locale, "highlights") }),
    ).toHaveTextContent("Аллеи хвойных деревьев");
    const idea = screen.getByRole("region", {
      name: visitText(locale, "idea"),
    });
    expect(within(idea).getByText(visitText(locale, "ideaNote"))).toBeVisible();
    expect(
      within(idea).getByText(visitText(locale, "estimateNote")),
    ).toBeVisible();
    expect(within(idea).getByText(/30–60/)).toBeVisible();
    expect(
      screen.queryByText(visitText(locale, "rating")),
    ).not.toBeInTheDocument();
  });

it("puts practical details and important notes above explicit 2GIS, while preserving collapsed raw sources", () => {
  const { container } = render(<PlaceFacts place={opera} locale="ru" />);
  const guide = screen.getByTestId("place-visit-guide");
  const directory = screen.getByRole("button", {
    name: directoryText("ru", "check"),
  });
  expect(
    guide.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.getByRole("link", {
      name: /^(Официальный сайт|Сайт из источника)$/,
    }),
  ).toHaveAttribute("href", "https://astanaopera.kz/");
  expect(guide).toHaveTextContent(
    String(
      opera.facts.find((fact) => fact.key === "official:visitor_note")!.value,
    ),
  );
  expect(screen.getByText(visitText("ru", "records"))).toBeVisible();
  expect(screen.getByTestId("place-source-records")).not.toHaveAttribute(
    "open",
  );
  expect(screen.getByTestId("unknown-place-facts")).not.toHaveAttribute("open");
  expect(container.querySelectorAll(".source-description")).toHaveLength(1);
  fireEvent.click(screen.getByText(visitText("ru", "records")));
  expect(
    within(screen.getByTestId("place-source-records")).getByText(
      placeText("ru", "otherFacts"),
      { exact: false },
    ),
  ).toBeVisible();
});

it("keeps a compact card useful without repeating the full visit guide", () => {
  const place = {
    ...structuredClone(opera),
    facts: opera.facts.filter((fact) => fact.key !== "official:address"),
  };
  render(<PlaceVisitGuide place={place} locale="ru" compact />);
  expect(screen.getByText(/Қонаев көшесі, 1, Астана/)).toBeVisible();
  expect(
    screen.getByRole("link", {
      name: /^(Официальный сайт|Сайт из источника)$/,
    }),
  ).toBeVisible();
  expect(screen.queryByText(visitText("ru", "idea"))).not.toBeInTheDocument();
  expect(
    screen.queryByText(visitText("ru", "estimate")),
  ).not.toBeInTheDocument();
});

it("uses the current plan visit estimate when it is supplied instead of showing a contradictory category range", () => {
  render(<PlaceFacts place={botanical} locale="ru" visitSeconds={1500} />);
  const idea = screen.getByRole("region", { name: visitText("ru", "idea") });
  expect(within(idea).getByText("25 мин")).toBeVisible();
  expect(
    within(idea).getByText(visitText("ru", "planEstimateNote")),
  ).toBeVisible();
  expect(within(idea).queryByText("30–60 мин")).not.toBeInTheDocument();
});
