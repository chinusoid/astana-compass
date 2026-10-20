import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: "ios.spec.ts",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "test-results/ios",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/ios" }],
  ],
  projects: [
    {
      name: "iPhone WebKit",
      use: { ...devices["iPhone 13"], browserName: "webkit" },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:43106",
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm start --port 43106",
    url: "http://127.0.0.1:43106",
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      ASTANA_ALLOW_FIXTURES: "true",
      ASTANA_MAP_PROVIDER: "none",
      ASTANA_API_URL: "http://127.0.0.1:8000",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
