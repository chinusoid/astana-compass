import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import MobileSheet, { type SheetSnap } from "./mobile-sheet";

afterEach(() => vi.unstubAllGlobals());
function Harness() {
  const [snap, setSnap] = useState<SheetSnap>("collapsed");
  return (
    <main data-mobile-sheet data-testid="sheet" data-snap={snap}>
      <MobileSheet
        snap={snap}
        onSnap={setSnap}
        onOpen={() => setSnap("expanded")}
        locale="en"
        wish="A museum and coffee"
        summary="2 stops"
      />
    </main>
  );
}
it("offers keyboard snap controls and opens the existing planning wish", () => {
  render(<Harness />);
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  expect(handle).toHaveAttribute("aria-controls", "mobile-sheet-content");
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  fireEvent.keyDown(handle, { key: "End" });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "expanded");
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "collapsed");
  fireEvent.click(screen.getByRole("link", { name: "Open planner" }));
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "expanded");
  expect(screen.getByText("A museum and coffee")).toBeVisible();
});
it("snaps upward and downward from the handle without dragging the page", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  render(<Harness />);
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  fireEvent.pointerDown(handle, { clientY: 500 });
  fireEvent.pointerMove(handle, { clientY: 390 });
  fireEvent.pointerUp(handle, { clientY: 390 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  fireEvent.pointerDown(handle, { clientY: 400 });
  fireEvent.pointerUp(handle, { clientY: 300 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "expanded");
  fireEvent.pointerDown(handle, { clientY: 250 });
  fireEvent.pointerUp(handle, { clientY: 350 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  fireEvent.pointerDown(handle, { clientY: 300 });
  fireEvent.pointerCancel(handle, { clientY: 450 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  expect(
    screen.getByTestId("sheet").style.getPropertyValue("--sheet-drag"),
  ).toBe("");
});
