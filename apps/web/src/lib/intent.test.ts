import { afterEach, expect, it, vi } from "vitest";
import type { IntentResponse } from "@astana/api-client";
import { applyIntentConstraints, interpretIntent } from "./intent";

const query = "30 минут в помещении с розеткой";
const result: IntentResponse = {
  provider: "rules",
  locale: "ru",
  available_seconds: 1800,
  time_evidence: "30 минут",
  anchor_text: null,
  categories: ["cafe"],
  clarification_questions: [],
  warnings: [],
  constraints: [
    {
      constraint: { key: "indoor", value: true, strength: "preferred" },
      source_quote: "в помещении",
    },
  ],
};
afterEach(() => vi.unstubAllGlobals());

it("sends only text and locale to the same-origin intent endpoint", async () => {
  const fetcher = vi.fn(async () => Response.json(result));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    interpretIntent(query, "ru", new AbortController().signal),
  ).resolves.toEqual(result);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/intent",
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ query, locale: "ru" }),
    }),
  );
});

it.each([
  [
    "nonboolean condition",
    {
      constraints: [
        {
          constraint: { key: "indoor", value: "true", strength: "required" },
          source_quote: "в помещении",
        },
      ],
    },
  ],
  [
    "negative condition",
    {
      constraints: [
        {
          constraint: { key: "indoor", value: false, strength: "required" },
          source_quote: "в помещении",
        },
      ],
    },
  ],
  [
    "unknown condition",
    {
      constraints: [
        {
          constraint: {
            key: "invented_feature",
            value: true,
            strength: "required",
          },
          source_quote: "в помещении",
        },
      ],
    },
  ],
  [
    "invented quote",
    {
      constraints: [
        {
          constraint: { key: "indoor", value: true, strength: "required" },
          source_quote: "I never wrote this",
        },
      ],
    },
  ],
  ["unsupported time", { time_evidence: "two hours" }],
  ["different language", { locale: "en" }],
])(
  "rejects %s rather than applying an unsafe proposal",
  async (_name, patch) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...result, ...patch })),
    );
    await expect(
      interpretIntent(query, "ru", new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
  },
);

it("never lowers an existing required condition while adding new understood keys", () => {
  const current = {
    indoor: "required",
    wheelchair_accessible: "required",
    free_entry: "preferred",
  } as const;
  expect(
    applyIntentConstraints(current, [
      { key: "indoor", value: true, strength: "preferred" },
      { key: "has_power_outlets", value: true, strength: "required" },
      { key: "quiet", value: true, strength: "preferred" },
    ]),
  ).toEqual({ ...current, has_power_outlets: "required", quiet: "preferred" });
  expect(current).toEqual({
    indoor: "required",
    wheelchair_accessible: "required",
    free_entry: "preferred",
  });
});
