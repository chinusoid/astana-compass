/** Retry temporary positioning errors without flashing a false terminal error. */
export function requestLocation(
  geolocation: Geolocation,
  success: PositionCallback,
  failure: PositionErrorCallback,
): () => void {
  let cancelled = false;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (retry: boolean) => {
    geolocation.getCurrentPosition(
      (position) => {
        if (cancelled || completed) return;
        completed = true;
        clearTimeout(timer);
        success(position);
      },
      (error) => {
        if (cancelled || completed) return;
        // Permission denial is final. Position unavailable/timeouts often
        // precede a usable Wi-Fi/GPS fix, so keep the loading state for a retry.
        if (error.code !== 1 && retry) {
          timer = setTimeout(() => {
            if (!cancelled && !completed) attempt(false);
          }, 800);
        } else {
          completed = true;
          failure(error);
        }
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: retry ? 60000 : 0,
      },
    );
  };
  attempt(true);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
