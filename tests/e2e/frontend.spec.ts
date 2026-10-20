import {
  test,
  expect,
  AxeBuilder,
  generationFault,
  type Page,
  type RecommendationRequest,
  type RecommendationResponse,
  type ItineraryResponse,
} from "../../apps/web/e2e-support";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { t } from "../../apps/web/src/lib/i18n";
import type {
  IntentResponse,
  SocialState,
  SocialActionRequest,
} from "../../packages/api_client/src/generated";

const results = (page: Page) => page.locator(".results");
const cards = (page: Page) => results(page).getByTestId("place-card");
async function openFilters(page: Page) {
  const toggle = page.locator(".filter-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await expect(page.locator("#walk-filters")).toBeVisible();
}
async function manualStart(page: Page, query = "Прогулка без спешки") {
  if (!new URL(page.url()).pathname.startsWith("/walk")) {
    await page.getByRole("navigation").locator('a[href="/walk"]').click();
  }
  const mobileSearch = page.getByTestId("mobile-sheet-controls").locator("a");
  if (
    (await mobileSearch.isVisible()) &&
    (await page.locator(".app-shell").getAttribute("data-sheet-snap")) ===
      "collapsed"
  )
    await mobileSearch.click();
  const advanced = page.locator("details.advanced-origin");
  if ((await advanced.getAttribute("open")) === null)
    await advanced.locator("summary").click();
  await page.locator('textarea[name="query"]').fill(query);
  await page.locator('input[name="latitude"]').fill("51.090");
  await page.locator('input[name="longitude"]').fill("71.420");
  await advanced.getByRole("button").click();
}
async function fill(page: Page) {
  await manualStart(page);
  await openFilters(page);
  await page.locator('input[name="start"]').fill("2026-10-19T12:00");
  await page.locator('input[name="minutes"]').fill("90");
  // Return is now an explicit choice, rather than a hidden default.
  await page.locator('input[name="return"]').check();
}
async function search(page: Page) {
  await page.locator(".find-button").click();
  await expect(cards(page)).toHaveCount(3);
}
async function screenshot(page: Page, name: string) {
  if (!process.env.ASTANA_SCREENSHOT_DIR) return;
  await mkdir(process.env.ASTANA_SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.screenshot({
    path: path.join(process.env.ASTANA_SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
  });
}
test.beforeEach(async ({ page }) => {
  await page.goto("/walk");
});

test("mobile map keeps the route visible and preserves the planner through sheet gestures", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const shell = page.locator(".app-shell");
  const controls = page.getByTestId("mobile-sheet-controls");
  const handle = controls.locator("[data-sheet-handle]");
  await expect(shell).toHaveAttribute("data-sheet-snap", "collapsed");
  await expect(controls).toBeVisible();
  await expect(page.locator("#mobile-sheet-content")).toBeHidden();
  expect(
    (await page.locator(".app-map-stage").boundingBox())!.height,
  ).toBeGreaterThan(844 * 0.8);
  await screenshot(page, "mobile-map-collapsed");

  const handleBox = (await handle.boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 13);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 90, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(shell).toHaveAttribute("data-sheet-snap", "half");
  await handle.press("End");
  await expect(shell).toHaveAttribute("data-sheet-snap", "expanded");
  await handle.press("Home");
  await expect(shell).toHaveAttribute("data-sheet-snap", "collapsed");

  await fill(page);
  await expect(shell).toHaveAttribute("data-sheet-snap", "expanded");
  const response = page.waitForResponse(
    (entry) =>
      entry.url().endsWith("/itineraries") &&
      entry.request().method() === "POST",
  );
  await search(page);
  expect((await response).ok()).toBe(true);
  await expect(shell).toHaveAttribute("data-sheet-snap", "collapsed");
  await expect(handle).toBeFocused();
  await expect(page.locator(".journey-preview .journey-stop")).toHaveCount(3);
  await expect(page.getByTestId("map-journey-summary")).toBeVisible();
  await screenshot(page, "mobile-map-route");

  await controls.locator("a").click();
  await expect(shell).toHaveAttribute("data-sheet-snap", "expanded");
  await expect(page.locator('textarea[name="query"]')).toHaveValue(
    "Прогулка без спешки",
  );
  await expect(page.locator('input[name="latitude"]')).toHaveValue("51.090");
  await expect(page.locator('input[name="longitude"]')).toHaveValue("71.420");
  await expect(page.locator('input[name="minutes"]')).toHaveValue("90");
  await expect(page.locator('input[name="return"]')).toBeChecked();
  await expect(page.locator(".selected-stops > li")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await screenshot(page, "mobile-planner-expanded");
});

test("mobile route failure keeps the planner open with the wish and filters", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/itineraries", (route) => route.abort("failed"));
  await fill(page);
  await search(page);
  await expect(page.locator(".journey [role=alert]")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-sheet-snap",
    "expanded",
  );
  await expect(page.locator('textarea[name="query"]')).toHaveValue(
    "Прогулка без спешки",
  );
  await expect(page.locator('input[name="minutes"]')).toHaveValue("90");
  await expect(page.locator(".selected-stops > li")).toHaveCount(3);
});

test("optional route ideas stay separate until explicitly added", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let coreIds: string[] = [];
  let extraId = "";
  await page.route("**/api/v1/recommendations", async (route) => {
    const actual = await route.fetch();
    const response = (await actual.json()) as RecommendationResponse;
    expect(response.recommendations.length).toBeGreaterThanOrEqual(3);
    const core = response.recommendations.slice(0, 2);
    const extra = response.recommendations[2];
    coreIds = core.map((item) => item.place_id);
    extraId = extra.place_id;
    await route.fulfill({
      response: actual,
      json: {
        ...response,
        recommendations: core,
        places: response.places.filter((place) =>
          [...coreIds, extraId].includes(place.id),
        ),
        suggestions: [
          {
            place_id: extraId,
            why: "Дополнительная идея по данным каталога",
            suggested_activity: "Рассмотрите здание",
            constraint_evaluations: extra.constraint_evaluations,
          },
        ],
      },
    });
  });
  await fill(page);
  const initial = page.waitForRequest(
    (request) =>
      request.url().endsWith("/itineraries") && request.method() === "POST",
  );
  await page.locator(".find-button").click();
  expect((await initial).postDataJSON().place_ids).toEqual(coreIds);
  await expect(cards(page)).toHaveCount(2);
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-sheet-snap",
    "collapsed",
  );
  await page.getByRole("button", { name: "Идеи по пути: 1" }).click();
  const ideas = page.getByTestId("route-ideas");
  await expect(ideas.getByText("Предложение", { exact: true })).toBeVisible();
  const added = page.waitForRequest(
    (request) =>
      request.url().endsWith("/itineraries") &&
      request.method() === "POST" &&
      request.postDataJSON().place_ids.length === 3,
  );
  await ideas.getByRole("button", { name: /^Добавить в маршрут:/ }).click();
  expect((await added).postDataJSON().place_ids).toEqual([...coreIds, extraId]);
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-sheet-snap",
    "collapsed",
  );
  await page.getByRole("button", { name: "Идеи по пути: 1" }).click();
  await expect(
    ideas.getByRole("button", { name: /^Уже в маршруте:/ }),
  ).toBeDisabled();
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByTestId("selected-stops").locator("li")).toHaveCount(3);
});

test("walk starts without filters and searches without adding a return or time target", async ({
  page,
}) => {
  const toggle = page.getByRole("button", { name: "Фильтры", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-controls", "walk-filters");
  await expect(page.locator("#walk-filters")).toBeHidden();
  await expect(page.locator('input[name="minutes"]')).toHaveValue("");
  await expect(page.locator('input[name="return"]')).not.toBeChecked();
  await expect(page.locator(".filter-count")).toHaveCount(0);
  await expect(page.locator(".filter-summary")).toHaveText("Без фильтров");
  await manualStart(page, "Хочу посмотреть город");
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  await search(page);
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.available_seconds).toBe(86400);
  expect(request.return_to_origin).toBe(false);
  expect(request.constraints).toEqual([]);
  await expect(page.locator("#walk-filters")).toBeHidden();
  await expect(page.locator(".journey-preview .journey-stop")).toHaveCount(3);
});

test("the description supplies 90 minutes and the whole walk appears beside the map automatically", async ({
  page,
}) => {
  await manualStart(page, "Хочу погулять по городу 90 минут");
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  const itinerary = page.waitForRequest(
    (request) =>
      request.url().endsWith("/itineraries") && request.method() === "POST",
  );
  const itineraryResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/itineraries") &&
      response.request().method() === "POST",
  );
  await page.locator('textarea[name="query"]').press("Enter");
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.available_seconds).toBe(5400);
  expect(request.return_to_origin).toBe(false);
  expect((await itinerary).postDataJSON().place_ids).toHaveLength(3);
  const plan = (await (await itineraryResponse).json()) as ItineraryResponse;
  expect(plan.route?.method).toBe("approximate");
  expect(plan.stops).toHaveLength(3);
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('input[name="minutes"]')).toHaveValue("");
  await expect(page.locator(".intent-summary")).toContainText("90 мин");
  await expect(page.locator("#walk-filters")).toBeHidden();
  await expect(page.locator(".journey-preview .journey-stop")).toHaveCount(3);
  await expect(page.locator(".journey-preview")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".journey-preview-heading")).toContainText(
    "Все остановки на карте · путь пока не подтверждён",
  );
  await expect(page.getByTestId("map-journey-summary")).toBeVisible();
  await expect(page.getByTestId("map-panel")).toBeInViewport();
});

test("the map-side plan opens a readable side card and removes its middle destination", async ({
  page,
}) => {
  await fill(page);
  const itinerary = page.waitForRequest(
    (request) =>
      request.url().endsWith("/itineraries") && request.method() === "POST",
  );
  const itineraryResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/itineraries") &&
      response.request().method() === "POST",
  );
  await search(page);
  const originalIds = (await itinerary).postDataJSON().place_ids as string[];
  const plan = (await (await itineraryResponse).json()) as ItineraryResponse;
  expect(plan.route?.method).toBe("approximate");
  expect(plan.stops).toHaveLength(3);
  await expect(page.locator(".journey-preview")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".journey-preview-heading")).toContainText(
    "Все остановки на карте · путь пока не подтверждён",
  );
  const stopNames = await page
    .locator(".journey-preview .journey-stop strong")
    .allTextContents();
  await page.locator(".journey-preview .journey-stop").nth(1).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toHaveClass(/place-drawer/);
  await expect(
    drawer.getByRole("heading", { level: 2, name: stopNames[1], exact: true }),
  ).toBeVisible();
  const box = await drawer.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThan(viewport.width / 2);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  const recalculated = page.waitForRequest(
    (request) =>
      request.url().endsWith("/itineraries") &&
      request.method() === "POST" &&
      request.postDataJSON().place_ids.length === 2,
  );
  const recalculatedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/itineraries") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().place_ids.length === 2,
  );
  await drawer
    .getByRole("button", { name: "Убрать остановку", exact: true })
    .click();
  expect((await recalculated).postDataJSON().place_ids).toEqual([
    originalIds[0],
    originalIds[2],
  ]);
  const newPlan = (await (
    await recalculatedResponse
  ).json()) as ItineraryResponse;
  expect(newPlan.route?.method).toBe("approximate");
  expect(newPlan.stops).toHaveLength(2);
  await page.keyboard.press("Escape");
  await expect(
    page.locator(".journey-preview .journey-stop strong"),
  ).toHaveText([stopNames[0], stopNames[2]]);
  await expect(
    page.getByTestId("selected-stops").locator("li strong"),
  ).toHaveText([stopNames[0], stopNames[2]]);
  await expect(page.locator(".map-marker.selected")).toHaveCount(2);
  await expect(page.locator(".journey-preview")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".journey-preview-heading")).toContainText(
    "Все остановки на карте · путь пока не подтверждён",
  );
});

test("compound time beyond four hours is used automatically without enabling manual filters", async ({
  page,
}) => {
  await manualStart(page, "Хочу погулять по паркам 5 часов 30 минут");
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  await page.locator(".find-button").click();
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.available_seconds).toBe(19800);
  expect(request.return_to_origin).toBe(false);
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator(".intent-summary")).toContainText("330 мин");
  await expect(page.locator('input[name="minutes"]')).toHaveValue("");
  await expect(page.locator("#walk-filters")).toBeHidden();
});

test("the visible companion explains actual plan times and can search with less walking", async ({
  page,
}, testInfo) => {
  await fill(page);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/itineraries") && r.request().method() === "POST",
  );
  await search(page);
  const plan = (await (await response).json()) as ItineraryResponse;
  await page
    .getByRole("button", {
      name: "Открыть спутника и разбор прогулки",
      exact: true,
    })
    .click();
  const brief = page.getByRole("region", {
    name: "Разбор вашей прогулки",
    exact: true,
  });
  await expect(brief).toBeVisible();
  await expect(
    brief.getByText("Ваш ориентир:", { exact: false }),
  ).toContainText("90 мин");
  await expect(brief.locator("ol > li")).toHaveCount(plan.stops.length);
  await brief
    .getByRole("heading", { name: "Разбор вашей прогулки", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("walk-plan-brief.png"),
    fullPage: true,
    animations: "disabled",
  });
  const original = await page.locator('textarea[name="query"]').inputValue();
  const next = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  await brief
    .getByRole("button", { name: "Найти с меньшей ходьбой", exact: true })
    .click();
  const refined = (await next).postDataJSON() as RecommendationRequest;
  expect(refined.query).toContain(original);
  expect(refined.query).toContain("короткие переходы");
  expect(refined.available_seconds).toBe(5400);
  expect(refined.return_to_origin).toBe(true);
  await expect(cards(page)).toHaveCount(3);
  await page
    .getByRole("button", { name: "Закрыть спутника", exact: true })
    .click();
  await expect(brief).toHaveCount(0);
});

test("real foundation API: manual start, sources, exact seconds, return itinerary, feedback, favorites", async ({
  page,
}) => {
  await fill(page);
  const sent = page.waitForRequest(
    (r) => r.url().endsWith("/recommendations") && r.method() === "POST",
  );
  const itineraryRequest = page.waitForRequest((r) =>
    r.url().endsWith("/itineraries"),
  );
  await search(page);
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.available_seconds).toBe(5400);
  expect(request.start_at).toBe("2026-10-19T07:00:00.000Z");
  expect(request.return_to_origin).toBe(true);
  await expect(page.locator(".fixture-banner")).toBeVisible();
  await expect(
    results(page)
      .getByText("Объяснение составлено по данным каталога", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(cards(page).first().locator(".why-summary p")).toBeVisible();
  const detailsButton = cards(page)
    .first()
    .getByRole("button", { name: "Факты и источники" });
  await detailsButton.click();
  const records = page.getByRole("dialog").getByTestId("place-source-records");
  await records.locator(":scope > summary").click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Источники", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").locator("a[href^='https://']").first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detailsButton).toBeFocused();
  const selectedBefore = await page
    .getByTestId("selected-stops")
    .locator("li strong")
    .allTextContents();
  const body = (await itineraryRequest).postDataJSON();
  expect(body.place_ids).toHaveLength(3);
  expect(body.return_to_origin).toBe(true);
  await expect(page.locator(".journey-total")).toBeVisible();
  expect(
    await page
      .getByTestId("selected-stops")
      .locator("li strong")
      .allTextContents(),
  ).toEqual(selectedBefore);
  await expect(
    page
      .locator(".itinerary-result")
      .getByText("С возвращением к старту", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.locator(".map-callout.bottom")).toHaveCount(0);
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "none",
  );
  await expect(
    page.locator(".itinerary-result").getByText(/Показаны только точки/),
  ).toBeVisible();
  await cards(page)
    .first()
    .getByRole("button", { name: /^Сохранить место:/ })
    .click();
  const stored = await page.evaluate(() =>
    localStorage.getItem("astana-compass:favorites:v1"),
  );
  expect(stored).not.toContain("51.09");
  expect(stored).not.toContain("Прогулка без спешки");
  await page.getByRole("link", { name: "Избранное", exact: true }).click();
  await page.getByRole("button", { name: "Удалить всё избранное" }).click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("astana-compass:favorites:v1"),
    ),
  ).toBeNull();
  await page.getByRole("navigation").locator('a[href="/walk"]').click();
  const feedback = page.waitForRequest((r) => r.url().endsWith("/feedback"));
  await page.getByRole("button", { name: "Да, полезно" }).click();
  expect((await feedback).postDataJSON()).toEqual({
    request_id: expect.any(String),
    rating: "helpful",
    comment: null,
  });
  await expect(page.getByText("Спасибо за отзыв")).toBeVisible();
  await screenshot(page, "ru-desktop-results");
});

test("real API: unknown required is excluded without weakening it", async ({
  page,
}) => {
  await fill(page);
  await page.locator(".strict-constraints > summary").click();
  await page
    .getByRole("combobox", { name: "Доступно на коляске" })
    .selectOption("required");
  await page.locator(".find-button").click();
  await expect(
    results(page).getByRole("heading", {
      name: "Подтверждённого варианта пока нет",
    }),
  ).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Доступно на коляске" }),
  ).toHaveValue("required");
});

test("presets preserve existing must-haves in the form and HTTP request", async ({
  page,
}) => {
  await fill(page);
  await page.locator(".strict-constraints > summary").click();
  const indoor = page.getByRole("combobox", {
    name: "В помещении",
    exact: true,
  });
  const children = page.getByRole("combobox", {
    name: "Подходит детям",
    exact: true,
  });
  await indoor.selectOption("required");
  await children.selectOption("required");
  await page
    .locator(".preset-row")
    .getByRole("button", { name: "В помещении", exact: true })
    .click();
  await page
    .locator(".preset-row")
    .getByRole("button", { name: "С детьми", exact: true })
    .click();
  await expect(indoor).toHaveValue("required");
  await expect(children).toHaveValue("required");
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  await page.locator(".find-button").click();
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.constraints).toEqual(
    expect.arrayContaining([
      { key: "indoor", value: true, strength: "required" },
      { key: "child_friendly", value: true, strength: "required" },
    ]),
  );
});

test("ordinary amenities remain preferences and keep the walk description", async ({
  page,
}) => {
  await fill(page);
  const query = "Хочу прогулку по живописным местам, а по пути кофе";
  await page.locator('textarea[name="query"]').fill(query);
  const strict = page.locator(".strict-constraints");
  await expect(strict).not.toHaveAttribute("open");
  await expect(strict.getByRole("combobox", { name: "Wi-Fi" })).toBeHidden();
  await page.getByRole("checkbox", { name: "Wi-Fi", exact: true }).check();
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  await page.locator(".find-button").click();
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.query).toBe(query);
  expect(request.constraints).toEqual([
    { key: "has_wifi", value: true, strength: "preferred" },
  ]);
  await page.getByRole("checkbox", { name: "Wi-Fi", exact: true }).uncheck();
  await expect(page.locator('textarea[name="query"]')).toHaveValue(query);
});

test("real API: no-match keeps every stop; explicit reorder clears the previous route", async ({
  page,
}) => {
  await fill(page);
  await search(page);
  const original = await page
    .getByTestId("selected-stops")
    .locator("li strong")
    .allTextContents();
  await page
    .getByTestId("selected-stops")
    .getByRole("button", { name: /^Ниже:/ })
    .first()
    .click();
  expect(
    await page
      .getByTestId("selected-stops")
      .locator("li strong")
      .allTextContents(),
  ).toEqual([original[1], original[0], original[2]]);
  await page.locator(".strict-constraints > summary").click();
  await page
    .getByRole("combobox", { name: "Доступно на коляске" })
    .selectOption("required");
  await page.getByRole("button", { name: "Рассчитать весь маршрут" }).click();
  await expect(
    page
      .locator(".itinerary-result")
      .getByRole("heading", { name: "Подтверждённого варианта пока нет" }),
  ).toBeVisible();
  await expect(page.getByTestId("selected-stops").locator("li")).toHaveCount(3);
  await expect(page.locator(".journey-total")).toHaveCount(0);
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "none",
  );
});

test("synthetic response fault: server must not reorder the selected stops", async ({
  page,
}) => {
  await fill(page);
  await page.route("**/api/v1/itineraries", async (route) => {
    const actual = await route.fetch();
    const payload = (await actual.json()) as ItineraryResponse;
    payload.stops.reverse();
    payload.stops.forEach((stop, i) => {
      stop.order = i + 1;
    });
    await route.fulfill({ response: actual, json: payload });
  });
  await search(page);
  const selected = await page
    .getByTestId("selected-stops")
    .locator("li strong")
    .allTextContents();
  await expect(page.locator(".journey").getByRole("alert")).toContainText(
    "Не удалось проверить ответ",
  );
  expect(
    await page
      .getByTestId("selected-stops")
      .locator("li strong")
      .allTextContents(),
  ).toEqual(selected);
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "none",
  );
});

test("synthetic clarification creates a new canonical request", async ({
  page,
}) => {
  await fill(page);
  let calls = 0;
  let second: RecommendationRequest | undefined;
  await page.route("**/api/v1/recommendations", async (route) => {
    const request = route.request().postDataJSON() as RecommendationRequest;
    if (calls++ === 0)
      await route.fulfill({
        json: {
          request_id: "synthetic:clarify",
          request,
          status: "needs_clarification",
          places: [],
          recommendations: [],
          clarification_questions: ["Какое занятие вас интересует?"],
          warnings: [],
          generated_at: "2026-10-19T07:00:00Z",
        },
        headers: { "X-Astana-Data-Mode": "fixture" },
      });
    else {
      second = request;
      await route.continue();
    }
  });
  await page.locator(".find-button").click();
  await page
    .getByRole("textbox", { name: "Ваш ответ" })
    .fill("Хочу посмотреть искусство");
  await page.getByRole("button", { name: "Уточнить и повторить" }).click();
  await expect(cards(page)).toHaveCount(3);
  expect(second!.query).toContain("Хочу посмотреть искусство");
  expect(second).not.toHaveProperty("conversation");
  expect(second!.locale).toBe("ru");
});

for (const code of ["provider_unavailable", "rate_limited"] as const) {
  test(`synthetic ${code} keeps the form and offers recovery`, async ({
    page,
  }) => {
    await fill(page);
    await page.route("**/api/v1/recommendations", (route) =>
      route.fulfill({
        status: code === "rate_limited" ? 429 : 503,
        json: {
          request_id: "synthetic:error",
          error: { code, message: "Unavailable", retryable: true, details: [] },
        },
      }),
    );
    await page.locator(".find-button").click();
    await expect(results(page).getByRole("alert")).toBeVisible();
    await expect(page.locator('textarea[name="query"]')).toHaveValue(
      "Прогулка без спешки",
    );
    await page.unroute("**/api/v1/recommendations");
    await results(page).getByRole("button", { name: "Повторить" }).click();
    await expect(cards(page)).toHaveCount(3);
  });
}

test("repeated temporary location errors keep loading until a later retry finds the start", async ({
  page,
}) => {
  await page.evaluate(() => {
    let attempts = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (position: {
            coords: { latitude: number; longitude: number };
          }) => void,
          failure: (error: { code: number }) => void,
        ) => {
          if (attempts++ < 2) failure({ code: 2 });
          else
            success({ coords: { latitude: 51.123456, longitude: 71.456789 } });
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "Моё местоположение", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Определяем точку…", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".start-card .warning-text")).toHaveCount(0);
  await expect(page.locator('input[name="latitude"]')).toHaveValue("51.123456");
  await expect(page.locator('input[name="longitude"]')).toHaveValue(
    "71.456789",
  );
  await expect(page.locator(".start-card .warning-text")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Моё местоположение", exact: true }),
  ).toBeEnabled();
});

test("location recovery expires with a retryable timeout and a new fix clears the error", async ({
  page,
}) => {
  const now = new Date("2026-10-20T12:00:00Z");
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1_000));
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          _success: unknown,
          failure: (error: { code: number }) => void,
        ) => failure({ code: 3 }),
      },
    });
  });
  await page
    .getByRole("button", { name: t("ru", "locate"), exact: true })
    .click();
  await page.clock.fastForward(19_999);
  await expect(
    page.getByRole("button", { name: t("ru", "locating"), exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".start-card .warning-text")).toHaveCount(0);
  await page.clock.fastForward(1);
  await expect(page.getByText(t("ru", "geoTimeout"))).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (position: {
            coords: { latitude: number; longitude: number };
          }) => void,
        ) => success({ coords: { latitude: 51.123456, longitude: 71.456789 } }),
      },
    });
  });
  await page
    .getByRole("button", { name: t("ru", "locate"), exact: true })
    .click();
  await expect(page.locator('input[name="latitude"]')).toHaveValue("51.123456");
  await expect(page.locator(".start-card .warning-text")).toHaveCount(0);
});

test("a map camera fix clears an earlier planner denial while preserving the chosen start", async ({
  page,
}) => {
  await manualStart(page);
  await expect(page.locator(".maplibregl-ctrl-geolocate")).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          _success: unknown,
          failure: (error: { code: number }) => void,
        ) => failure({ code: 1 }),
        watchPosition: (success: PositionCallback) => {
          (
            window as unknown as { finishMapLocation: () => void }
          ).finishMapLocation = () =>
            success({
              coords: {
                latitude: 51.123456,
                longitude: 71.456789,
                accuracy: 20,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                speed: null,
              },
              timestamp: Date.now(),
            } as GeolocationPosition);
          return 7;
        },
        clearWatch: () => {},
      },
    });
  });
  await page
    .getByRole("button", { name: t("ru", "locate"), exact: true })
    .click();
  await expect(page.getByText(t("ru", "geoPermissionDenied"))).toBeVisible();
  await page.locator(".maplibregl-ctrl-geolocate").click();
  await page.evaluate(() =>
    (
      window as unknown as { finishMapLocation: () => void }
    ).finishMapLocation(),
  );
  await expect(page.locator(".start-card .warning-text")).toHaveCount(0);
  await expect(page.locator('input[name="latitude"]')).toHaveValue("51.090");
  await expect(page.locator('input[name="longitude"]')).toHaveValue("71.420");
});

test("geolocation denial preserves manual entry; late callbacks cannot overwrite a manual edit", async ({
  page,
}) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          _success: unknown,
          failure: (error: { code: number }) => void,
        ) => failure({ code: 1 }),
      },
    });
  });
  await page
    .getByRole("button", { name: "Моё местоположение", exact: true })
    .click();
  await expect(page.getByText(t("ru", "geoPermissionDenied"))).toBeVisible();
  await fill(page);
  await search(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (position: {
            coords: { latitude: number; longitude: number };
          }) => void,
        ) => {
          (window as unknown as { finishLocation: () => void }).finishLocation =
            () => success({ coords: { latitude: 52, longitude: 72 } });
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "Моё местоположение", exact: true })
    .click();
  await page.locator('input[name="latitude"]').fill("51.095");
  await page.evaluate(() =>
    (window as unknown as { finishLocation: () => void }).finishLocation(),
  );
  await expect(page.locator('input[name="latitude"]')).toHaveValue("51.095");
});

test("synthetic routed response draws a line, and editing removes it", async ({
  page,
}) => {
  await fill(page);
  await page.route("**/api/v1/itineraries", async (route) => {
    const actual = await route.fetch();
    const payload = (await actual.json()) as ItineraryResponse;
    payload.route!.method = "routed";
    payload.route!.geometry = {
      type: "LineString",
      coordinates: [
        [71.42, 51.09],
        [71.421, 51.092],
        [71.42, 51.09],
      ],
    };
    payload.route!.provider = "synthetic:e2e-route-renderer";
    await route.fulfill({ response: actual, json: payload });
  });
  await search(page);
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "routed",
  );
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.screenshot({
    path: path.join(
      process.env.ASTANA_SCREENSHOT_DIR ?? "test-results",
      "synthetic-routed.png",
    ),
  });
  await page.locator('input[name="minutes"]').fill("60");
  await expect(page.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "none",
  );
  await expect(page.getByTestId("selected-stops").locator("li")).toHaveCount(3);
});

test("editing during a slow request cancels obsolete results", async ({
  page,
}) => {
  await fill(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/recommendations", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.locator(".find-button").click();
  await expect(page.locator(".loading-state")).toBeVisible();
  await page.locator('input[name="minutes"]').fill("5");
  release();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator(".loading-state")).toHaveCount(0);
  await expect(
    results(page).getByRole("heading", {
      name: "Хорошая прогулка начинается с вас",
    }),
  ).toBeVisible();
});

for (const failure of [
  "provider refusal",
  "malformed model output",
  "model unavailable",
]) {
  test(`synthetic ${failure}: grounded fallback and sources stay visible`, async ({
    page,
  }) => {
    await fill(page);
    await page.route("**/api/v1/recommendations", async (route) => {
      const actual = await route.fetch();
      const payload = (await actual.json()) as RecommendationResponse;
      const degraded = await generationFault(failure, payload);
      await route.fulfill({ response: actual, json: degraded });
    });
    // This test boots a real Python replay process; on Windows cold imports can
    // exceed the default 5s UI assertion timeout. Wait for its bounded response.
    const replayResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/recommendations") &&
        response.request().method() === "POST",
      { timeout: 20000 },
    );
    await page.locator(".find-button").click();
    await replayResponse;
    await expect(cards(page)).toHaveCount(3);
    await expect(results(page).locator(":scope > .fallback-label")).toHaveText(
      "Объяснение составлено по данным каталога",
    );
    await expect(
      results(page).locator(":scope > .fallback-label"),
    ).toBeVisible();
    await expect(
      cards(page).first().getByRole("button", { name: "Факты и источники" }),
    ).toBeVisible();
    await expect(page.getByText(/обучено нами/i)).toHaveCount(0);
  });
}

test("fixture mode requires explicit opt-in", async ({ page }) => {
  await page.goto("http://127.0.0.1:43104");
  await expect(page.locator(".catalog").getByRole("alert")).toContainText(
    "Демонстрационный режим здесь не включён",
  );
  await expect(
    page.locator(".catalog-cards").getByTestId("place-card"),
  ).toHaveCount(0);
});

for (const [locale, name] of [
  ["ru", "Русский"],
  ["kk", "Қазақша"],
  ["en", "English"],
] as const) {
  for (const width of [1440, 390]) {
    test(`${name} at ${width}px: real API, accessibility and screenshots`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 950 });
      await page.locator(".language-select select").selectOption(locale);
      await fill(page);
      await search(page);
      if (width <= 760) {
        await expect(page.locator(".app-shell")).toHaveAttribute(
          "data-sheet-snap",
          "collapsed",
        );
        await page.getByTestId("mobile-sheet-controls").locator("a").click();
        await expect(page.locator('textarea[name="query"]')).toBeVisible();
        const destinations = page.locator(".app-rail .rail-link");
        await expect(destinations).toHaveCount(6);
        for (const destination of await destinations.all()) {
          await expect(destination).toBeVisible();
          const size = await destination.evaluate((element) => {
            const text = element.querySelector("span:not(.count)")!;
            return {
              fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
              labelWidth: text.getBoundingClientRect().width,
              cellWidth: element.getBoundingClientRect().width,
            };
          });
          expect(size.fontSize).toBeGreaterThanOrEqual(10);
          expect(size.labelWidth).toBeLessThanOrEqual(size.cellWidth);
        }
        await expect(page.locator(".rail-language select")).toBeVisible();
      }
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        audit.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            failureSummary: n.failureSummary,
          })),
        })),
      ).toEqual([]);
      await screenshot(page, `${locale}-${width}`);
    });
  }
}

test("keyboard, separate data page, empty catalog and map point selection", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Перейти к планированию" }),
  ).toBeFocused();
  await page.getByRole("link", { name: "О проекте", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.locator(".data-total strong")).toHaveText("3");
  await page.getByRole("link", { name: "Карта", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Поиск по названию" })
    .fill("no-such-synthetic-place");
  await page
    .locator(".catalog-search")
    .getByRole("button", { name: "Найти", exact: true })
    .click();
  await expect(
    page
      .locator(".catalog")
      .getByText(t("ru", "catalogNoMatch"), { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: t("ru", "catalogShowAll") }).click();
  await expect(page.locator("#catalog-query")).toHaveValue("");
  await expect(
    page.locator(".catalog-cards").getByTestId("place-card"),
  ).toHaveCount(3);
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 120, y: 140 } });
  await expect(page.locator('input[name="latitude"]')).not.toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Изменить точку", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("navigation preserves the private plan in memory and offers direct URLs", async ({
  page,
}) => {
  await fill(page);
  await search(page);
  const coordinates = await page.locator('input[name="latitude"]').inputValue();
  await page.getByRole("link", { name: "Избранное", exact: true }).click();
  await expect(page).toHaveURL(/\/saved$/);
  await page.goBack();
  await expect(page.locator('textarea[name="query"]')).toHaveValue(
    "Прогулка без спешки",
  );
  await expect(page.locator('input[name="latitude"]')).toHaveValue(coordinates);
  await expect(page.getByTestId("selected-stops").locator("li")).toHaveCount(3);
  expect(page.url()).not.toContain("51.");
  for (const route of ["/saved", "/about", "/party", "/events"]) {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main h1")).toBeVisible();
  }
});

async function interpret(page: Page): Promise<IntentResponse> {
  await openFilters(page);
  const advanced = page.locator("details.advanced-intent");
  if ((await advanced.getAttribute("open")) === null)
    await advanced.locator("summary").click();
  const received = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/intent") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Разобрать запрос с ИИ", exact: true })
    .click();
  const response = await received;
  expect(response.status()).toBe(200);
  expect(Object.keys(response.request().postDataJSON()).sort()).toEqual([
    "locale",
    "query",
  ]);
  const result = (await response.json()) as IntentResponse;
  // CI explicitly runs without provider keys; this is the real rules fallback.
  expect(result.provider).toBe("rules");
  await expect(
    page
      .locator(".intent-suggestions")
      .getByText("Разбор по правилам", { exact: true }),
  ).toBeVisible();
  return result;
}

test("real intent API: review before apply, keep must-haves and never geocode a textual landmark", async ({
  page,
}) => {
  await fill(page);
  const query =
    "У меня 30 минут рядом с Байтереком. Хочу в помещении, нужны розетки.";
  await page.locator('textarea[name="query"]').fill(query);
  await page.locator(".strict-constraints > summary").click();
  const indoor = page.getByRole("combobox", {
    name: "В помещении",
    exact: true,
  });
  const outlets = page.getByRole("combobox", {
    name: "Есть розетки",
    exact: true,
  });
  await indoor.selectOption("required");
  const lat = await page.locator('input[name="latitude"]').inputValue();
  const lon = await page.locator('input[name="longitude"]').inputValue();
  const proposed = await interpret(page);
  expect(proposed.available_seconds).toBe(1800);
  expect(proposed.constraints.map((item) => item.constraint.key)).toEqual(
    expect.arrayContaining(["indoor", "has_power_outlets"]),
  );
  expect(proposed.anchor_text).not.toBeNull();
  await expect(page.locator('input[name="minutes"]')).toHaveValue("90");
  await expect(outlets).toHaveValue("");
  const time = page
    .locator(".intent-review")
    .getByRole("checkbox", { name: /Применить время/ });
  await expect(time).not.toBeChecked();
  await time.check();
  await page
    .getByRole("button", { name: "Применить выбранное", exact: true })
    .click();
  await expect(page.locator('input[name="minutes"]')).toHaveValue("30");
  await expect(indoor).toHaveValue("required");
  await expect(outlets).toHaveValue("preferred");
  await expect(page.locator('input[name="latitude"]')).toHaveValue(lat);
  await expect(page.locator('input[name="longitude"]')).toHaveValue(lon);
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  await page.locator(".find-button").click();
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.available_seconds).toBe(1800);
  expect(request.constraints).toEqual(
    expect.arrayContaining([
      { key: "indoor", value: true, strength: "required" },
      { key: "has_power_outlets", value: true, strength: "preferred" },
    ]),
  );
  expect(request.origin).toEqual({ lat: Number(lat), lon: Number(lon) });
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).first().locator(".why-summary p")).toBeVisible();
});

test("real intent API: flight deadline asks for walking time rather than spending the whole airport buffer", async ({
  page,
}) => {
  await fill(page);
  await page
    .locator('textarea[name="query"]')
    .fill("До вылета 2 часа, хочу немного прогуляться");
  const proposed = await interpret(page);
  expect(proposed.available_seconds).toBeNull();
  expect(proposed.time_evidence).toBeNull();
  expect(
    proposed.clarification_questions.some((question) =>
      question.includes("аэропорт"),
    ),
  ).toBe(true);
  await expect(
    page
      .locator(".intent-suggestions")
      .getByText(/Сколько минут остаётся именно на прогулку/),
  ).toBeVisible();
  await expect(
    page
      .locator(".intent-review")
      .getByRole("checkbox", { name: /Применить время/ }),
  ).toHaveCount(0);
  await expect(page.locator('input[name="minutes"]')).toHaveValue("90");
  await expect(cards(page)).toHaveCount(0);
});

async function createGuest(page: Page, name: string) {
  const received = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/social/session") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("textbox", { name: "Как вас зовут?", exact: true })
    .fill(name);
  await page
    .getByRole("button", { name: "Создать гостевой профиль", exact: true })
    .click();
  const response = await received;
  expect(response.status()).toBe(200);
  const state = (await response.json()) as SocialState;
  expect(state.profile.name).toBe(name);
  expect(state).not.toHaveProperty("token");
  await expect(
    page.getByRole("textbox", { name: "Ваш код для друзей", exact: true }),
  ).toHaveValue(state.friend_code);
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "astana_guest",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "astana_guest=",
  );
  return state;
}

async function openPartySection(page: Page, name: string) {
  const section = page
    .locator("details.party-section")
    .filter({ has: page.locator("summary", { hasText: name }) });
  if ((await section.getAttribute("open")) === null)
    await section.locator("summary").click();
  return section;
}

async function socialAction(
  page: Page,
  action: SocialActionRequest["action"],
  trigger: () => Promise<unknown>,
) {
  const received = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/social/action") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().action === action,
  );
  await trigger();
  const response = await received;
  expect(response.status()).toBe(200);
  return {
    state: (await response.json()) as SocialState,
    request: response.request().postDataJSON() as SocialActionRequest,
  };
}

async function deleteGuest(page: Page) {
  // Test teardown uses the context's HttpOnly cookie; it never reads or stores the bearer token.
  await page.request
    .post("/api/v1/social/action", {
      headers: { Origin: new URL(page.url()).origin },
      data: { action: "logout" },
    })
    .catch(() => {});
}

test("real social API across two browser contexts: consent, three ordered stops, shared route and chat", async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const other = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 1440, height: 1000 },
    timezoneId: "America/New_York",
  });
  const friend = await other.newPage();
  try {
    await fill(page);
    await page.getByRole("navigation").locator('a[href="/party"]').click();
    const owner = await createGuest(page, "E2E Aida");
    await friend.goto("/party");
    const guest = await createGuest(friend, "E2E Daniyar");
    await page.bringToFront();
    const friends = await openPartySection(page, "Друзья и приглашения");
    await friends
      .getByRole("textbox", { name: "Код друга", exact: true })
      .fill(guest.friend_code);
    const pending = await socialAction(page, "friend_request", () =>
      friends
        .getByRole("button", { name: "Отправить запрос", exact: true })
        .click(),
    );
    expect(pending.state.friends).toEqual([]);
    await friend.bringToFront();
    const incoming = friend
      .locator(".party-people li")
      .filter({ hasText: owner.profile.name });
    await expect(
      incoming.getByRole("button", { name: "Принять", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    const accepted = await socialAction(friend, "friend_accept", () =>
      incoming.getByRole("button", { name: "Принять", exact: true }).click(),
    );
    expect(accepted.state.friends).toEqual([owner.profile]);
    await page.bringToFront();
    await expect(
      friends
        .locator(".party-people li")
        .filter({ hasText: guest.profile.name }),
    ).toBeVisible({ timeout: 10000 });
    const groupName = "E2E three-stop walk";
    await page
      .getByRole("textbox", { name: "Название компании", exact: true })
      .fill(groupName);
    const created = await socialAction(page, "party_create", () =>
      page
        .getByRole("button", { name: "Создать компанию", exact: true })
        .click(),
    );
    const partyId = created.state.parties[0].id;
    await page
      .getByRole("combobox", { name: "Пригласить друга", exact: true })
      .selectOption(guest.profile.id);
    await socialAction(page, "party_invite", () =>
      page
        .getByRole("button", { name: "Пригласить друга", exact: true })
        .click(),
    );
    await friend.bringToFront();
    const invitation = friend
      .locator(".party-people li")
      .filter({ hasText: groupName });
    await expect(
      invitation.getByRole("button", { name: "Принять", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await socialAction(friend, "party_join", () =>
      invitation.getByRole("button", { name: "Принять", exact: true }).click(),
    );
    await expect(friend.locator(".party-members li")).toHaveCount(2);
    await page.bringToFront();
    await expect(page.locator(".party-members li")).toHaveCount(2, {
      timeout: 10000,
    });
    const recommended = await socialAction(page, "recommend", () =>
      page
        .getByRole("button", { name: "Найти варианты для всех", exact: true })
        .click(),
    );
    const response = recommended.state.parties.find(
      (item) => item.id === partyId,
    )!.recommendations!;
    expect(response.recommendations).toHaveLength(3);
    const groupCards = page.locator(".party-results .place-card");
    await expect(groupCards).toHaveCount(3);
    const order = [2, 0, 1];
    const names: string[] = [];
    for (const index of order) {
      names.push(
        (await groupCards.nth(index).getByRole("heading").textContent())!,
      );
      await groupCards
        .nth(index)
        .getByRole("button", { name: "Добавить в общий план", exact: true })
        .click();
    }
    const built = await socialAction(page, "itinerary", () =>
      page
        .getByRole("button", { name: "Построить общий маршрут", exact: true })
        .click(),
    );
    expect(built.request.action).toBe("itinerary");
    if (built.request.action !== "itinerary")
      throw new Error("Expected itinerary request");
    const orderedIds = order.map(
      (index) => response.recommendations[index].place_id,
    );
    expect(built.request.request.place_ids).toEqual(orderedIds);
    const shared = built.state.parties.find(
      (item) => item.id === partyId,
    )!.itinerary!;
    expect(shared.stops.map((stop) => stop.place_id)).toEqual(orderedIds);
    await expect(
      page.locator(".party-plan .itinerary-visits li strong"),
    ).toHaveText(names);
    await expect(page.locator(".map-marker.selected")).toHaveCount(3);
    await friend.bringToFront();
    await expect(
      friend.locator(".party-plan .itinerary-visits li strong"),
    ).toHaveText(names, { timeout: 10000 });
    await expect(friend.locator(".map-marker.selected")).toHaveCount(3);
    await expect(friend.getByTestId("map-panel")).toHaveAttribute(
      "data-route-geometry",
      "none",
    );
    await expect(friend.locator(".shared-location-marker")).toHaveCount(0);
    const chat = friend.locator(".party-chat");
    await chat
      .getByRole("textbox", { name: "Сообщение", exact: true })
      .fill("Встречаемся у выбранного старта");
    const message = await socialAction(friend, "message", () =>
      chat.getByRole("button", { name: "Отправить", exact: true }).click(),
    );
    expect(message.state.parties[0].itinerary).toEqual(shared);
    await page.bringToFront();
    await expect(
      page
        .locator(".chat-messages")
        .getByText("Встречаемся у выбранного старта", { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator(".party-plan .itinerary-visits li strong"),
    ).toHaveText(names);
    await expect(page.locator(".shared-location-marker")).toHaveCount(0);
  } finally {
    await deleteGuest(page);
    if (friend.url().startsWith("http")) await deleteGuest(friend);
    await other.close();
  }
});

function astanaInput(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

test("real community API: publish an unverified map event and remove its marker", async ({
  page,
}) => {
  await page.getByRole("navigation").locator('a[href="/party"]').click();
  const guest = await createGuest(page, "E2E event author");
  try {
    await page.getByRole("navigation").locator('a[href="/events"]').click();
    await expect(page).toHaveURL(/\/events$/);
    await expect(page.getByTestId("map-confirm-origin")).toBeVisible();
    await page.getByTestId("map-confirm-origin").click();
    const point = {
      lat: Number(await page.locator('input[name="latitude"]').inputValue()),
      lon: Number(await page.locator('input[name="longitude"]').inputValue()),
    };
    const title = `E2E community sketch walk ${Date.now()}`;
    await page
      .getByRole("textbox", { name: "Название события", exact: true })
      .fill(title);
    await page
      .getByRole("textbox", { name: "Описание", exact: true })
      .fill("Synthetic CI announcement; not a real gathering.");
    await page
      .locator('input[name="event-start"]')
      .fill(astanaInput(new Date(Date.now() + 3600000)));
    await page
      .locator('input[name="event-end"]')
      .fill(astanaInput(new Date(Date.now() + 7200000)));
    const posted = await socialAction(page, "event_create", () =>
      page
        .getByRole("button", { name: "Опубликовать событие", exact: true })
        .click(),
    );
    expect(posted.request.action).toBe("event_create");
    if (posted.request.action !== "event_create")
      throw new Error("Expected event request");
    expect(posted.request.location).toEqual(point);
    const event = page
      .locator(".community-event")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await expect(event).toBeVisible();
    await expect(
      event.getByText("Не проверено · объявление участника", { exact: true }),
    ).toBeVisible();
    await expect(event).toContainText(guest.profile.name);
    const marker = page.getByRole("button", {
      name: `Событие сообщества · не проверено: ${title}`,
      exact: true,
    });
    await expect(marker).toBeVisible();
    await socialAction(page, "event_delete", () =>
      event
        .getByRole("button", { name: "Удалить моё событие", exact: true })
        .click(),
    );
    await expect(event).toHaveCount(0);
    await expect(marker).toHaveCount(0);
  } finally {
    await deleteGuest(page);
  }
});
