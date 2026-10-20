export const LOCATION_TIMEOUT_MS = 20_000;

/** Keep temporary positioning errors pending for one bounded acquisition window. */
export function requestLocation(
  geolocation: Geolocation,
  success: PositionCallback,
  failure: PositionErrorCallback,
): () => void {
  let cancelled = false;
  let completed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastError: GeolocationPositionError | undefined;
  let retryDelay = 800;
  let firstAttempt = true;
  const deadline = Date.now() + LOCATION_TIMEOUT_MS;
  const clearTimers = () => {
    clearTimeout(retryTimer);
    clearTimeout(deadlineTimer);
  };
  const finishError = (error: GeolocationPositionError) => {
    if (cancelled || completed) return;
    completed = true;
    clearTimers();
    failure(error);
  };
  const deadlineTimer = setTimeout(
    () =>
      finishError(
        lastError ?? {
          code: 3,
          message: "Location acquisition timed out",
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        },
      ),
    LOCATION_TIMEOUT_MS,
  );
  const attempt = () => {
    let failed = false;
    const maximumAge = firstAttempt ? 60_000 : 0;
    firstAttempt = false;
    geolocation.getCurrentPosition(
      (position) => {
        if (cancelled || completed) return;
        completed = true;
        clearTimers();
        success(position);
      },
      (error) => {
        if (cancelled || completed || failed) return;
        failed = true;
        lastError = error;
        // Permission denial is final. Position unavailable/timeouts often
        // precede a usable Wi-Fi/GPS fix, so keep the loading state for a retry.
        if (error.code === 1) finishError(error);
        else {
          retryTimer = setTimeout(() => {
            if (!cancelled && !completed) attempt();
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 4_000);
        }
      },
      {
        enableHighAccuracy: false,
        timeout: Math.max(1, Math.min(10_000, deadline - Date.now())),
        maximumAge,
      },
    );
  };
  attempt();
  return () => {
    cancelled = true;
    clearTimers();
  };
}
