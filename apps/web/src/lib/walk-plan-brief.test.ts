import { expect, it } from "vitest";
import type { ItineraryResponse } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { planBrief, refineWalkQuery } from "./walk-plan-brief";
function itinerary() {
  return structuredClone(
    examples.cases.find((c) => c.name === "itinerary_valid")!.instance,
  ) as ItineraryResponse;
}
it("shows the actual combined path and visit estimates without inventing a 24-hour user target", () => {
  const plan = itinerary();
  plan.request.available_seconds = 86400;
  const brief = planBrief(plan, false)!;
  expect(brief.target).toBeNull();
  expect(brief.difference).toBeNull();
  expect(brief.walking).toBe(plan.route!.duration_seconds);
  expect(brief.visiting + brief.walking).toBe(brief.total);
  expect(brief.distance).toBe(plan.route!.distance_meters);
  expect(brief.approximate).toBe(true);
  expect(planBrief(plan, true)!.target).toBe(86400);
});
it("reports a genuine overrun and deduplicates unknown preferences", () => {
  const plan = itinerary();
  plan.request.available_seconds = 60;
  const unknown = {
    key: "toilets",
    strength: "preferred" as const,
    outcome: "unknown" as const,
    evidence_ids: [],
    explanation: "Unknown",
  };
  plan.stops.forEach((stop) => stop.constraint_evaluations.push(unknown));
  expect(planBrief(plan, true)!.difference).toBe(
    plan.total_duration_seconds - 60,
  );
  expect(
    planBrief(plan, true)!.unknownPreferences.filter((k) => k === "toilets"),
  ).toHaveLength(1);
  expect(planBrief({ ...plan, route: null }, true)).toBeNull();
});
it.each(["ru", "kk", "en"] as const)(
  "refinement preserves the original wish and never silently truncates or duplicates it (%s)",
  (locale) => {
    const original = "Coffee, then park. Wi-Fi required. 1 h 30 min.";
    const refined = refineWalkQuery(original, "lessWalking", locale);
    expect(refined.startsWith(original + "\n")).toBe(true);
    expect(refineWalkQuery(refined, "lessWalking", locale)).toBe(refined);
    expect(refineWalkQuery("x".repeat(2000), "scenic", locale)).toBe(
      "x".repeat(2000),
    );
  },
);
