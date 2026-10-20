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
    <div className="app-shell" data-testid="shell">
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
    </div>
  );
}
function pointer(target: Element | Document, type: string, y: number, id = 7) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: id });
  fireEvent(target, event);
  return event;
}
it("owns accepted primary input without native dragging and preserves focus and unrelated input", () => {
  vi.stubGlobal("innerHeight", 844);
  render(<Harness />);
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  const focus = vi.spyOn(handle, "focus");
  const right = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 2,
  });
  fireEvent(handle, right);
  expect(right.defaultPrevented).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  const secondary = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  Object.defineProperty(secondary, "isPrimary", { value: false });
  fireEvent(handle, secondary);
  expect(secondary.defaultPrevented).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  const accepted = pointer(handle, "pointerdown", 660);
  expect(accepted.defaultPrevented).toBe(true);
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(handle).toHaveFocus();
  expect(handle).toHaveAttribute("draggable", "false");
  const nativeDrag = new Event("dragstart", {
    bubbles: true,
    cancelable: true,
  });
  fireEvent(handle, nativeDrag);
  expect(nativeDrag.defaultPrevented).toBe(true);
  pointer(document, "pointercancel", 660);
});
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
  fireEvent.click(handle, { detail: 1 }); // The pointer click following a swipe must not snap again.
  expect(onSnap).toHaveBeenCalledOnce();
  await waitFor(() => expect(sheet).not.toHaveAttribute("data-sheet-preview"));
  expect(sheet.style.transition).toBe("");
  expect(sheet.style.getPropertyValue("--sheet-drag")).toBe("");
});

it("captures the stable shell and completes one document stream while the sheet translates", async () => {
  vi.stubGlobal("innerHeight", 844);
  const onSnap = vi.fn();
  render(<Harness onSnap={onSnap} />);
  const shell = screen.getByTestId("shell");
  const sheet = screen.getByTestId("sheet");
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  let held = false;
  const capture = vi.fn(() => {
    held = true;
  });
  const release = vi.fn(() => {
    held = false;
    pointer(shell, "lostpointercapture", 0);
  });
  Object.assign(shell, {
    setPointerCapture: capture,
    hasPointerCapture: () => held,
    releasePointerCapture: release,
  });
  const movingCapture = vi.fn();
  Object.assign(handle, { setPointerCapture: movingCapture });
  pointer(handle, "pointerdown", 660);
  expect(capture).toHaveBeenCalledExactlyOnceWith(7);
  expect(movingCapture).not.toHaveBeenCalled();
  expect(shell).not.toHaveAttribute("data-sheet-preview");
  expect(sheet).toHaveAttribute("data-sheet-preview");
  // Transferring implicit touch capture from the handle must not cancel the new shell capture.
  pointer(handle, "lostpointercapture", 660);
  expect(sheet).toHaveAttribute("data-sheet-dragging");
  pointer(document, "pointermove", 200, 8); // An unrelated pointer cannot move or finish it.
  pointer(document, "pointerup", 200, 8);
  expect(sheet.style.getPropertyValue("--sheet-drag")).toBe("634px");
  pointer(document, "pointermove", 300);
  expect(sheet.style.getPropertyValue("--sheet-drag")).toBe("274px");
  pointer(shell, "pointermove", 60);
  pointer(document, "pointerup", 60);
  expect(onSnap).toHaveBeenCalledExactlyOnceWith("expanded");
  expect(release).toHaveBeenCalledOnce();
  pointer(document, "pointerup", 60);
  expect(onSnap).toHaveBeenCalledOnce();
  await waitFor(() => expect(sheet).not.toHaveAttribute("data-sheet-preview"));
});

it("completes ancestor-targeted taps once and keeps the next keyboard click active", () => {
  vi.stubGlobal("innerHeight", 844);
  const onSnap = vi.fn();
  render(<Harness onSnap={onSnap} />);
  const shell = screen.getByTestId("shell");
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  pointer(handle, "pointerdown", 660);
  pointer(shell, "pointerup", 660);
  fireEvent.click(shell, { detail: 1 });
  expect(onSnap).toHaveBeenCalledExactlyOnceWith("half");
  fireEvent.click(handle, { detail: 0 });
  expect(onSnap).toHaveBeenLastCalledWith("expanded");
  expect(onSnap).toHaveBeenCalledTimes(2);
  pointer(handle, "pointerdown", 100);
  pointer(handle, "pointerup", 100);
  fireEvent.click(handle, { detail: 1 });
  expect(onSnap).toHaveBeenCalledTimes(3);
  expect(onSnap).toHaveBeenLastCalledWith("collapsed");
});

it("releases stable capture and document handlers on cancellation, interruption and unmount", async () => {
  vi.stubGlobal("innerHeight", 844);
  const onSnap = vi.fn();
  const { unmount } = render(<Harness onSnap={onSnap} />);
  const shell = screen.getByTestId("shell");
  const sheet = screen.getByTestId("sheet");
  const handle = screen.getByRole("button", { name: "Panel size: Collapsed" });
  const release = vi.fn();
  Object.assign(shell, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: release,
  });
  const remove = vi.spyOn(document, "removeEventListener");
  pointer(handle, "pointerdown", 660);
  pointer(document, "pointermove", 300);
  pointer(document, "pointercancel", 300);
  expect(release).toHaveBeenCalledOnce();
  expect(onSnap).not.toHaveBeenCalled();
  await waitFor(() => expect(sheet).not.toHaveAttribute("data-sheet-preview"));
  pointer(handle, "pointerdown", 660);
  fireEvent.keyDown(handle, { key: "End" });
  expect(release).toHaveBeenCalledTimes(2);
  pointer(document, "pointerup", 60);
  expect(onSnap).toHaveBeenCalledExactlyOnceWith("expanded");
  pointer(handle, "pointerdown", 100);
  unmount();
  expect(release).toHaveBeenCalledTimes(3);
  for (const type of [
    "pointermove",
    "pointerup",
    "pointercancel",
    "lostpointercapture",
  ])
    expect(remove).toHaveBeenCalledWith(type, expect.any(Function), true);
  pointer(document, "pointermove", 600);
  pointer(document, "pointerup", 600);
  expect(onSnap).toHaveBeenCalledOnce();
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
