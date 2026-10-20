import { expect, it } from "vitest";
import type { IntentResponse, RecommendationRequest } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { applyWalkIntent, textRequestsReturn } from "./walk-intent";
it("uses text duration, keeps inferred conditions soft and preserves explicit must-haves", () => {
  const request = structuredClone(
    examples.cases.find((entry) => entry.name === "recommendations_valid")!
      .instance,
  ) as { request: RecommendationRequest };
  request.request.constraints = [
    { key: "has_wifi", value: true, strength: "required" },
  ];
  const intent: IntentResponse = {
    locale: request.request.locale,
    provider: "rules",
    available_seconds: 7200,
    time_evidence: "два часа",
    anchor_text: null,
    categories: [],
    clarification_questions: [],
    warnings: [],
    constraints: [
      {
        constraint: { key: "has_wifi", value: true, strength: "preferred" },
        source_quote: "Wi-Fi",
      },
      {
        constraint: { key: "indoor", value: true, strength: "required" },
        source_quote: "в помещении",
      },
    ],
  };
  const resolved = applyWalkIntent(request.request, intent);
  expect(resolved.available_seconds).toBe(7200);
  expect(resolved.constraints).toEqual([
    { key: "has_wifi", value: true, strength: "required" },
    { key: "indoor", value: true, strength: "preferred" },
  ]);
  expect(request.request.constraints).toHaveLength(1);
  expect(applyWalkIntent(request.request, { ...intent, locale: "en" })).toBe(
    request.request,
  );
});
it("recognizes an explicit return wish without mistaking unrelated movement for a loop", () => {
  expect(textRequestsReturn("Кофе, парк и вернуться к началу")).toBe(true);
  expect(textRequestsReturn("Coffee, park, then return to the start")).toBe(
    true,
  );
  expect(
    textRequestsReturn("Хочу посмотреть возвращение птиц и зайти в парк"),
  ).toBe(false);
  expect(textRequestsReturn("Не хочу вернуться к началу")).toBe(false);
  expect(textRequestsReturn("без возвращения к началу")).toBe(false);
  expect(textRequestsReturn("Coffee, no need to return to the start")).toBe(
    false,
  );
  expect(textRequestsReturn("До парка и обратно")).toBe(true);
});
