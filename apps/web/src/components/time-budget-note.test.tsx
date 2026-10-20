import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import TimeBudgetNote from "./time-budget-note";

it("shows extra time rather than concealing a longer route", () => {
  const { rerender } = render(
    <TimeBudgetNote totalSeconds={12000} budgetSeconds={6000} locale="ru" />,
  );
  expect(screen.getByTestId("time-budget-note")).toHaveTextContent(
    "На 100 мин дольше выбранных 100 мин",
  );
  rerender(
    <TimeBudgetNote totalSeconds={18000} budgetSeconds={6000} locale="ru" />,
  );
  expect(screen.getByTestId("time-budget-note")).toHaveTextContent(
    "На 200 мин дольше выбранных 100 мин",
  );
  rerender(
    <TimeBudgetNote totalSeconds={6000} budgetSeconds={6000} locale="ru" />,
  );
  expect(screen.queryByTestId("time-budget-note")).not.toBeInTheDocument();
});
