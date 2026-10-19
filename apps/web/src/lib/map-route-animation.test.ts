import { afterEach, expect, it, vi } from "vitest";
import type { Map as LibreMap } from "maplibre-gl";
import { animateJourney, fitJourney } from "./map-route";

afterEach(() => vi.unstubAllGlobals());
const geometry = {
  type: "LineString" as const,
  coordinates: [
    [71.43, 51.12],
    [71.432, 51.12],
  ] as [number, number][],
};
function fixture(reduced = false) {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  let preferenceChange = () => {};
  const preference = {
    matches: reduced,
    addEventListener: vi.fn((_event, listener) => {
      preferenceChange = listener;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => preference),
  );
  const request = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const setData = vi.fn();
  const map = { getSource: vi.fn(() => ({ setData })), fitBounds: vi.fn() };
  return {
    map: map as unknown as LibreMap,
    setData,
    request,
    cancel,
    frames,
    preference,
    preferenceChange: () => preferenceChange(),
  };
}

it("reveals the real path once, finishes it and removes its preference listener", () => {
  const test = fixture();
  const complete = vi.fn();
  animateJourney(test.map, geometry, [], false, complete);
  expect(test.setData.mock.calls[0][0].features).toEqual([]);
  test.frames.get(1)!(100);
  test.frames.get(2)!(575);
  const partial =
    test.setData.mock.calls.at(-2)![0].features[0].geometry.coordinates;
  expect(partial.at(-1)[0]).toBeGreaterThan(71.43);
  expect(partial.at(-1)[0]).toBeLessThan(71.432);
  test.frames.get(3)!(1050);
  expect(complete).toHaveBeenCalledOnce();
  expect(test.setData.mock.calls.at(-2)![0].features[0].geometry).toEqual(
    geometry,
  );
  expect(test.preference.removeEventListener).toHaveBeenCalled();
});

it("cancels stale frames when replaced and never completes a removed route", () => {
  const test = fixture();
  const complete = vi.fn();
  const stop = animateJourney(test.map, geometry, [], false, complete);
  const stale = test.frames.get(1)!;
  stop();
  const count = test.setData.mock.calls.length;
  stale(1000);
  expect(test.setData).toHaveBeenCalledTimes(count);
  expect(test.cancel).toHaveBeenCalledWith(1);
  expect(complete).not.toHaveBeenCalled();
});

it("honours reduced motion for reveal and camera, including preference changes mid-animation", () => {
  const test = fixture(true);
  const complete = vi.fn();
  animateJourney(test.map, geometry, [], false, complete);
  expect(test.request).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
  fitJourney(test.map, geometry, [], true);
  expect(test.map.fitBounds).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: 0 }),
  );
  const changed = fixture();
  const changedComplete = vi.fn();
  animateJourney(changed.map, geometry, [], false, changedComplete);
  changed.preference.matches = true;
  changed.preferenceChange();
  expect(changedComplete).toHaveBeenCalledOnce();
  expect(changed.cancel).toHaveBeenCalledWith(1);
});
