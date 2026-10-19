import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Place, PlacePhotoResponse } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { fetchPlacePhoto } from "@/lib/place-photo";
import PlacePhoto from "./place-photo";

vi.mock("@/lib/place-photo", async (original) => ({
  ...(await original<typeof import("@/lib/place-photo")>()),
  fetchPlacePhoto: vi.fn(),
}));
const fetcher = vi.mocked(fetchPlacePhoto);
const seed = examples.cases.find(
  (entry) => entry.name === "recommendations_valid",
)!.instance as { places: Place[] };
const photo: PlacePhotoResponse = {
  status: "available",
  photo: {
    url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Garden.jpg/960px-Garden.jpg",
    source_url: "https://commons.wikimedia.org/wiki/File:Garden.jpg",
    author: "Demir Berisha",
    license: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0",
    alt: "Фотография: Ботанический сад",
  },
};

function realPlace(): Place {
  const place = structuredClone(seed.places[0]);
  place.id = "osm:way/1196402246";
  place.name = "Ботанический сад";
  place.is_synthetic = false;
  place.categories = ["park"];
  place.facts = [
    {
      key: "osm:wikidata",
      status: "known",
      value: "Q104866948",
      evidence_ids: ["source"],
    },
  ];
  place.evidence = [
    {
      ...place.evidence[0],
      id: "source",
      source_type: "osm",
      is_synthetic: false,
    },
  ];
  return place;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["ru", "Иллюстрация категории"],
  ["kk", "Санат иллюстрациясы"],
  ["en", "Category illustration"],
] as const)(
  "labels category covers truthfully in %s without fetching synthetic places",
  (locale, text) => {
    render(<PlacePhoto place={seed.places[0]} locale={locale} />);
    expect(screen.getByText(text, { exact: false })).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("shows loaded real photographs with visible author, linked licence and source", async () => {
  fetcher.mockResolvedValue(photo);
  render(<PlacePhoto place={realPlace()} locale="ru" />);
  const image = await waitFor(() => {
    const value = document.querySelector("img");
    expect(value).not.toBeNull();
    return value!;
  });
  fireEvent.load(image);
  expect(screen.getByRole("img", { name: photo.photo!.alt })).toBeVisible();
  expect(
    screen.getByText("Фото: Demir Berisha", { exact: false }),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute(
    "href",
    photo.photo!.license_url,
  );
  expect(
    screen.getByRole("link", {
      name: "Оригинал и авторство: Ботанический сад",
    }),
  ).toHaveAttribute("href", photo.photo!.source_url);
  expect(
    screen.queryByText("Иллюстрация категории", { exact: false }),
  ).not.toBeInTheDocument();
});

it("keeps an illustrated card when image loading or provider lookup fails", async () => {
  fetcher.mockResolvedValue(photo);
  const { rerender } = render(<PlacePhoto place={realPlace()} locale="ru" />);
  await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
  fireEvent.error(document.querySelector("img")!);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(
    screen.getByText("Иллюстрация категории", { exact: false }),
  ).toBeVisible();
  fetcher.mockRejectedValue(new Error("unavailable"));
  rerender(<PlacePhoto place={realPlace()} locale="en" />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(
    screen.getByText("Category illustration", { exact: false }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("requests only visible covers when IntersectionObserver is available", async () => {
  let visible: (entries: { isIntersecting: boolean }[]) => void = () =>
    undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof visible) {
        visible = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  fetcher.mockResolvedValue({ status: "unavailable", photo: null });
  render(<PlacePhoto place={realPlace()} locale="ru" />);
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => visible([{ isIntersecting: true }]));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("cancels obsolete lookups and cannot render an old place photograph", async () => {
  let resolve: (value: PlacePhotoResponse) => void = () => undefined;
  fetcher.mockImplementation(
    (_id, _locale, signal) =>
      new Promise((done) => {
        resolve = done;
        expect(signal.aborted).toBe(false);
      }),
  );
  const { rerender } = render(<PlacePhoto place={realPlace()} locale="ru" />);
  const signal = fetcher.mock.calls[0][2];
  rerender(<PlacePhoto place={seed.places[0]} locale="ru" />);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(photo));
  expect(document.querySelector("img")).toBeNull();
  expect(
    screen.getByText("Иллюстрация категории", { exact: false }),
  ).toBeVisible();
});
