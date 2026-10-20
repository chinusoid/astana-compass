import { readFileSync } from "node:fs";
import path from "node:path";
import type { Place } from "@astana/api-client";
import { expect, it } from "vitest";
import { placeVisitActions, placeVisitGuide } from "./place-visit-guide";

const places = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "../../data/samples/astana-osm.json"),
    "utf8",
  ),
).places as Place[];
const botanical = places.find((place) => place.id === "osm:way/1196402246")!;
const opera = places.find((place) => place.id === "osm:way/917478479")!;

function withFacts(facts: Place["facts"]): Place {
  return { ...structuredClone(opera), facts };
}
function fact(
  key: string,
  value: Place["facts"][number]["value"],
): Place["facts"][number] {
  return { key, value, status: "known", evidence_ids: [opera.evidence[0].id] };
}

it("preserves distinct greenhouse hours and source-backed highlights from the real catalogue", () => {
  const guide = placeVisitGuide(botanical, "ru");
  expect(guide.hours.map((row) => row.key)).toContain(
    "official:greenhouse_hours",
  );
  expect(guide.hours.map((row) => row.key)).toContain(
    "official:greenhouse_entry_hours",
  );
  expect(guide.hours.some((row) => row.key === "opening_hours")).toBe(false);
  expect(
    guide.highlights.find((row) => row.key === "official:highlights")?.value,
  ).toContain("Аллеи хвойных деревьев");
  expect(
    guide.actions.find((action) => action.kind === "website")?.href,
  ).toContain("astanabotsad.kz");
  expect(guide.rating).toBeUndefined();
});

it("does not promote unknown, conflicting or unlinked claims into visit details", () => {
  const place = withFacts([
    { ...fact("opening_hours", "24/7"), status: "unknown" },
    { ...fact("wheelchair_accessible", true), status: "conflicting" },
    { ...fact("has_wifi", true), evidence_ids: ["missing"] },
    { ...fact("osm:website", "https://example.org/"), evidence_ids: [] },
  ]);
  place.evidence = place.evidence.filter(
    (source) => source.source_type !== "official",
  );
  const guide = placeVisitGuide(place, "en");
  expect(guide.hours).toEqual([]);
  expect(guide.amenities).toEqual([]);
  expect(guide.actions.filter((action) => action.kind !== "map")).toEqual([]);
});

it("retains explicit negative amenities and does not infer amenities from raw internet tags", () => {
  const guide = placeVisitGuide(
    withFacts([fact("free_entry", false), fact("osm:internet_access", "yes")]),
    "ru",
  );
  expect(guide.amenities).toMatchObject([{ key: "free_entry", value: "Нет" }]);
  expect(guide.amenities.some((row) => row.key === "has_wifi")).toBe(false);
});

it("distinguishes a verified operator website from an OSM website and an official tourism source page", () => {
  const place = withFacts([
    fact("osm:website", "https://some-directory.example/venue"),
  ]);
  expect(
    placeVisitActions(place, "en").find((action) => action.kind === "website"),
  ).toMatchObject({
    label: "Source-listed website",
    href: "https://some-directory.example/venue",
  });
  place.facts.push({
    ...fact("official:website", "https://astanaopera.kz/"),
    evidence_ids: [
      place.evidence.find((source) => source.source_type === "official")!.id,
    ],
  });
  expect(
    placeVisitActions(place, "en").find((action) => action.kind === "website"),
  ).toMatchObject({
    label: "Official website",
    href: "https://astanaopera.kz/",
  });
  place.facts = [];
  place.evidence = [
    {
      ...place.evidence.find((source) => source.source_type === "official")!,
      source_url: "https://visitastana.kz/park",
    },
  ];
  expect(
    placeVisitActions(place, "en").find((action) => action.kind === "website"),
  ).toMatchObject({
    label: "Source page",
    href: "https://visitastana.kz/park",
  });
});

it("constructs phone/email actions from attributed fields without executing or forwarding query syntax", () => {
  const place = withFacts([
    fact("osm:phone", "+7 (7172) 55-12-34; +7 700 000 00 00"),
    fact("osm:contact:email", "visits+group@example.org"),
  ]);
  const actions = placeVisitActions(place, "ru");
  expect(actions.find((action) => action.kind === "phone")).toMatchObject({
    href: "tel:+77172551234",
    detail: "+7 (7172) 55-12-34",
  });
  expect(actions.find((action) => action.kind === "email")).toMatchObject({
    href: "mailto:visits%2Bgroup@example.org",
  });
  expect(actions.find((action) => action.kind === "map")?.href).toBe(
    "https://www.openstreetmap.org/way/917478479",
  );
});

it.each([
  ["osm:website", "javascript:alert(1)"],
  ["osm:website", "https://user:secret@example.org/"],
  ["osm:phone", "+77170000000?body=unsafe"],
  ["osm:phone", "+77170000000\nX-Header: value"],
  ["osm:email", "user@example.org?subject=unsafe"],
  ["osm:email", "user@example.org\r\nBCC:else@example.org"],
  ["osm:email", "user@example.org\n"],
])("rejects unsafe contact value %s", (key, value) => {
  const place = withFacts([fact(key, value)]);
  place.evidence = place.evidence.filter(
    (source) => source.source_type !== "official",
  );
  expect(
    placeVisitActions(place, "ru").filter((action) => action.kind !== "map"),
  ).toEqual([]);
});

it("requires an exact OSM record link instead of a neighbouring or credentialed URL", () => {
  const place = withFacts([]);
  place.evidence = [
    { ...place.evidence[0], source_url: "https://www.openstreetmap.org/way/1" },
  ];
  expect(
    placeVisitActions(place, "ru").some((action) => action.kind === "map"),
  ).toBe(false);
});

it("requires both linked evidence and an explicit five-point scale for a rating", () => {
  const place = withFacts([fact("osm:stars", "5"), fact("osm:rating", "4.8")]);
  expect(placeVisitGuide(place, "en").rating).toBeUndefined();
  place.facts.push(fact("official:rating", "4.8 / 5"));
  expect(placeVisitGuide(place, "en").rating?.value).toBe("4.8 / 5");
  place.facts.at(-1)!.evidence_ids = [];
  expect(placeVisitGuide(place, "en").rating).toBeUndefined();
});

it("gives a labelled planning range and a category idea without modifying source facts", () => {
  const before = structuredClone(opera);
  const guide = placeVisitGuide(opera, "en");
  expect(guide.estimate).toBe("15–30 min");
  expect(guide.idea).toContain("architecture from outside");
  expect(guide.notes[0].value).toBe(
    opera.facts.find((fact) => fact.key === "official:visitor_note")!.value,
  );
  expect(opera).toEqual(before);
  expect(
    placeVisitGuide({ ...opera, categories: ["constructor"] }, "en").estimate,
  ).toBe("15–30 min");
});

it("uses the operator's scoped address and ticket-office hours without turning them into general opening hours", () => {
  const place = withFacts([
    fact("official:address", "Verified visitor entrance, 1"),
    fact("osm:addr:street", "Older imported street"),
    fact(
      "official:ticket_office_hours",
      "Mon–Fri 10:00–18:00; box office only",
    ),
  ]);
  const guide = placeVisitGuide(place, "en");
  expect(guide.address).toBe("Verified visitor entrance, 1");
  expect(guide.hours).toMatchObject([
    {
      key: "official:ticket_office_hours",
      label: "Ticket office hours",
      value: "Mon–Fri 10:00–18:00; box office only",
    },
  ]);
  expect(guide.hours.some((row) => row.key === "opening_hours")).toBe(false);
});
