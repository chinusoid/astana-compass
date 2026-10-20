import {
  test,
  expect,
  AxeBuilder,
  type Page,
  type RecommendationResponse,
} from "../../apps/web/e2e-support";
import type { Place } from "../../packages/api_client/src/generated";
import { locales, t } from "../../apps/web/src/lib/i18n";

async function searchCatalog(page: Page, name: string) {
  await page.locator("#catalog-query").fill(name);
  await page.locator(".catalog-search button[type=submit]").click();
}

async function fillWalk(page: Page, place: Place, query: string) {
  await page.getByRole("navigation").locator('a[href="/walk"]').click();
  const advanced = page.locator("details.advanced-origin");
  await advanced.locator("summary").click();
  await page.locator('textarea[name="query"]').fill(query);
  await page.locator('input[name="latitude"]').fill(String(place.location.lat));
  await page
    .locator('input[name="longitude"]')
    .fill(String(place.location.lon));
  await advanced.getByRole("button").click();
  const filters = page.locator(".filter-toggle");
  if ((await filters.getAttribute("aria-expanded")) !== "true")
    await filters.click();
  await expect(page.locator("#walk-filters")).toBeVisible();
  await page.locator('input[name="minutes"]').fill("120");
}

test.skip(
  !process.env.ASTANA_LIVE_WEB_URL && process.env.ASTANA_LIVE_LOCAL !== "true",
  "Set ASTANA_LIVE_WEB_URL to a frontend connected to ASTANA_MODE=live. This is separate from synthetic tests.",
);

test("live API readiness and non-synthetic catalog", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/v1/data-status");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-astana-data-mode"]).toBe("live");
  const status = await response.json();
  expect(status.total_places).toBeGreaterThan(0);
  await page.goto("/");
  await expect(
    page.locator(".catalog-cards").getByTestId("place-card").first(),
  ).toBeVisible();
  await expect(page.locator(".fixture-banner")).toHaveCount(0);
  const places = await request.get("/api/v1/places?limit=3");
  expect(
    (await places.json()).places.every(
      (place: { is_synthetic: boolean; id: string }) =>
        !place.is_synthetic && !place.id.startsWith("synthetic:"),
    ),
  ).toBe(true);
});

for (const locale of locales) {
  test(`real source amenities and unknown Wi-Fi stay distinct on mobile in ${locale}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await request.get(
      `/api/v1/places/${encodeURIComponent("osm:way/1395465867")}`,
    );
    expect(response.status()).toBe(200);
    const place = (await response.json()) as Place;
    expect(place.is_synthetic).toBe(false);
    expect(
      place.facts.some(
        (fact) =>
          fact.key === "has_wifi" &&
          fact.status === "known" &&
          fact.value === true,
      ),
    ).toBe(true);
    await page.goto("/");
    await page.locator(".language-select select").selectOption(locale);
    await searchCatalog(page, place.name);
    const card = page.locator(`[id="place-catalog-${place.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("place-visit-summary")).toContainText(
      "Wi-Fi",
    );
    await expect(card.getByTestId("place-visit-summary")).toContainText("24/7");
    await expect(card.getByTestId("place-visit-summary")).toContainText(
      t(locale, "toilets"),
    );
    await expect(
      card.getByRole("link", { name: "ODbL 1.0", exact: true }),
    ).toBeVisible();
    await card.getByRole("button", { name: t(locale, "details") }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByTestId("place-source-records")
      .locator(":scope > summary")
      .click();
    const wifi = dialog
      .locator(".fact")
      .filter({ has: page.locator("strong", { hasText: /^Wi-Fi$/ }) });
    await expect(wifi.locator(".fact-status")).toHaveText(t(locale, "known"));
    await expect(wifi.locator("p").first()).toHaveText(t(locale, "yes"));
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(audit.violations).toEqual([]);
    await expect(
      dialog.locator(".fact-heading strong").filter({ hasText: /^osm:/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`real-amenities-${locale}-mobile.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");

    await searchCatalog(page, "Drinkit");
    const unknownCard = page.locator(
      '[id="place-catalog-osm:node/11783576043"]',
    );
    await expect(unknownCard).toBeVisible();
    await expect(
      unknownCard
        .getByTestId("place-visit-summary")
        .locator("dt")
        .filter({ hasText: /^Wi-Fi$/ }),
    ).toHaveCount(0);
    await unknownCard
      .getByRole("button", { name: t(locale, "details") })
      .click();
    await page
      .getByRole("dialog")
      .getByTestId("unknown-place-facts")
      .locator(":scope > summary")
      .click();
    const unknownWifi = page
      .getByRole("dialog")
      .locator(".fact")
      .filter({ has: page.locator("strong", { hasText: /^Wi-Fi$/ }) });
    await expect(unknownWifi.locator(".fact-status")).toHaveText(
      t(locale, "unknown"),
    );
    await expect(unknownWifi.locator(":scope > p")).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
  });
}

test("real description preserves source language, exact provenance and catalog reset", async ({
  page,
  request,
}, testInfo) => {
  const response = await request.get(
    `/api/v1/places/${encodeURIComponent("osm:way/1460537088")}`,
  );
  expect(response.status()).toBe(200);
  const place = (await response.json()) as Place;
  expect(place.description).toBeTruthy();
  const englishSource = place.facts.find(
    (fact) => fact.key === "wikidata:description:en",
  );
  expect(englishSource?.status).toBe("known");
  await page.goto("/");
  await searchCatalog(page, place.name);
  const card = page.locator(`[id="place-catalog-${place.id}"]`);
  await expect(card.locator(".source-description")).toContainText(
    String(englishSource?.value),
  );
  await card.getByRole("button", { name: t("ru", "details") }).click();
  const description = page.getByRole("dialog").locator(".source-description");
  await expect(description).toContainText("Текст сохранён на языке источника.");
  const source = place.evidence.find((item) =>
    englishSource?.evidence_ids.includes(item.id),
  )!;
  await expect(description.locator("a")).toHaveAttribute(
    "href",
    source.source_url,
  );
  await page.screenshot({
    path: testInfo.outputPath("real-source-description.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await searchCatalog(page, "zzzz-no-such-catalog-name-7391");
  await expect(
    page.getByText(t("ru", "catalogNoMatch"), { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: t("ru", "catalogShowAll") }).click();
  await expect(
    page.locator(".catalog-cards").getByTestId("place-card").first(),
  ).toBeVisible();
  await expect(page.locator("#catalog-query")).toHaveValue("");
});

test("official botanical visit details keep greenhouse hours separate and expose verified contacts", async ({
  page,
  request,
}, testInfo) => {
  const response = await request.get(
    `/api/v1/places/${encodeURIComponent("osm:way/1196402246")}`,
  );
  expect(response.status()).toBe(200);
  const place = (await response.json()) as Place;
  const hours = place.facts.find(
    (fact) => fact.key === "official:greenhouse_hours",
  )!;
  const phone = place.facts.find((fact) => fact.key === "official:phone")!;
  const description = place.facts.find(
    (fact) => fact.key === "official:description:ru",
  )!;
  expect([hours.status, phone.status, description.status]).toEqual([
    "known",
    "known",
    "known",
  ]);
  await page.goto("/");
  await searchCatalog(page, place.name);
  const card = page.locator(`[id="place-catalog-${place.id}"]`);
  await card.getByRole("button", { name: t("ru", "details") }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".source-description")).toContainText(
    String(description.value),
  );
  const guide = dialog.getByTestId("place-visit-guide");
  await expect(guide.getByRole("link", { name: /Позвонить/ })).toHaveAttribute(
    "href",
    `tel:${String(phone.value).replace(/[^+\d]/g, "")}`,
  );
  await expect(guide).toContainText(String(hours.value));
  await expect(guide).toContainText("Часы оранжереи");
  await expect(
    guide.getByRole("link", { name: "Официальный сайт", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByTestId("place-source-records")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(
    guide.getByText("Идея для посещения", { exact: true }),
  ).toBeVisible();
  await expect(guide).toContainText(
    "Предложение по категории места, а не подтверждённая услуга.",
  );
  await guide
    .getByRole("heading", { name: "Полезно перед визитом", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("botanical-practical-card.png"),
    fullPage: true,
  });
});

test("real Wi-Fi requirement is honored and unknown outlets produce an explained no-match", async ({
  page,
  request,
}, testInfo) => {
  const response = await request.get(
    `/api/v1/places/${encodeURIComponent("osm:way/1395465867")}`,
  );
  expect(response.status()).toBe(200);
  const place = (await response.json()) as Place;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await fillWalk(page, place, "Estet Coffee");
  await page.locator(".strict-constraints > summary").click();
  await page
    .getByRole("combobox", { name: "Wi-Fi", exact: true })
    .selectOption("required");
  const firstResponse = page.waitForResponse(
    (res) =>
      res.url().endsWith("/recommendations") &&
      res.request().method() === "POST",
  );
  await page.locator(".find-button").click();
  const result = (await (await firstResponse).json()) as RecommendationResponse;
  expect(["matched", "partial"]).toContain(result.status);
  expect(
    result.recommendations.some((item) => item.place_id === place.id),
  ).toBe(true);
  for (const item of result.recommendations)
    expect(item.constraint_evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "has_wifi",
          strength: "required",
          outcome: "satisfied",
        }),
      ]),
    );
  await expect(
    page.locator(".result-cards").getByTestId("place-card").first(),
  ).toBeVisible();

  if (
    (await page.locator(".filter-toggle").getAttribute("aria-expanded")) !==
    "true"
  )
    await page.locator(".filter-toggle").click();
  const strict = page.locator(".strict-constraints");
  if ((await strict.getAttribute("open")) === null)
    await strict.locator(":scope > summary").click();
  await page
    .getByRole("combobox", { name: t("ru", "has_power_outlets"), exact: true })
    .selectOption("required");
  const noMatchResponse = page.waitForResponse(
    (res) =>
      res.url().endsWith("/recommendations") &&
      res.request().method() === "POST",
  );
  await page.locator(".find-button").click();
  const noMatch = (await (
    await noMatchResponse
  ).json()) as RecommendationResponse;
  expect(noMatch.status).toBe("no_match");
  await expect(
    page.locator(".result-cards").getByTestId("place-card"),
  ).toHaveCount(0);
  await expect(
    page.getByText(t("ru", "noMatchHint"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", {
      name: t("ru", "has_power_outlets"),
      exact: true,
    }),
  ).toHaveValue("required");
  await expect(
    page.locator(".results > .warnings, .results .warnings").first(),
  ).toHaveAttribute("open", "");
  await page
    .getByText(t("ru", "noMatchHint"), { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByText(t("ru", "noMatchHint"), { exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("real-no-match-mobile.png"),
    fullPage: true,
  });
});
