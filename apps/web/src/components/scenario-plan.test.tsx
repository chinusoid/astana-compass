import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { JourneyPlan } from "@astana/api-client";
import ScenarioPlan from "./scenario-plan";

it("shows the understood order and keeps an unresolved request visible", () => {
  const plan: JourneyPlan = {
    provider: "openai",
    order: "suggested",
    warnings: [],
    clarification_questions: ["Какой мастер-класс вам нужен?"],
    stages: [
      {
        source_quote: "поесть суши",
        search_query: "sushi",
        kind: "meal",
        named_place: null,
        cuisine: "sushi",
      },
      {
        source_quote: "мастер-класс",
        search_query: "мастер-класс",
        kind: "unresolved",
        named_place: null,
        cuisine: null,
      },
    ],
  };
  render(<ScenarioPlan plan={plan} locale="ru" />);
  const summary = screen.getByTestId("scenario-plan");
  expect(
    within(summary).getByText("Предложенный порядок · OpenAI"),
  ).toBeVisible();
  const items = within(summary).getAllByRole("listitem");
  expect(items[0]).toHaveTextContent("поесть суши");
  expect(items[1]).toHaveTextContent("мастер-класс — Нужно уточнить");
  expect(
    within(summary).getByText("Какой мастер-класс вам нужен?"),
  ).toBeVisible();
});
