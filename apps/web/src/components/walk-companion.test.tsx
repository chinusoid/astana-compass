import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import WalkCompanion from "./walk-companion";

it("reacts to search and route phases, then celebrates the completed plan", () => {
  const { container, rerender } = render(
    <WalkCompanion locale="ru" phase="idle" />,
  );
  expect(screen.getByLabelText("Спутник прогулки")).toBeVisible();
  expect(
    container.querySelector("svg[data-emotion='idle']"),
  ).toBeInTheDocument();
  rerender(<WalkCompanion locale="ru" phase="searching" />);
  expect(screen.getByText(/Ищу места по вашему описанию/)).toBeVisible();
  expect(
    container.querySelector("svg[data-emotion='thinking']"),
  ).toBeInTheDocument();
  rerender(<WalkCompanion locale="ru" phase="routing" />);
  expect(screen.getByText(/Соединяю остановки по порядку/)).toBeVisible();
  rerender(<WalkCompanion locale="ru" phase="ready" stopCount={3} />);
  expect(screen.getByText(/План готов: 3 остановки/)).toBeVisible();
  expect(
    container.querySelector("svg[data-emotion='happy']"),
  ).toBeInTheDocument();
});

it("explains a longer walk as a choice, without rejecting or editing it", () => {
  const callback = vi.fn();
  const { container } = render(
    <WalkCompanion
      locale="ru"
      phase="ready"
      stopCount={3}
      overBudgetMinutes={24.2}
      onSuggestion={callback}
    />,
  );
  expect(screen.getByText(/на 25 мин дольше/)).toHaveTextContent(
    "Можно оставить весь путь",
  );
  expect(
    container.querySelector("svg[data-emotion='concern']"),
  ).toBeInTheDocument();
  expect(callback).not.toHaveBeenCalled();
});

it("mutes changing comments and restores them on request", async () => {
  const { rerender } = render(<WalkCompanion locale="ru" phase="idle" />);
  await userEvent.click(
    screen.getByRole("button", { name: "Скрыть комментарии помощника" }),
  );
  rerender(<WalkCompanion locale="ru" phase="error" />);
  expect(
    screen.queryByText(/План пока не удалось построить/),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Комментарии скрыты")).toHaveAttribute(
    "aria-live",
    "off",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Показать комментарии помощника" }),
  );
  expect(screen.getByText(/План пока не удалось построить/)).toHaveAttribute(
    "aria-live",
    "polite",
  );
});

it("collapses without removing its accessible reopen control", async () => {
  render(<WalkCompanion locale="en" phase="empty" />);
  await userEvent.click(
    screen.getByRole("button", { name: "Collapse companion" }),
  );
  expect(screen.queryByText(/no suitable plan/)).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Expand companion" }),
  );
  expect(screen.getByText(/no suitable plan/)).toBeVisible();
});

it("suggestions change the wish only after the user selects a specific idea", async () => {
  const callback = vi.fn();
  render(
    <WalkCompanion
      locale="ru"
      phase="idle"
      suggestions={["Кофе, затем парк", "Вечерняя архитектура"]}
      onSuggestion={callback}
    />,
  );
  expect(callback).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Подсказать идею" }),
  );
  expect(callback).not.toHaveBeenCalled();
  expect(screen.getByText(/Поиск запускаете вы/)).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Кофе, затем парк" }),
  );
  expect(callback).toHaveBeenCalledExactlyOnceWith("Кофе, затем парк");
  expect(
    screen.queryByRole("button", { name: "Вечерняя архитектура" }),
  ).not.toBeInTheDocument();
});

it("does not change an in-progress request and supports Kazakh", () => {
  const callback = vi.fn();
  render(<WalkCompanion locale="kk" phase="routing" onSuggestion={callback} />);
  expect(screen.getByRole("button", { name: "Идея ұсыну" })).toBeDisabled();
  expect(screen.getByText(/Аялдамаларды ретімен/)).toBeVisible();
  expect(callback).not.toHaveBeenCalled();
});
