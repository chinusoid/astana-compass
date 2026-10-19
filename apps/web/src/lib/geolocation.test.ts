import { afterEach, expect, it, vi } from "vitest";
import { requestLocation } from "./geolocation";
afterEach(() => vi.useRealTimers());
it("keeps temporary failure pending, retries and accepts a late usable fix only once", () => {
  vi.useFakeTimers();
  const success = vi.fn(),
    failure = vi.fn();
  const attempts: Array<{ ok: PositionCallback; fail: PositionErrorCallback }> =
    [];
  const geo = {
    getCurrentPosition: vi.fn((ok, fail) => attempts.push({ ok, fail })),
  } as unknown as Geolocation;
  requestLocation(geo, success, failure);
  attempts[0].fail({ code: 2 } as GeolocationPositionError);
  expect(failure).not.toHaveBeenCalled();
  vi.advanceTimersByTime(800);
  expect(attempts).toHaveLength(2);
  const fix = {
    coords: { latitude: 51.1, longitude: 71.4 },
  } as GeolocationPosition;
  attempts[0].ok(fix);
  attempts[1].fail({ code: 3 } as GeolocationPositionError);
  attempts[1].ok(fix);
  expect(success).toHaveBeenCalledExactlyOnceWith(fix);
  expect(failure).not.toHaveBeenCalled();
});
it("does not retry denied permission and cancels stale retries after a manual edit", () => {
  vi.useFakeTimers();
  const ok = vi.fn(),
    fail = vi.fn();
  let reject!: PositionErrorCallback;
  const getCurrentPosition = vi.fn((_ok, error) => {
    reject = error;
  });
  requestLocation({ getCurrentPosition } as unknown as Geolocation, ok, fail);
  const denied = { code: 1 } as GeolocationPositionError;
  reject(denied);
  expect(fail).toHaveBeenCalledExactlyOnceWith(denied);
  vi.runAllTimers();
  expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  const cancel = requestLocation(
    { getCurrentPosition } as unknown as Geolocation,
    ok,
    fail,
  );
  reject({ code: 2 } as GeolocationPositionError);
  cancel();
  vi.runAllTimers();
  expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  expect(ok).not.toHaveBeenCalled();
});
