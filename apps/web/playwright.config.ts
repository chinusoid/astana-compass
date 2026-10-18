import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: "frontend.spec.ts",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "test-results",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:43103",
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "America/New_York",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: ["--enable-unsafe-swiftshader"],
    },
  },
  webServer: [
    {
      command: "pnpm start --port 43103",
      url: "http://127.0.0.1:43103",
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        ASTANA_ALLOW_FIXTURES: "true",
        ASTANA_MAP_PROVIDER: "none",
        ASTANA_API_URL: process.env.ASTANA_API_URL ?? "http://127.0.0.1:8000",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
    {
      command: "pnpm start --port 43104",
      url: "http://127.0.0.1:43104",
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        ASTANA_ALLOW_FIXTURES: "false",
        ASTANA_MAP_PROVIDER: "none",
        ASTANA_API_URL: process.env.ASTANA_API_URL ?? "http://127.0.0.1:8000",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
