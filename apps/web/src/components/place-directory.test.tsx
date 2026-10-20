import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { MapFeatureResponse, Place } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { locales } from "@/lib/i18n";
import PlaceDirectory, { directoryText } from "./place-directory";
import { PlaceFacts } from "./details";

function response(): MapFeatureResponse {
  return {
    status: "ok",
    retrieved_at: "2026-10-20T10:00:00Z",
    attribution: "© 2ГИС",
    features: [123, 456].map((id, index) => ({
      id: `twogis:branch:${id}`,
      name: `Candidate ${id}`,
      kind: "cafe",
      description:
        index === 0 ? "Source description <script>alert(1)</script>" : null,
      address: `Street ${index + 1}`,
      location: { lat: 51.13, lon: 71.44 },
      match: "nearby",
      distance_meters: 15 + index,
      attributes:
        index === 0
          ? [
              {
                label: "Часы работы",
                value: "Пн: 09:00–18:00; 25.10: 10:00–14:00",
              },
            ]
          : [],
      source_url: `https://2gis.kz/astana/firm/${id}`,
      source_label: "2ГИС",
    })),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
for (const locale of locales)
  it(`shows separate attributed candidates only after an explicit click in ${locale}`, async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(response()));
    vi.stubGlobal("fetch", fetcher);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    const { container } = render(
      <PlaceDirectory placeId="osm:way/987" locale={locale} />,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const panel = screen.getByTestId("place-directory");
    expect(within(panel).getByRole("link", { name: "2ГИС" })).toHaveAttribute(
      "href",
      "https://dev.2gis.ru",
    );
    await user.click(
      within(panel).getByRole("button", {
        name: directoryText(locale, "check"),
      }),
    );
    const first = await within(panel).findByRole("article", {
      name: "Candidate 123",
    });
    expect(within(first).getByText("Street 1")).toBeVisible();
    expect(within(first).getByText(/15 /)).toHaveTextContent(
      directoryText(locale, "distance"),
    );
    expect(
      within(first).getByText("Пн: 09:00–18:00; 25.10: 10:00–14:00"),
    ).toBeVisible();
    expect(
      within(first).getByText(directoryText(locale, "hoursNote")),
    ).toBeVisible();
    expect(within(first).getByRole("link")).toHaveAttribute(
      "href",
      "https://2gis.kz/astana/firm/123",
    );
    expect(
      within(first).getByText("Source description <script>alert(1)</script>"),
    ).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
    const second = within(panel).getByRole("article", {
      name: "Candidate 456",
    });
    expect(within(second).getByText("Street 2")).toBeVisible();
    expect(
      within(second).getByText(directoryText(locale, "noDetails")),
    ).toBeVisible();
    expect(
      within(second).queryByText("Пн: 09:00–18:00; 25.10: 10:00–14:00"),
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByText(directoryText(locale, "candidates")),
    ).toBeVisible();
    expect(within(panel).getByRole("status")).toHaveTextContent(
      directoryText(locale, "found").replace("{count}", "2"),
    );
    expect(fetcher.mock.calls[0][1].body).toBe(
      JSON.stringify({ place_id: "osm:way/987", locale }),
    );
    expect(storage).not.toHaveBeenCalled();
  });
it("does not mutate catalogue facts or load anything when PlaceFacts opens", () => {
  const source = examples.cases.find((item) => item.name === "itinerary_valid")!
    .instance as { places: Place[] };
  const place = structuredClone(source.places[0]);
  const before = structuredClone(place);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<PlaceFacts place={place} locale="ru" />);
  expect(
    screen.getByRole("button", { name: directoryText("ru", "check") }),
  ).toBeVisible();
  expect(place).toEqual(before);
  expect(fetcher).not.toHaveBeenCalled();
});
it("prevents duplicate requests and cancellation ignores a late response", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<PlaceDirectory placeId="osm:way/987" locale="ru" />);
  const check = screen.getByRole("button", {
    name: directoryText("ru", "check"),
  });
  fireEvent.click(check);
  fireEvent.click(check);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(check).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    directoryText("ru", "loading"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: directoryText("ru", "cancel") }),
  );
  expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
  await act(async () => finish(Response.json(response())));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    directoryText("ru", "cancelled"),
  );
  expect(
    screen.getByRole("button", { name: directoryText("ru", "retry") }),
  ).toBeEnabled();
});
it("aborts and resets on place and language changes, ignores stale completion, and aborts on unmount", async () => {
  const requests: { signal: AbortSignal; finish: () => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({
            signal: init.signal!,
            finish: () => resolve(Response.json(response())),
          }),
        ),
    ),
  );
  const { rerender, unmount } = render(
    <PlaceDirectory placeId="osm:way/1" locale="ru" />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: directoryText("ru", "check") }),
  );
  rerender(<PlaceDirectory placeId="osm:way/2" locale="ru" />);
  expect(requests[0].signal.aborted).toBe(true);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  fireEvent.click(
    screen.getByRole("button", { name: directoryText("ru", "check") }),
  );
  await act(async () => requests[1].finish());
  expect(screen.getAllByRole("article")).toHaveLength(2);
  rerender(<PlaceDirectory placeId="osm:way/2" locale="en" />);
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  await act(async () => requests[0].finish());
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: directoryText("en", "check") }),
  );
  unmount();
  expect(requests[2].signal.aborted).toBe(true);
});
it.each([
  [429, "busy"],
  [503, "unavailable"],
] as const)(
  "offers retry for HTTP %s without leaking provider messages",
  async (status, key) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("private upstream error", { status }))
      .mockResolvedValueOnce(
        Response.json({ ...response(), status: "empty", features: [] }),
      );
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<PlaceDirectory placeId="osm:way/1" locale="ru" />);
    await user.click(
      screen.getByRole("button", { name: directoryText("ru", "check") }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      directoryText("ru", key),
    );
    expect(
      screen.queryByText("private upstream error"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: directoryText("ru", "retry") }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      directoryText("ru", "empty"),
    );
    expect(
      screen.getByRole("button", { name: directoryText("ru", "retry") }),
    ).toBeEnabled();
  },
);

it("a cancelled response cannot overwrite a newer retry or clear its busy state", async () => {
  const pending: ((value: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    ),
  );
  render(<PlaceDirectory placeId="osm:way/1" locale="ru" />);
  fireEvent.click(
    screen.getByRole("button", { name: directoryText("ru", "check") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: directoryText("ru", "cancel") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: directoryText("ru", "retry") }),
  );
  await act(async () => pending[0](Response.json(response())));
  expect(screen.getByRole("status")).toHaveTextContent(
    directoryText("ru", "loading"),
  );
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  const newer = response();
  newer.features[0].name = "New branch";
  await act(async () => pending[1](Response.json(newer)));
  expect(screen.getByRole("article", { name: "New branch" })).toBeVisible();
  expect(
    screen.queryByRole("article", { name: "Candidate 123" }),
  ).not.toBeInTheDocument();
});
