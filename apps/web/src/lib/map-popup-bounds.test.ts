import { expect, it, vi } from "vitest";
import type { Map as LibreMap, Popup } from "maplibre-gl";
import { keepPopupInMap } from "./map-popup-bounds";

it("keeps a 330px card readable in a 428px map, follows movement and removes listeners", () => {
  const element = document.createElement("div");
  const container = document.createElement("div");
  let nativeLeft = 602;
  let mapRight = 870;
  element.getBoundingClientRect = () => {
    const left = nativeLeft + (parseFloat(element.style.translate) || 0);
    return { left, right: left + 330, width: 330 } as DOMRect;
  };
  container.getBoundingClientRect = () =>
    ({ left: 442, right: mapRight, width: mapRight - 442 }) as DOMRect;
  const events = new Map<string, Set<() => void>>();
  const popupEvents = new Map<string, () => void>();
  const map = {
    getContainer: () => container,
    on: (name: string, handler: () => void) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(handler);
    },
    off: (name: string, handler: () => void) =>
      events.get(name)?.delete(handler),
    fitBounds: vi.fn(),
    easeTo: vi.fn(),
  };
  const popup = {
    getElement: () => element,
    on: (name: string, handler: () => void) => popupEvents.set(name, handler),
  };
  keepPopupInMap(map as unknown as LibreMap, popup as unknown as Popup);
  popupEvents.get("open")!();
  expect(element.getBoundingClientRect()).toMatchObject({
    left: 528,
    right: 858,
    width: 330,
  });
  expect(element.hasAttribute("data-horizontal-clamp")).toBe(true);
  // A second layout pass must not undo or accumulate the correction.
  events.get("idle")!.forEach((handler) => handler());
  expect(element.getBoundingClientRect().right).toBe(858);
  nativeLeft = 400;
  events.get("move")!.forEach((handler) => handler());
  expect(element.getBoundingClientRect().left).toBe(454);
  nativeLeft = 550;
  mapRight = 1000;
  events.get("resize")!.forEach((handler) => handler());
  expect(element.getBoundingClientRect().left).toBe(550);
  expect(element.hasAttribute("data-horizontal-clamp")).toBe(false);
  expect(map.fitBounds).not.toHaveBeenCalled();
  expect(map.easeTo).not.toHaveBeenCalled();
  popupEvents.get("close")!();
  expect([...events.values()].every((handlers) => handlers.size === 0)).toBe(
    true,
  );
  popupEvents.get("open")!();
  expect(events.get("move")!.size).toBe(1);
  popupEvents.get("close")!();
});
