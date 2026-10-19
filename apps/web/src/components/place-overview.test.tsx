import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Place } from "@astana/api-client";
import { locales, t } from "@/lib/i18n";
import {
  factLabel,
  factValue,
  placeText,
  sourceDescription,
} from "@/lib/place-presentation";
import PlaceOverview from "./place-overview";
import { PlaceFacts } from "./details";

// Render source records from the committed snapshot, independently of fixture API data.
const places = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "../../data/samples/astana-osm.json"),
    "utf8",
  ),
).places as Place[];
const actual = places.find((place) =>
  place.facts.some(
    (fact) => fact.key === "opening_hours" && fact.status === "known",
  ),
)!;

for (const locale of locales) {
  it(`renders real source hours without asserting opening during a visit in ${locale}`, () => {
    const schedule = actual.facts.find((fact) => fact.key === "opening_hours")!;
    render(<PlaceOverview place={actual} locale={locale} />);
    expect(screen.getByText(factValue(locale, schedule))).toBeVisible();
    expect(screen.getByText(placeText(locale, "scheduleNote"))).toBeVisible();
    expect(
      screen.queryByText(t(locale, "open_at_requested_time")),
    ).not.toBeInTheDocument();
    expect(actual.is_synthetic).toBe(false);
  });
}

it("keeps raw values and notes available while making source field names readable", () => {
  render(<PlaceFacts place={actual} locale="ru" />);
  const fact = screen
    .getByText(factLabel("ru", "opening_hours"), { selector: "strong" })
    .closest(".fact")!;
  const record = actual.facts.find((entry) => entry.key === "opening_hours")!;
  expect(
    within(fact as HTMLElement).getByText(record.note!),
  ).toBeInTheDocument();
  expect(
    within(fact as HTMLElement).getByText("opening_hours", {
      selector: "code",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText(placeText("ru", "sourceClaim"))).toBeVisible();
  const metadata = screen
    .getByText(placeText("ru", "otherFacts"), { exact: false })
    .closest("details");
  expect(metadata).not.toHaveAttribute("open");
});

it("does not invent a description or promote unverified Wi-Fi and indoor seating into amenities", () => {
  const place = structuredClone(actual);
  place.description = null;
  place.facts = [
    { key: "has_wifi", status: "unknown", value: null, evidence_ids: [] },
    { key: "indoor", status: "unknown", value: null, evidence_ids: [] },
    {
      key: "osm:internet_access",
      status: "known",
      value: "yes",
      evidence_ids: [place.evidence[0].id],
    },
    {
      key: "osm:indoor_seating",
      status: "known",
      value: "yes",
      evidence_ids: [place.evidence[0].id],
    },
    {
      key: "toilets",
      status: "known",
      value: false,
      evidence_ids: [place.evidence[0].id],
    },
  ];
  const { container } = render(
    <PlaceOverview place={place} locale="ru" detailed />,
  );
  expect(screen.getByText(placeText("ru", "noDescription"))).toBeVisible();
  expect(screen.getByText(factLabel("ru", "osm:indoor_seating"))).toBeVisible();
  expect(screen.queryByText("Wi-Fi")).not.toBeInTheDocument();
  expect(screen.queryByText(t("ru", "indoor"))).not.toBeInTheDocument();
  expect(container.querySelector(".source-summary")).toHaveTextContent(
    "ТуалетНет",
  );
});

it("requires linked evidence for overview claims", () => {
  const place = structuredClone(actual);
  place.description = null;
  place.facts = [
    {
      key: "has_wifi",
      status: "known",
      value: true,
      evidence_ids: ["missing-evidence"],
    },
  ];
  const { container } = render(<PlaceOverview place={place} locale="en" />);
  expect(container.querySelector(".source-summary")).toBeNull();
});

it("selects a source-language description and keeps its exact evidence separate from the summary", () => {
  const place = structuredClone(actual);
  place.description = "Original source description";
  const evidence = {
    ...place.evidence[0],
    id: "test:localized-source",
    source_name: "Wikidata (CC0 1.0)",
    source_url: "https://www.wikidata.org/w/index.php?title=Q1&oldid=1",
    source_type: "provider" as const,
  };
  place.evidence.push(evidence);
  place.facts.push({
    key: "wikidata:description:kk",
    status: "known",
    value: "Дереккөздегі сипаттама",
    evidence_ids: [evidence.id],
  });
  expect(
    sourceDescription(place, "kk")?.evidence.map((source) => source.id),
  ).toEqual([evidence.id]);
  render(<PlaceOverview place={place} locale="kk" detailed />);
  expect(
    screen.getByText("Дереккөздегі сипаттама", {
      selector: ".source-description > p:not(.overview-label)",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: evidence.source_name }),
  ).toHaveAttribute("href", evidence.source_url);
  expect(screen.queryByText(place.description)).not.toBeInTheDocument();
});

it("preserves the original description when no translation exists", () => {
  const place = structuredClone(actual);
  place.description = "urban park in Astana, Kazakhstan";
  render(<PlaceOverview place={place} locale="ru" detailed />);
  expect(screen.getByText(place.description)).toBeVisible();
  expect(screen.getByText(placeText("ru", "sourceText"))).toBeVisible();
});
