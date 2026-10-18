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

const results = (page: Page) => page.locator(".results");
const cards = (page: Page) => results(page).getByTestId("place-card");
async function fill(page: Page) {
  await page.locator('textarea[name="query"]').fill("Прогулка без спешки");
  await page.locator('input[name="latitude"]').fill("51.090");
  await page.locator('input[name="longitude"]').fill("71.420");
  await page.locator('input[name="start"]').fill("2026-10-19T12:00");
  await page.locator('input[name="minutes"]').fill("90");
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
  await page.goto("/");
});

test("real foundation API: manual start, sources, exact seconds, return itinerary, feedback, favorites", async ({
  page,
}) => {
  await fill(page);
  const sent = page.waitForRequest(
    (r) => r.url().endsWith("/recommendations") && r.method() === "POST",
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
  await cards(page)
    .first()
    .getByText("Почему подходит", { exact: true })
    .click();
  await expect(cards(page).first().locator(".why p").first()).toBeVisible();
  const detailsButton = cards(page)
    .first()
    .getByRole("button", { name: "Факты и источники" });
  await detailsButton.click();
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
  await cards(page)
    .nth(0)
    .getByRole("button", { name: "В мой план", exact: true })
    .click();
  await cards(page)
    .nth(1)
    .getByRole("button", { name: "В мой план", exact: true })
    .click();
  const selectedBefore = await page
    .getByTestId("selected-stops")
    .locator("li strong")
    .allTextContents();
  const itineraryRequest = page.waitForRequest((r) =>
    r.url().endsWith("/itineraries"),
  );
  await page.getByRole("button", { name: "Рассчитать весь маршрут" }).click();
  const body = (await itineraryRequest).postDataJSON();
  expect(body.place_ids).toHaveLength(2);
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
  await page
    .getByRole("button", { name: "Открыть карту", exact: true })
    .click();
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
  await page.getByRole("button", { name: /Избранное/ }).click();
  await page.getByRole("button", { name: "Удалить всё избранное" }).click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("astana-compass:favorites:v1"),
    ),
  ).toBeNull();
  await page.keyboard.press("Escape");
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

test("presets preserve existing must-haves in the form and HTTP request", async ({ page }) => {
  await fill(page);
  const indoor = page.getByRole("combobox", { name: "В помещении", exact: true });
  const children = page.getByRole("combobox", { name: "Подходит детям", exact: true });
  await indoor.selectOption("required");
  await children.selectOption("required");
  await page.locator(".preset-row").getByRole("button", { name: "В помещении", exact: true }).click();
  await page.locator(".preset-row").getByRole("button", { name: "С детьми", exact: true }).click();
  await expect(indoor).toHaveValue("required");
  await expect(children).toHaveValue("required");
  const sent = page.waitForRequest(
    (request) => request.url().endsWith("/recommendations") && request.method() === "POST",
  );
  await page.locator(".find-button").click();
  const request = (await sent).postDataJSON() as RecommendationRequest;
  expect(request.constraints).toEqual(expect.arrayContaining([
    { key: "indoor", value: true, strength: "required" },
    { key: "child_friendly", value: true, strength: "required" },
  ]));
});

test("real API: no-match keeps every stop; explicit reorder clears the previous route", async ({
  page,
}) => {
  await fill(page);
  await search(page);
  await cards(page)
    .nth(0)
    .getByRole("button", { name: "В мой план", exact: true })
    .click();
  await cards(page)
    .nth(1)
    .getByRole("button", { name: "В мой план", exact: true })
    .click();
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
  ).toEqual([...original].reverse());
  await page.locator('input[name="minutes"]').fill("1");
  await page.getByRole("button", { name: "Рассчитать весь маршрут" }).click();
  await expect(
    page
      .locator(".itinerary-result")
      .getByRole("heading", { name: "Подтверждённого варианта пока нет" }),
  ).toBeVisible();
  await expect(page.getByTestId("selected-stops").locator("li")).toHaveCount(2);
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
  await search(page);
  for (const index of [0, 1])
    await cards(page)
      .nth(index)
      .getByRole("button", { name: "В мой план", exact: true })
      .click();
  const selected = await page
    .getByTestId("selected-stops")
    .locator("li strong")
    .allTextContents();
  await page.route("**/api/v1/itineraries", async (route) => {
    const actual = await route.fetch();
    const payload = (await actual.json()) as ItineraryResponse;
    payload.stops.reverse();
    payload.stops.forEach((stop, i) => {
      stop.order = i + 1;
    });
    await route.fulfill({ response: actual, json: payload });
  });
  await page.getByRole("button", { name: "Рассчитать весь маршрут" }).click();
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
  await page.getByRole("button", { name: "Моё местоположение" }).click();
  await expect(page.getByText(/Местоположение недоступно/)).toBeVisible();
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
  await page.getByRole("button", { name: "Моё местоположение" }).click();
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
  await search(page);
  await cards(page)
    .first()
    .getByRole("button", { name: "В мой план", exact: true })
    .click();
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
  await page.getByRole("button", { name: "Рассчитать весь маршрут" }).click();
  await page
    .getByRole("button", { name: "Открыть карту", exact: true })
    .click();
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
  await expect(page.getByTestId("selected-stops").locator("li")).toHaveCount(1);
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
    await search(page);
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
          nodes: v.nodes.map((n) => n.target),
        })),
      ).toEqual([]);
      await screenshot(page, `${locale}-${width}`);
    });
  }
}

test("keyboard, data status, empty catalog and map point selection", async ({
  page,
}) => {
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Перейти к планированию" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "О данных", exact: true }).click();
  await expect(page.locator(".data-total strong")).toHaveText("3");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "О данных", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Поиск по названию" })
    .fill("no-such-synthetic-place");
  await page
    .locator(".catalog-search")
    .getByRole("button", { name: "Найти", exact: true })
    .click();
  await expect(
    page.locator(".catalog").getByText("Здесь пока нет мест"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Выбрать на карте", exact: true })
    .click();
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 120, y: 140 } });
  await expect(page.locator('input[name="latitude"]')).not.toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Выбрать на карте", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});
