import { test, expect } from "../../apps/web/e2e-support";

test.skip(
  !process.env.ASTANA_LIVE_WEB_URL,
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
