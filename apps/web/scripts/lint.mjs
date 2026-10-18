import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const eslint = path.join(
  path.dirname(require.resolve("eslint/package.json")),
  "bin/eslint.js",
);
const webRoot = path.resolve(import.meta.dirname, "..");

for (const cwd of [webRoot, path.resolve(webRoot, "../../tests/e2e")]) {
  const result = spawnSync(process.execPath, [eslint, "."], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
