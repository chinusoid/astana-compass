import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distribution = resolve(
  dirname(fileURLToPath(import.meta.resolve("maplibre-gl/package.json"))),
  "dist",
);
const destination = resolve(import.meta.dirname, "../public/maplibre");
await mkdir(destination, { recursive: true });
// MapLibre 6's module worker imports its sibling shared module. Serve both from
// our own origin, copied from the pinned dependency; never fetch executable CDN code.
for (const name of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  await copyFile(resolve(distribution, name), resolve(destination, name));
}
