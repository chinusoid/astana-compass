import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { IntentResponse } from "@astana/api-client";
import IntentReview from "./intent-review";
import { intentText } from "@/lib/intent-copy";
import { locales } from "@/lib/i18n";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const query = "30 минут рядом с Байтереком, в помещении";
const response: IntentResponse = {
  provider: "rules",
  locale: "ru",
  available_seconds: 1800,
  time_evidence: "30 минут",
  anchor_text: "Байтереком",
  categories: ["museum"],
  constraints: [
    {
      constraint: { key: "indoor", value: true, strength: "preferred" },
      source_quote: "в помещении",
    },
  ],
  clarification_questions: ["В какой части города?"],
  warnings: [],
};

for (const locale of locales)
  it(`requires explicit review and labels rule fallback in ${locale}`, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...response, locale })),
    );
    const apply = vi.fn();
    const user = userEvent.setup();
    render(<IntentReview query={query} locale={locale} onApply={apply} />);
    await user.click(
      screen.getByRole("button", { name: intentText(locale, "analyze") }),
    );
    expect(await screen.findByText(intentText(locale, "rules"))).toBeVisible();
    expect(screen.getByText(intentText(locale, "anchorHint"))).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
    const time = screen.getByRole("checkbox", {
      name: new RegExp(intentText(locale, "useTime")),
    });
    expect(time).not.toBeChecked();
    await user.click(
      screen.getByRole("button", { name: intentText(locale, "apply") }),
    );
    expect(apply).toHaveBeenLastCalledWith({
      constraints: [response.constraints[0].constraint],
      available_seconds: null,
    });
    await user.click(time);
    await user.click(
      screen.getByRole("button", { name: intentText(locale, "apply") }),
    );
    expect(apply).toHaveBeenLastCalledWith({
      constraints: [response.constraints[0].constraint],
      available_seconds: 1800,
    });
  });

it("ignores a delayed interpretation after the query changes", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const apply = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <IntentReview query={query} locale="ru" onApply={apply} />,
  );
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  );
  rerender(
    <IntentReview query="Другое пожелание" locale="ru" onApply={apply} />,
  );
  await act(async () => {
    resolve(Response.json(response));
  });
  expect(
    screen.queryByRole("button", { name: intentText("ru", "apply") }),
  ).not.toBeInTheDocument();
  expect(apply).not.toHaveBeenCalled();
});

it("can retry the original query after an edit without an aborted reply clearing the new request", async () => {
  const pending: Array<{
    resolve: (response: Response) => void;
    signal: AbortSignal;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({ resolve, signal: options.signal as AbortSignal });
        }),
    ),
  );
  const apply = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <IntentReview query={query} locale="ru" onApply={apply} />,
  );
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  );
  rerender(
    <IntentReview query="Другое пожелание" locale="ru" onApply={apply} />,
  );
  expect(pending[0].signal.aborted).toBe(true);
  rerender(<IntentReview query={query} locale="ru" onApply={apply} />);
  const retry = screen.getByRole("button", {
    name: intentText("ru", "analyze"),
  });
  expect(retry).toBeEnabled();
  await user.click(retry);
  expect(pending).toHaveLength(2);

  // The old transport may resolve even after abort; it must neither publish
  // suggestions nor reset the loading indicator for the newer request.
  await act(async () => pending[0].resolve(Response.json(response)));
  expect(
    screen.getByRole("button", { name: intentText("ru", "analyzing") }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: intentText("ru", "apply") }),
  ).not.toBeInTheDocument();
  await act(async () => pending[1].resolve(Response.json(response)));
  expect(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: intentText("ru", "apply") }),
  ).toBeVisible();
  expect(apply).not.toHaveBeenCalled();
});

it("ignores an older rejection after switching locales and completing a new request", async () => {
  const pending: Array<{
    resolve: (response: Response) => void;
    reject: (reason: Error) => void;
    signal: AbortSignal;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          pending.push({
            resolve,
            reject,
            signal: options.signal as AbortSignal,
          });
        }),
    ),
  );
  const apply = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <IntentReview query={query} locale="ru" onApply={apply} />,
  );
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  );
  rerender(<IntentReview query={query} locale="en" onApply={apply} />);
  expect(pending[0].signal.aborted).toBe(true);
  rerender(<IntentReview query={query} locale="ru" onApply={apply} />);
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  );
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].resolve(Response.json(response)));
  await act(async () =>
    pending[0].reject(new Error("Delayed network failure")),
  );

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: intentText("ru", "analyze") }),
  ).toBeEnabled();
  await user.click(
    screen.getByRole("button", { name: intentText("ru", "apply") }),
  );
  expect(apply).toHaveBeenCalledExactlyOnceWith({
    constraints: [response.constraints[0].constraint],
    available_seconds: null,
  });
});
