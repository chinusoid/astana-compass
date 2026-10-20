import { expect, it } from "vitest";
import { sheetDragOffset, sheetSnapIndex } from "./sheet-gesture";

const heights = [132, 456, 766];
it("uses travel and recent velocity to distinguish a tap, a short flick and a long pull", () => {
  expect(sheetSnapIndex(heights, 132, -4, 0)).toBe(0);
  expect(sheetSnapIndex(heights, 132, -20, -0.6)).toBe(1);
  expect(sheetSnapIndex(heights, 132, -110, -8)).toBe(1);
  expect(sheetSnapIndex(heights, 132, -180, -3)).toBe(2);
  expect(sheetSnapIndex(heights, 132, -600, 0)).toBe(2);
  expect(sheetSnapIndex(heights, 766, 600, 0)).toBe(0);
  expect(sheetSnapIndex(heights, 456, 60, 0)).toBe(0);
});
it("tracks one-to-one throughout the available travel, with resistance only at its edges", () => {
  expect(sheetDragOffset(180, 634)).toBe(180);
  expect(sheetDragOffset(530, 634)).toBe(530);
  expect(sheetDragOffset(-100, 634)).toBe(-18);
  expect(sheetDragOffset(734, 634)).toBe(652);
});
