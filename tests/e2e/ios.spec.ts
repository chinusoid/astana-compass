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

async function settled(page: Page) {
  await expect(page.locator("[data-mobile-sheet]")).not.toHaveAttribute(
    "data-sheet-preview",
  );
}

async function dragSheet(page: Page, target: "expanded" | "collapsed") {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const end = target === "expanded" ? 16 : page.viewportSize()!.height - 80;
  // Playwright's public touchscreen API supports taps only. Native pointer
  // dragging exercises the same sheet path in WebKit without synthetic capture.
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, end, { steps: 10 });
  await page.mouse.up();
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", target);
  await settled(page);
}

async function openPlanner(page: Page) {
  await page.getByRole("link", { name: "Открыть планирование" }).tap();
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "expanded");
  await expect(page.locator('textarea[name="query"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/walk");
});

test("iPhone WebKit accepts touch controls and smooth sheet pointer gestures", async ({
  page,
}, testInfo) => {
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(
    0,
  );
  expect(await page.evaluate(() => navigator.userAgent)).toContain("iPhone");
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

  await handle(page).tap();
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "half");
  await settled(page);
  await dragSheet(page, "expanded");
  await dragSheet(page, "collapsed");
  await openPlanner(page);
  expect(
    await page
      .locator('textarea[name="query"]')
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      ),
  ).toBeGreaterThanOrEqual(16);
  await page.getByRole("button", { name: "К карте", exact: true }).tap();
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

test("iPhone WebKit builds a fixture walk and preserves it through gestures and explicit edits", async ({
  page,
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
  await openPlanner(page);
  const advanced = page.locator("details.advanced-origin");
  await advanced.locator("summary").tap();
  await page.locator('textarea[name="query"]').fill("Прогулка без спешки");
  await page.locator('input[name="latitude"]').fill("51.090");
  await page.locator('input[name="longitude"]').fill("71.420");
  await advanced.getByRole("button").tap();
  await page.locator(".filter-toggle").tap();
  await page.locator('input[name="start"]').fill("2026-10-19T12:00");
  await page.locator('input[name="minutes"]').fill("180");
  const response = page.waitForResponse(
    (entry) =>
      entry.url().endsWith("/itineraries") &&
      entry.request().method() === "POST",
  );
  await page.locator(".find-button").tap();
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

  await dragSheet(page, "expanded");
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
  await dragSheet(page, "collapsed");
  await openPlanner(page);
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
  await page
    .locator(".journey")
    .getByRole("button", { name: t("ru", "buildPlan"), exact: true })
    .tap();
  expect((await rebuilt).ok()).toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[1].place_ids).toEqual(ids);
  expect(requests[1].available_seconds).toBe(210 * 60);
  await expect(sheet(page)).toHaveAttribute("data-sheet-snap", "collapsed");
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "routed",
  );
  await openPlanner(page);
  await expect(
    page.getByTestId("selected-stops").locator("li strong"),
  ).toHaveText(names);
  await expect(page.locator('input[name="minutes"]')).toHaveValue("210");
  await testInfo.attach("iphone-webkit-walk", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
