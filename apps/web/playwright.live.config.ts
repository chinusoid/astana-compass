import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: "live.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 45000,
  outputDir: "test-results/live",
  reporter: "list",
  use: {
    baseURL: process.env.ASTANA_LIVE_WEB_URL ?? "http://127.0.0.1:3105",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
});
