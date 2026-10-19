import { defineConfig } from "@playwright/test";
import path from "node:path";

export function createLiveConfig(
  local = process.env.ASTANA_LIVE_LOCAL === "true",
) {
  // Inherited by test workers so the external-target skip also accepts this harness.
  if (local) process.env.ASTANA_LIVE_LOCAL = "true";
  const root = path.resolve(import.meta.dirname, "../..");
  const python = path.join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  return defineConfig({
    testDir: "../../tests/e2e",
    testMatch: "live.spec.ts",
    workers: 1,
    retries: 0,
    timeout: 45000,
    outputDir: "test-results/live",
    reporter: "list",
    use: {
      baseURL: local
        ? "http://127.0.0.1:43105"
        : (process.env.ASTANA_LIVE_WEB_URL ?? "http://127.0.0.1:3105"),
      viewport: { width: 1440, height: 1000 },
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      launchOptions: {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        args: ["--enable-unsafe-swiftshader"],
      },
    },
    webServer: local
      ? [
          {
            command: `"${python}" -m uvicorn astana_api.app:create_app --factory --host 127.0.0.1 --port 18082 --no-access-log`,
            cwd: root,
            url: "http://127.0.0.1:18082/v1/health/ready",
            reuseExistingServer: false,
            timeout: 30000,
            env: {
              ASTANA_MODE: "live",
              ASTANA_POI_PATH: path.join(root, "data/samples/astana-osm.json"),
              ASTANA_REPOSITORY_FACTORY: "astana_city_data:create_repository",
              ASTANA_RETRIEVER_FACTORY: "astana_retrieval:create_retriever",
              ASTANA_CONTEXT_FACTORY: "astana_city_context:create_context",
              LLM_PROVIDER: "none",
              OPENAI_API_KEY: "",
              NVIDIA_API_KEY: "",
              LLM_API_KEY: "",
              ROUTING_PROVIDER: "openrouteservice",
              ROUTING_API_KEY: "",
              ORS_API_KEY: "",
              TOMTOM_API_KEY: "",
              ASTANA_WEATHER_ENABLED: "false",
              ASTANA_ROUTE_ALLOW_APPROXIMATE: "true",
            },
          },
          {
            command: "pnpm start --port 43105",
            cwd: import.meta.dirname,
            url: "http://127.0.0.1:43105",
            reuseExistingServer: false,
            timeout: 30000,
            env: {
              ASTANA_API_URL: "http://127.0.0.1:18082",
              ASTANA_ALLOW_FIXTURES: "false",
              ASTANA_MAP_PROVIDER: "none",
              NEXT_TELEMETRY_DISABLED: "1",
            },
          },
        ]
      : undefined,
  });
}

export default createLiveConfig();
