import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ItineraryResponse } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import WalkAssistantDock from "./walk-assistant-dock";
afterEach(cleanup);
it("keeps the companion available on the map, opens a real plan brief and returns focus on Escape", async () => {
  const plan = structuredClone(
    examples.cases.find((c) => c.name === "itinerary_valid")!.instance,
  ) as ItineraryResponse;
  const refine = vi.fn(),
    details = vi.fn();
  function App() {
    const [open, setOpen] = useState(false);
    const [currentPlan, setCurrentPlan] = useState<ItineraryResponse | null>(
      plan,
    );
    return (
      <WalkAssistantDock
        open={open}
        onOpenChange={setOpen}
        locale="ru"
        phase="ready"
        itinerary={currentPlan}
        hasTimeTarget={false}
        stopCount={plan.stops.length}
        overBudgetMinutes={10}
        onDetails={details}
        onRefine={(goal) => {
          refine(goal);
          setCurrentPlan(null);
        }}
      />
    );
  }
  const user = userEvent.setup();
  render(<App />);
  const trigger = screen.getByRole("button", {
    name: "Открыть спутника и разбор прогулки",
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger.querySelector('[data-emotion="concern"]')).not.toBeNull();
  expect(refine).not.toHaveBeenCalled();
  await user.click(trigger);
  expect(
    screen.getByRole("button", { name: "Закрыть спутника" }),
  ).toHaveFocus();
  const brief = screen.getByRole("region", { name: "Разбор вашей прогулки" });
  expect(within(brief).getByText(/Вы не задавали длительность/)).toBeVisible();
  expect(
    within(brief).getByText(/Точный путь по дорогам пока не подтверждён/),
  ).toBeVisible();
  await user.click(
    within(brief).getByRole("button", {
      name: `Открыть место: ${plan.places.find((p) => p.id === plan.stops[0].place_id)!.name}`,
    }),
  );
  expect(details).toHaveBeenCalledWith(plan.stops[0].place_id);
  await user.click(
    within(brief).getByRole("button", { name: "Найти с меньшей ходьбой" }),
  );
  expect(refine).toHaveBeenCalledExactlyOnceWith("lessWalking");
  expect(
    screen.queryByRole("region", { name: "Разбор вашей прогулки" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Закрыть спутника" }),
  ).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
