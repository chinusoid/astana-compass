export { test, expect, type Page, type Route } from "@playwright/test";
export { default as AxeBuilder } from "@axe-core/playwright";
import { spawn } from "node:child_process";
import path from "node:path";

export async function generationFault(
  failure: string,
  original: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.ASTANA_E2E_PYTHON ?? path.resolve("../../.venv/bin/python"),
      [
        path.resolve(process.cwd(), "../../tests/e2e/generation_response.py"),
        failure,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Synthetic generator replay timed out"));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Synthetic generator replay failed: ${errors}`));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("Invalid synthetic replay response"));
      }
    });
    child.stdin.end(JSON.stringify(original));
  });
}
export type {
  RecommendationResponse,
  RecommendationRequest,
  ItineraryResponse,
  ItineraryRequest,
} from "@astana/api-client";
