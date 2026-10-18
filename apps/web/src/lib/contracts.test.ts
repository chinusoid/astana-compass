import { describe, expect, it } from "vitest";
import type {
  ItineraryResponse,
  RecommendationResponse,
} from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import {
  itineraryIntegrity,
  recommendationIntegrity,
  routeGeometry,
  valid,
  type Definition,
} from "./contracts";

const recommendation = () =>
  structuredClone(
    examples.cases.find((c) => c.name === "recommendations_valid")!.instance,
  ) as RecommendationResponse;
const itinerary = () =>
  structuredClone(
    examples.cases.find((c) => c.name === "itinerary_valid")!.instance,
  ) as ItineraryResponse;

describe("canonical boundaries", () => {
  for (const example of examples.cases.filter((c) => c.valid)) {
    it(`accepts canonical fixture ${example.name}`, () =>
      expect(valid(example.definition as Definition, example.instance)).toBe(
        true,
      ));
  }
  for (const example of examples.cases.filter(
    (c) => !c.valid && c.failure_stage === "schema",
  )) {
    it(`rejects schema violation ${example.name}`, () =>
      expect(valid(example.definition as Definition, example.instance)).toBe(
        false,
      ));
  }
  it("checks canonical recommendation references and budgets", () => {
    const response = recommendation();
    expect(recommendationIntegrity(response, response.request)).toBe(true);
    response.recommendations[0].total_duration_seconds++;
    expect(recommendationIntegrity(response, response.request)).toBe(false);
  });
  it("does not accept required unknown even with a satisfied evaluation", () => {
    const response = recommendation();
    const key = response.request.constraints.find(
      (c) => c.strength === "required",
    )!.key;
    const fact = response.places[0].facts.find((f) => f.key === key)!;
    fact.status = "unknown";
    fact.value = null;
    fact.evidence_ids = [];
    expect(recommendationIntegrity(response, response.request)).toBe(false);
  });
  it("treats boolean and number as different constraint values", () => {
    const response = recommendation();
    const constraint = response.request.constraints.find(
      (c) => c.strength === "required",
    )!;
    response.places[0].facts.find((f) => f.key === constraint.key)!.value = 1;
    expect(recommendationIntegrity(response, response.request)).toBe(false);
  });
  it("rejects changed stop order and truncated successful itineraries", () => {
    const response = itinerary();
    response.request.available_seconds = 7200;
    response.request.place_ids.push("synthetic:place:two");
    response.places.push({
      ...structuredClone(response.places[0]),
      id: "synthetic:place:two",
    });
    response.stops.push({
      ...structuredClone(response.stops[0]),
      place_id: "synthetic:place:two",
      order: 2,
    });
    response.total_duration_seconds += response.stops[1].visit_duration_seconds;
    expect(itineraryIntegrity(response, response.request)).toBe(true);
    expect(
      itineraryIntegrity(response, {
        ...response.request,
        place_ids: [...response.request.place_ids].reverse(),
      }),
    ).toBe(false);
    response.stops.pop();
    expect(itineraryIntegrity(response, response.request)).toBe(false);
  });
  it("rejects a missing return trip", () => {
    const response = itinerary();
    response.route!.includes_return = !response.request.return_to_origin;
    expect(itineraryIntegrity(response, response.request)).toBe(false);
  });
  it("never exposes approximate geometry even if an untrusted payload includes one", () => {
    const route = itinerary().route!;
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [71.4, 51.1],
        [71.5, 51.2],
      ] as [number, number][],
    };
    expect(
      routeGeometry({ ...route, method: "approximate", geometry }),
    ).toBeNull();
    expect(routeGeometry({ ...route, method: "routed", geometry })).toEqual(
      geometry,
    );
    expect(routeGeometry(null)).toBeNull();
  });
});
