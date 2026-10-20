import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import MobileSheet, { type SheetSnap } from "./mobile-sheet";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Harness({
  initial = "collapsed",
  onSnap = () => {},
  onRender = () => {},
}: {
  initial?: SheetSnap;
  onSnap?: (snap: SheetSnap) => void;
  onRender?: () => void;
}) {
  const [snap, setSnap] = useState<SheetSnap>(initial);
  onRender();
  return (
    <main
      data-mobile-sheet
      data-testid="sheet"
      data-snap={snap}
      style={{ maxHeight: 766 }}
    >
      <MobileSheet
        snap={snap}
        onSnap={(next) => {
          onSnap(next);
          setSnap(next);
        }}
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
it("snaps upward and downward from the handle without dragging the page", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("innerHeight", 844);
  render(<Harness />);
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  fireEvent.pointerDown(handle, { clientY: 500 });
  fireEvent.pointerMove(handle, { clientY: 390 });
  fireEvent.pointerUp(handle, { clientY: 390 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  await waitFor(() =>
    expect(screen.getByTestId("sheet")).not.toHaveAttribute(
      "data-sheet-preview",
    ),
  );
  fireEvent.pointerDown(handle, { clientY: 400 });
  fireEvent.pointerUp(handle, { clientY: 300 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "expanded");
  fireEvent.pointerDown(handle, { clientY: 250 });
  fireEvent.pointerUp(handle, { clientY: 350 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  fireEvent.pointerDown(handle, { clientY: 300 });
  fireEvent.pointerCancel(handle, { clientY: 450 });
  expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  await waitFor(() =>
    expect(screen.getByTestId("sheet")).not.toHaveAttribute(
      "data-sheet-preview",
    ),
  );
  expect(
    screen.getByTestId("sheet").style.getPropertyValue("--sheet-drag"),
  ).toBe("");
});

it("tracks the finger directly without layout reads or React work on moves, and crosses two detents on a long pull", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("innerHeight", 844);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const onSnap = vi.fn(),
    onRender = vi.fn();
  render(<Harness onSnap={onSnap} onRender={onRender} />);
  const sheet = screen.getByTestId("sheet");
  const geometry = vi.spyOn(sheet, "getBoundingClientRect");
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  fireEvent.pointerDown(handle, { clientY: 660 });
  expect(sheet.style.transition).toBe("none");
  expect(sheet).toHaveAttribute("data-sheet-dragging", "true");
  expect(sheet.style.getPropertyValue("--sheet-drag")).toBe("634px");
  for (const [time, y, expected] of [
    [200, 500, "474px"],
    [400, 300, "274px"],
    [600, 60, "34px"],
  ] as const) {
    now = time;
    fireEvent.pointerMove(handle, { clientY: y });
    expect(sheet.style.getPropertyValue("--sheet-drag")).toBe(expected);
  }
  expect(geometry).toHaveBeenCalledOnce();
  expect(onRender).toHaveBeenCalledOnce();
  expect(onSnap).not.toHaveBeenCalled();
  now = 800;
  fireEvent.pointerUp(handle, { clientY: 60 });
  expect(onSnap).toHaveBeenCalledExactlyOnceWith("expanded");
  expect(sheet).toHaveAttribute("data-snap", "expanded");
  fireEvent.click(handle); // The synthetic click following a swipe must not snap again.
  expect(onSnap).toHaveBeenCalledOnce();
  await waitFor(() => expect(sheet).not.toHaveAttribute("data-sheet-preview"));
  expect(sheet.style.transition).toBe("");
  expect(sheet.style.getPropertyValue("--sheet-drag")).toBe("");
});

it("accepts a light short flick and cleans up a cancelled gesture without changing its snap", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const onSnap = vi.fn();
  render(<Harness onSnap={onSnap} />);
  const sheet = screen.getByTestId("sheet");
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  fireEvent.pointerDown(handle, { clientY: 600 });
  now = 20;
  fireEvent.pointerMove(handle, { clientY: 580 });
  now = 35;
  fireEvent.pointerUp(handle, { clientY: 580 });
  expect(onSnap).toHaveBeenCalledExactlyOnceWith("half");
  await waitFor(() => expect(sheet).not.toHaveAttribute("data-sheet-preview"));
  fireEvent.pointerDown(handle, { clientY: 400 });
  now = 100;
  fireEvent.pointerMove(handle, { clientY: 650 });
  fireEvent.pointerCancel(handle, { clientY: 650 });
  await waitFor(() => expect(sheet).not.toHaveAttribute("data-sheet-preview"));
  expect(sheet).toHaveAttribute("data-snap", "half");
  expect(onSnap).toHaveBeenCalledOnce();
  expect(sheet.style.getPropertyValue("--sheet-drag")).toBe("");
  expect(sheet.style.transition).toBe("");
  fireEvent.keyDown(handle, { key: "End" });
  expect(sheet).toHaveAttribute("data-snap", "expanded");
});
