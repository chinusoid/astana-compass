// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import examples from "../../../../contracts.examples.json";
import schema from "../../../../contracts.schema.json";
import { valid, type Definition } from "./contracts";

const require = createRequire(import.meta.url);
const generatedPath = fileURLToPath(
  new URL("./generated/validators.cjs", import.meta.url),
);
const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const generatorPath = fileURLToPath(
  new URL("../../scripts/generate-validators.mjs", import.meta.url),
);

describe("standalone validators for runtimes without dynamic evaluation", () => {
  it("checks in reproducible output of every canonical definition", () => {
    expect(
      execFileSync(process.execPath, [generatorPath, "--check"], {
        cwd: webRoot,
        encoding: "utf8",
      }),
    ).toContain(
      `Verified ${Object.keys(schema.$defs).length} canonical standalone validators`,
    );
    expect(Object.keys(require(generatedPath)).sort()).toEqual(
      Object.keys(schema.$defs).sort(),
    );
  });

  it("imports and validates in a fresh runtime that prohibits eval and Function", () => {
    // Includes Ajv's small runtime/format helpers, so this catches a compiler
    // accidentally creeping into the generated module's dependency graph too.
    const code = `
      const assert = require("node:assert/strict");
      assert.throws(() => new Function("return true"), EvalError);
      assert.throws(() => eval("true"), EvalError);
      const validators = require(process.argv[1]);
      const examples = require(process.argv[2]);
      for (const example of examples.cases) {
        if (example.valid || example.failure_stage === "schema") {
          assert.equal(validators[example.definition](example.instance), example.valid, example.name);
        }
      }
      assert.equal(validators.Location({lat:51.1283,lon:71.4305}), true);
      assert.equal(validators.Location({lat:"51.1283",lon:71.4305}), false);
      console.log("Canonical validation runs without dynamic code generation.");
    `;
    const examplePath = fileURLToPath(
      new URL("../../../../contracts.examples.json", import.meta.url),
    );
    expect(
      execFileSync(
        process.execPath,
        [
          "--disallow-code-generation-from-strings",
          "-e",
          code,
          generatedPath,
          examplePath,
        ],
        { cwd: webRoot, encoding: "utf8" },
      ),
    ).toContain("Canonical validation runs without dynamic code generation.");
  });

  it("preserves the previous compiler's schema and format behavior", () => {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: false,
      validateFormats: true,
    });
    addFormats(ajv);
    ajv.addSchema(schema, "canonical");
    for (const name of Object.keys(schema.$defs) as Definition[]) {
      const compiled = ajv.getSchema(`canonical#/$defs/${name}`)!;
      const candidates = [
        null,
        [],
        {},
        true,
        false,
        0,
        "",
        "unexpected",
        ...examples.cases
          .filter((example) => example.definition === name)
          .map((example) => example.instance),
      ];
      for (const candidate of candidates)
        expect(valid(name, candidate), name).toBe(Boolean(compiled(candidate)));
    }
    expect(valid("Location", { lat: "51.12", lon: 71.43 })).toBe(false);
    expect(valid("Location", { lat: 51.12, lon: 71.43, extra: true })).toBe(
      false,
    );
    const response = structuredClone(
      examples.cases.find(
        (example) => example.name === "recommendations_valid",
      )!.instance,
    );
    expect(valid("RecommendationResponse", response)).toBe(true);
    Object.assign(response, { generated_at: "not-an-instant" });
    expect(valid("RecommendationResponse", response)).toBe(false);
  });

  it("does not mistake inherited object methods for canonical definitions", () => {
    expect(valid("toString" as Definition, {})).toBe(false);
    expect(valid("constructor" as Definition, {})).toBe(false);
    expect(valid("missing" as Definition, {})).toBe(false);
  });
});
