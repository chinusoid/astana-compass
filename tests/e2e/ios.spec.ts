import {
  test,
  expect,
  type Page,
  type ItineraryRequest,
  type ItineraryResponse,
} from "../../apps/web/e2e-support";
import { t } from "../../apps/web/src/lib/i18n";

const sheet = (page: Page) => page.locator(".app-shell");
const handle = (page: Page) => page.locator("[data-sheet-handle]");

async function activate(control: ReturnType<Page["locator"]>, touch: boolean) {
  if (touch) await control.tap();
  else await control.click();
}

async function settled(page: Page) {
  await expect(page.locator("[data-mobile-sheet]")).not.toHaveAttribute(
    "data-sheet-preview",
  );
  // A normal tap changes the snap before its CSS height transition finishes.
  // Raw mouse coordinates do not get locator actionability/stability checks.
  const target = await handle(page).elementHandle();
  expect(target).not.toBeNull();
  await target!.waitForElementState("stable");
}

async function dragSheet(page: Page, target: "expanded" | "collapsed") {
  await settled(page);
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const start = box.y + box.height / 2;
  const end = target === "expanded" ? 16 : page.viewportSize()!.height - 80;
  // Only the desktop WebKit phone-viewport profile uses native mouse drags.
  // Playwright's public touchscreen API supports taps, not finger dragging.
  await page.mouse.move(x, start);
  await page.mouse.down();
  await expect(page.locator("[data-mobile-sheet]")).toHaveAttribute(
    "data-sheet-dragging",
    "true",
  );
  // WebKit acknowledges batched input before compositing the moved capture
  // target. Advance native input across real frames, as a user's drag does.
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(x, start + ((end - start) * step) / 10);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
  await page.mouse.up();
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", target);
  await settled(page);
}

async function changeSheet(
  page: Page,
  target: "expanded" | "collapsed",
  touch: boolean,
) {
  if (!touch) return dragSheet(page, target);
  await settled(page);
  if (target === "expanded") {
    if ((await sheet(page).getAttribute("data-sheet-snap")) === "collapsed") {
      await handle(page).tap();
      await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "half");
      await settled(page);
    }
    await handle(page).tap();
  } else {
    await page.getByRole("button", { name: "К карте", exact: true }).tap();
  }
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", target);
  await settled(page);
}

async function openPlanner(page: Page, touch: boolean) {
  await activate(
    page.getByRole("link", { name: "Открыть планирование" }),
    touch,
  );
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "expanded");
  await expect(page.locator('textarea[name="query"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const events: object[] = [];
    Object.assign(window, { __iosGestureEvents: events });
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "gotpointercapture",
      "lostpointercapture",
    ]) {
      document.addEventListener(
        type,
        (entry) => {
          const event = entry as PointerEvent;
          const panel = document.querySelector<HTMLElement>(
            "[data-mobile-sheet]",
          );
          if (events.length >= 80) events.shift();
          events.push({
            type,
            pointer: event.pointerId,
            kind: event.pointerType,
            y: event.clientY,
            buttons: event.buttons,
            primary: event.isPrimary,
            trusted: event.isTrusted,
            preview: panel?.hasAttribute("data-sheet-preview"),
            offset: panel?.style.getPropertyValue("--sheet-drag"),
          });
        },
        { capture: true },
      );
    }
  });
  await page.goto("/walk");
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const events = await page.evaluate(
      () =>
        (window as Window & { __iosGestureEvents?: object[] })
          .__iosGestureEvents ?? [],
    );
    await testInfo.attach("ios-native-pointer-events", {
      body: JSON.stringify(events),
      contentType: "application/json",
    });
  }
});

test("WebKit phone layout supports every sheet snap with its native input controls", async ({
  page,
  hasTouch,
}, testInfo) => {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  if (hasTouch) expect(userAgent).toContain("iPhone");
  else expect(userAgent).not.toContain("iPhone");
  await page.evaluate(() => {
    document.addEventListener(
      "touchstart",
      (event) => {
        if (event.isTrusted)
          document.documentElement.dataset.trustedTouch = "true";
      },
      { once: true, capture: true },
    );
  });
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "collapsed");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-map-status",
    "ready",
  );
  const target = (await handle(page).boundingBox())!;
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(
    (await page.locator("[data-mobile-sheet]").boundingBox())!.height,
  ).toBeCloseTo(132, 0);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );

  await activate(handle(page), hasTouch);
  if (hasTouch)
    await expect(page.locator("html")).toHaveAttribute(
      "data-trusted-touch",
      "true",
    );
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "half");
  await settled(page);
  await changeSheet(page, "expanded", hasTouch);
  await changeSheet(page, "collapsed", hasTouch);
  await openPlanner(page, hasTouch);
  expect(
    await page
      .locator('textarea[name="query"]')
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      ),
  ).toBeGreaterThanOrEqual(16);
  await activate(
    page.getByRole("button", { name: "К карте", exact: true }),
    hasTouch,
  );
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "collapsed");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await testInfo.attach("iphone-webkit-sheet", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("WebKit phone layout preserves a routed fixture walk through sheet controls and explicit edits", async ({
  page,
  hasTouch,
}, testInfo) => {
  const requests: ItineraryRequest[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/itineraries") && request.method() === "POST")
      requests.push(request.postDataJSON() as ItineraryRequest);
  });
  await page.route("**/api/v1/itineraries", async (intercept) => {
    const actual = await intercept.fetch();
    const payload = (await actual.json()) as ItineraryResponse;
    expect(actual.headers()["x-astana-data-mode"]).toBe("fixture");
    expect(payload.route).not.toBeNull();
    const origin = payload.request.origin;
    const coordinates: [number, number][] = [
      [origin.lon, origin.lat],
      ...payload.stops.map((stop): [number, number] => {
        const point = payload.places.find(
          (place) => place.id === stop.place_id,
        )!.location;
        return [point.lon, point.lat];
      }),
    ];
    if (payload.request.return_to_origin)
      coordinates.push([origin.lon, origin.lat]);
    // This explicitly synthetic geometry exercises WebKit's line renderer.
    // It does not represent a provider-confirmed walking path.
    payload.route!.method = "routed";
    payload.route!.provider = "synthetic:ios-route-renderer";
    payload.route!.geometry = { type: "LineString", coordinates };
    await intercept.fulfill({ response: actual, json: payload });
  });
  await openPlanner(page, hasTouch);
  const advanced = page.locator("details.advanced-origin");
  await activate(advanced.locator("summary"), hasTouch);
  await page.locator('textarea[name="query"]').fill("Прогулка без спешки");
  await page.locator('input[name="latitude"]').fill("51.090");
  await page.locator('input[name="longitude"]').fill("71.420");
  await activate(advanced.getByRole("button"), hasTouch);
  await activate(page.locator(".filter-toggle"), hasTouch);
  await page.locator('input[name="start"]').fill("2026-10-19T12:00");
  await page.locator('input[name="minutes"]').fill("180");
  const response = page.waitForResponse(
    (entry) =>
      entry.url().endsWith("/itineraries") &&
      entry.request().method() === "POST",
  );
  await activate(page.locator(".find-button"), hasTouch);
  const built = await response;
  expect(built.ok()).toBe(true);
  expect(built.headers()["x-astana-data-mode"]).toBe("fixture");
  const route = (await built.json()) as ItineraryResponse;
  expect(route.stops).toHaveLength(3);
  expect(route.route).not.toBeNull();
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "collapsed");
  await expect(handle(page)).toBeFocused();
  await expect(page.getByTestId("map-journey-summary")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-map-status",
    "ready",
  );
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "routed",
  );
  const names = await page
    .getByTestId("selected-stops")
    .locator("li strong")
    .allTextContents();
  const originalPlan = await page.locator(".itinerary-result").textContent();
  const ids = requests[0].place_ids;

  await changeSheet(page, "expanded", hasTouch);
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "routed",
  );
  await expect(
    page.getByTestId("selected-stops").locator("li strong"),
  ).toHaveText(names);
  expect(await page.locator(".itinerary-result").textContent()).toBe(
    originalPlan,
  );
  await changeSheet(page, "collapsed", hasTouch);
  await openPlanner(page, hasTouch);
  expect(requests).toHaveLength(1);
  await expect(page.locator('textarea[name="query"]')).toHaveValue(
    "Прогулка без спешки",
  );
  await expect(page.locator('input[name="latitude"]')).toHaveValue("51.090");
  await expect(page.locator('input[name="longitude"]')).toHaveValue("71.420");
  await expect(page.locator('input[name="minutes"]')).toHaveValue("180");
  await page.locator('input[name="minutes"]').fill("210");
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "none",
  );
  await expect(
    page.getByTestId("selected-stops").locator("li strong"),
  ).toHaveText(names);
  const rebuilt = page.waitForResponse(
    (entry) =>
      entry.url().endsWith("/itineraries") &&
      entry.request().method() === "POST",
  );
  await activate(
    page
      .locator(".journey")
      .getByRole("button", { name: t("ru", "buildPlan"), exact: true }),
    hasTouch,
  );
  expect((await rebuilt).ok()).toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[1].place_ids).toEqual(ids);
  expect(requests[1].available_seconds).toBe(210 * 60);
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "collapsed");
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "routed",
  );
  await openPlanner(page, hasTouch);
  await expect(
    page.getByTestId("selected-stops").locator("li strong"),
  ).toHaveText(names);
  await expect(page.locator('input[name="minutes"]')).toHaveValue("210");
  await testInfo.attach("iphone-webkit-walk", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("a simulated keyboard viewport resize keeps the focused wish and search visible", async ({
  page,
  hasTouch,
}) => {
  // Viewport resizing checks responsive layout only. This is not a physical
  // iOS keyboard/finger-drag test; those require a real device.
  const original = page.viewportSize()!;
  await openPlanner(page, hasTouch);
  const query = page.locator('textarea[name="query"]');
  await query.fill("Хочу в музей и на кофе");
  await expect(query).toBeFocused();
  await page.setViewportSize({ width: original.width, height: 420 });
  await expect(sheet(page)).toHaveAttribute("data-keyboard-open", "true");
  await expect(query).toBeFocused();
  await expect(query).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".find-button")).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await query.evaluate((element) => element.blur());
  await page.setViewportSize(original);
  await expect(query).toHaveValue("Хочу в музей и на кофе");
  await expect(query).toBeVisible();
  await expect(handle(page)).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
