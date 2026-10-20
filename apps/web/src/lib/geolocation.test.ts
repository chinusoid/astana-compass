import { afterEach, expect, it, vi } from "vitest";
import { LOCATION_TIMEOUT_MS, requestLocation } from "./geolocation";
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

it("keeps repeated temporary failures pending until the acquisition deadline", () => {
  vi.useFakeTimers();
  const success = vi.fn(),
    failure = vi.fn();
  const unavailable = { code: 2 } as GeolocationPositionError;
  const getCurrentPosition = vi.fn((_ok, fail: PositionErrorCallback) =>
    fail(unavailable),
  );
  requestLocation(
    { getCurrentPosition } as unknown as Geolocation,
    success,
    failure,
  );
  vi.advanceTimersByTime(2_400);
  expect(getCurrentPosition).toHaveBeenCalledTimes(3);
  expect(failure).not.toHaveBeenCalled();
  vi.advanceTimersByTime(LOCATION_TIMEOUT_MS - 2_401);
  expect(failure).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(failure).toHaveBeenCalledExactlyOnceWith(unavailable);
  const attempts = getCurrentPosition.mock.calls.length;
  vi.runAllTimers();
  expect(getCurrentPosition).toHaveBeenCalledTimes(attempts);
  expect(success).not.toHaveBeenCalled();
});

it("bounds an unanswered browser request and ignores callbacks after timeout or cancellation", () => {
  vi.useFakeTimers();
  const success = vi.fn(),
    failure = vi.fn();
  let accept!: PositionCallback;
  let reject!: PositionErrorCallback;
  const geo = {
    getCurrentPosition: vi.fn((ok, fail) => {
      accept = ok;
      reject = fail;
    }),
  } as unknown as Geolocation;
  requestLocation(geo, success, failure);
  vi.advanceTimersByTime(LOCATION_TIMEOUT_MS);
  expect(failure).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: 3 }),
  );
  accept({
    coords: { latitude: 51.1, longitude: 71.4 },
  } as GeolocationPosition);
  reject({ code: 1 } as GeolocationPositionError);
  expect(success).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledTimes(1);
  const cancel = requestLocation(geo, success, failure);
  cancel();
  accept({
    coords: { latitude: 51.1, longitude: 71.4 },
  } as GeolocationPosition);
  reject({ code: 2 } as GeolocationPositionError);
  vi.runAllTimers();
  expect(success).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledTimes(1);
});

it("accepts a fix after multiple failures and clears its pending deadline", () => {
  vi.useFakeTimers();
  const success = vi.fn(),
    failure = vi.fn();
  let attempts = 0;
  const fix = {
    coords: { latitude: 51.1, longitude: 71.4 },
  } as GeolocationPosition;
  const getCurrentPosition = vi.fn<
    (
      ok: PositionCallback,
      fail: PositionErrorCallback,
      options?: PositionOptions,
    ) => void
  >((ok, fail) => {
    if (++attempts < 3) fail({ code: 2 } as GeolocationPositionError);
    else ok(fix);
  });
  requestLocation(
    { getCurrentPosition } as unknown as Geolocation,
    success,
    failure,
  );
  vi.advanceTimersByTime(2_400);
  expect(success).toHaveBeenCalledExactlyOnceWith(fix);
  expect(getCurrentPosition.mock.calls[0][2]).toMatchObject({
    maximumAge: 60_000,
  });
  expect(getCurrentPosition.mock.calls[1][2]).toMatchObject({ maximumAge: 0 });
  vi.runAllTimers();
  expect(failure).not.toHaveBeenCalled();
});
