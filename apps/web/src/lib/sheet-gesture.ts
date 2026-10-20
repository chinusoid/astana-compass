/** Project recent finger velocity, then settle on a real sheet detent. */
export const SHEET_SETTLED_EVENT = "astana-sheet-settled";

export function sheetSnapIndex(
  heights: number[],
  startHeight: number,
  deltaY: number,
  velocityY: number,
) {
  const closest = (height: number) =>
    heights.reduce(
      (best, value, index) =>
        Math.abs(value - height) < Math.abs(heights[best] - height)
          ? index
          : best,
      0,
    );
  const from = closest(startHeight);
  const momentumLimit = Math.min(520, Math.abs(deltaY) * 2.5 + 80);
  const projected =
    startHeight -
    deltaY -
    Math.max(-momentumLimit, Math.min(momentumLimit, velocityY * 180));
  const target = closest(projected);
  // A deliberate short pull or flick should not need half a screen of travel.
  const flick = Math.abs(velocityY) >= 0.45 && Math.abs(deltaY) >= 8;
  if (target === from && (Math.abs(deltaY) >= 48 || flick)) {
    const direction = (flick ? velocityY : deltaY) < 0 ? 1 : -1;
    return Math.max(0, Math.min(heights.length - 1, from + direction));
  }
  return target;
}

/** Gentle resistance only beyond the available sheet travel. */
export function sheetDragOffset(offset: number, maximum: number) {
  if (offset < 0) return -Math.min(48, -offset * 0.18);
  if (offset > maximum)
    return maximum + Math.min(48, (offset - maximum) * 0.18);
  return offset;
}
