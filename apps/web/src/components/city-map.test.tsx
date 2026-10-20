import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import type { Place, RouteEstimate } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { BUILDING_LAYER } from "@/lib/map-style";
import { mapText } from "@/lib/map-copy";
import { LOCATION_TIMEOUT_MS } from "@/lib/geolocation";
import CityMap from "./city-map";

const fake = vi.hoisted(() => ({
  maps: [] as MockMap[],
  markers: [] as MockMarker[],
  geolocates: [] as MockGeolocate[],
  resizeObservers: [] as (() => void)[],
}));
type Listener = (event?: unknown) => void;
class MockMap {
  options: Record<string, unknown>;
  events = new Map<string, Listener[]>();
  sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  layers = new Map<string, unknown>();
  canvas = document.createElement("canvas");
  center = { lng: 71.4305, lat: 51.1283 };
  zoom = 15.5;
  bearing = -18;
  addControl = vi.fn((control: unknown) => {
    if (control instanceof MockGeolocate)
      (this.options.container as HTMLElement).append(control.onAdd());
  });
  removeControl = vi.fn((control: MockGeolocate) => control.onRemove());
  addImage = vi.fn();
  setLayoutProperty = vi.fn();
  remove = vi.fn();
  resize = vi.fn();
  fitBounds = vi.fn();
  queryRenderedFeatures = vi.fn((): { geometry: unknown }[] => []);
  easeTo = vi.fn((options: { center?: [number, number]; zoom?: number }) => {
    if (options.center)
      this.center = { lng: options.center[0], lat: options.center[1] };
    if (options.zoom !== undefined) this.zoom = options.zoom;
  });
  getStyle = vi.fn(() =>
    typeof this.options.style === "string"
      ? {
          version: 8,
          sources: { openmaptiles: { type: "vector" } },
          layers: [
            {
              id: "building",
              type: "fill",
              source: "openmaptiles",
              "source-layer": "building",
            },
            {
              id: "building-3d",
              type: "fill-extrusion",
              source: "openmaptiles",
              "source-layer": "building",
            },
          ],
        }
      : this.options.style,
  );
  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.canvas.tabIndex = 0;
    (options.container as HTMLElement).append(this.canvas);
    fake.maps.push(this);
  }
  getCanvas() {
    return this.canvas;
  }
  getCenter() {
    return this.center;
  }
  getZoom() {
    return this.zoom;
  }
  getBearing() {
    return this.bearing;
  }
  getContainer() {
    return this.options.container as HTMLElement;
  }
  getPadding() {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  isStyleLoaded() {
    return true;
  }
  addSource(id: string) {
    this.sources.set(id, { setData: vi.fn() });
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addLayer(layer: { id: string }) {
    this.layers.set(layer.id, layer);
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  on(name: string, listener: Listener) {
    this.events.set(name, [...(this.events.get(name) ?? []), listener]);
  }
  emit(name: string, event?: unknown) {
    for (const listener of this.events.get(name) ?? []) listener(event);
  }
}
class MockPopup {
  on = vi.fn();
  content: HTMLElement | null = null;
  open = false;
  remove = vi.fn(() => {
    this.open = false;
  });
  isOpen() {
    return this.open;
  }
  setDOMContent(content: HTMLElement) {
    this.content = content;
    return this;
  }
}
class MockGeolocate {
  events = new Map<string, Listener>();
  button = document.createElement("button");
  onAdd = vi.fn(() => this.button);
  onRemove = vi.fn(() => this.button.remove());
  trigger = vi.fn(() => {
    if (this.button.disabled) return false;
    this.emit("trackuserlocationstart");
    return true;
  });
  constructor(readonly options: Record<string, unknown>) {
    this.button.addEventListener("click", () => this.trigger());
    fake.geolocates.push(this);
  }
  on(name: string, listener: Listener) {
    this.events.set(name, listener);
  }
  emit(name: string, event?: unknown) {
    if (name === "error" && (event as { code: number }).code === 1)
      this.button.disabled = true;
    this.events.get(name)?.(event);
  }
}
class MockMarker {
  element: HTMLElement;
  popup: MockPopup | null = null;
  togglePopup = vi.fn(() => {
    if (this.popup) this.popup.open = !this.popup.open;
  });
  getElement() {
    return this.element;
  }
  getPopup() {
    return this.popup;
  }
  remove = vi.fn(() => {
    this.popup?.remove();
    this.element.remove();
  });
  constructor(options: { element: HTMLElement }) {
    this.element = options.element;
    fake.markers.push(this);
  }
  setLngLat() {
    return this;
  }
  setPopup(popup: MockPopup) {
    this.popup = popup;
    return this;
  }
  addTo(map: MockMap) {
    (map.options.container as HTMLElement).append(this.element);
    return this;
  }
}
vi.mock("maplibre-gl", () => ({
  Map: class {
    constructor(options: Record<string, unknown>) {
      return new MockMap(options);
    }
  },
  Marker: class {
    constructor(options: { element: HTMLElement }) {
      return new MockMarker(options);
    }
  },
  Popup: class {
    constructor() {
      return new MockPopup();
    }
  },
  NavigationControl: class {},
  ScaleControl: class {},
  AttributionControl: class {},
  GeolocateControl: class {
    constructor(options: Record<string, unknown>) {
      return new MockGeolocate(options);
    }
  },
  setWorkerUrl: vi.fn(),
}));
beforeEach(() => {
  fake.maps.length = 0;
  fake.markers.length = 0;
  fake.geolocates.length = 0;
  fake.resizeObservers.length = 0;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(650);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        fake.resizeObservers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const props = (): ComponentProps<typeof CityMap> => ({
  places: [],
  origin: null,
  activeId: null,
  selectedIds: [],
  route: null,
  locale: "ru",
  picking: true,
  enabled: true,
  provider: "openfreemap",
  onEnable: vi.fn(),
  onPick: vi.fn(),
  onSelect: vi.fn(),
  onLocationFound: vi.fn(),
});
async function loadMap() {
  await waitFor(() => expect(fake.maps.length).toBeGreaterThan(0));
  const map = fake.maps.at(-1)!;
  act(() => map.emit("load"));
  await waitFor(() =>
    expect(screen.getByTestId("map-panel")).toHaveAttribute(
      "data-map-status",
      "ready",
    ),
  );
  return map;
}

it("adds user-controlled camera following without changing the route or starting point", async () => {
  const config = props();
  const watch = vi.fn();
  vi.stubGlobal("navigator", { geolocation: { watchPosition: watch } });
  const view = render(<CityMap {...config} picking={false} />);
  const map = await loadMap();
  const control = fake.geolocates[0];
  expect(control.options).toMatchObject({
    trackUserLocation: true,
    showUserLocation: true,
    showAccuracyCircle: true,
    positionOptions: { enableHighAccuracy: false, timeout: 10000 },
  });
  expect(map.addControl).toHaveBeenCalledWith(control, "top-right");
  expect(
    (map.options.locale as Record<string, string>)[
      "GeolocateControl.FindMyLocation"
    ],
  ).toBe(mapText("ru", "followLocation"));
  expect(watch).not.toHaveBeenCalled();
  act(() => control.emit("trackuserlocationstart"));
  expect(screen.getByText(mapText("ru", "followLoading"))).toBeVisible();
  expect(
    screen.queryByText(mapText("ru", "following")),
  ).not.toBeInTheDocument();
  act(() => control.emit("geolocate"));
  expect(screen.getByText(mapText("ru", "following"))).toBeVisible();
  act(() => control.emit("trackuserlocationend"));
  expect(screen.getByText(mapText("ru", "followPaused"))).toBeVisible();
  act(() => control.emit("error", { code: 2 }));
  expect(screen.getByText(mapText("ru", "followLoading"))).toBeVisible();
  expect(
    screen.queryByText(mapText("ru", "followUnavailable")),
  ).not.toBeInTheDocument();
  act(() => control.emit("geolocate"));
  expect(screen.getByText(mapText("ru", "followPaused"))).toBeVisible();
  expect(
    screen.queryByText(mapText("ru", "following")),
  ).not.toBeInTheDocument();
  act(() => control.emit("trackuserlocationstart"));
  act(() => control.emit("error", { code: 2 }));
  act(() => control.emit("geolocate"));
  expect(screen.getByText(mapText("ru", "following"))).toBeVisible();
  act(() => control.emit("error", { code: 1 }));
  expect(screen.getByText(mapText("ru", "followDenied"))).toBeVisible();
  act(() => control.emit("error", { code: 2 }));
  expect(screen.getByText(mapText("ru", "followDenied"))).toBeVisible();
  act(() => control.emit("geolocate"));
  expect(
    screen.queryByText(mapText("ru", "followDenied")),
  ).not.toBeInTheDocument();
  expect(config.onLocationFound).toHaveBeenCalledTimes(4);
  expect(config.onPick).not.toHaveBeenCalled();
  expect(config.onSelect).not.toHaveBeenCalled();
  view.unmount();
  // MapLibre's map.remove calls each native control's onRemove, which clears
  // its geolocation watch. The integration must always remove that map.
  expect(map.remove).toHaveBeenCalledOnce();
});

it("shows a terminal map error only after recovery expires and clears it on a late fix", async () => {
  const config = props();
  const view = render(<CityMap {...config} />);
  await loadMap();
  vi.useFakeTimers();
  const control = fake.geolocates[0];
  act(() => control.emit("trackuserlocationstart"));
  act(() => control.emit("error", { code: 2 }));
  act(() => vi.advanceTimersByTime(LOCATION_TIMEOUT_MS - 1));
  expect(screen.getByText(mapText("ru", "followLoading"))).toBeVisible();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText(mapText("ru", "followUnavailable"))).toBeVisible();
  act(() => control.emit("error", { code: 3 }));
  expect(screen.getByText(mapText("ru", "followUnavailable"))).toBeVisible();
  act(() => control.emit("geolocate"));
  expect(
    screen.queryByText(mapText("ru", "followUnavailable")),
  ).not.toBeInTheDocument();
  expect(screen.getByText(mapText("ru", "following"))).toBeVisible();
  act(() => vi.runOnlyPendingTimers());
  expect(screen.getByText(mapText("ru", "following"))).toBeVisible();
  act(() => control.emit("error", { code: 2 }));
  view.unmount();
  act(() => vi.runOnlyPendingTimers());
  act(() => control.emit("geolocate"));
  expect(config.onLocationFound).toHaveBeenCalledTimes(1);
});

it("replaces a denied map control after a planner fix so its button works again", async () => {
  const config = props();
  const view = render(<CityMap {...config} locationFoundRequest={0} />);
  const map = await loadMap();
  const control = fake.geolocates[0];
  act(() => control.emit("error", { code: 1 }));
  expect(screen.getByText(mapText("ru", "followDenied"))).toBeVisible();
  expect(control.button).toBeDisabled();
  map.easeTo.mockClear();
  view.rerender(<CityMap {...config} locationFoundRequest={1} />);
  expect(
    screen.queryByText(mapText("ru", "followDenied")),
  ).not.toBeInTheDocument();
  expect(map.removeControl).toHaveBeenCalledExactlyOnceWith(control);
  expect(control.onRemove).toHaveBeenCalledOnce();
  const replacement = fake.geolocates[1];
  expect(map.addControl).toHaveBeenLastCalledWith(replacement, "top-right");
  expect(replacement.button).toBeEnabled();
  act(() => control.emit("error", { code: 1 }));
  expect(
    screen.queryByText(mapText("ru", "followDenied")),
  ).not.toBeInTheDocument();
  fireEvent.click(replacement.button);
  expect(replacement.trigger).toHaveBeenCalledOnce();
  expect(screen.getByText(mapText("ru", "followLoading"))).toBeVisible();
  act(() => replacement.emit("geolocate"));
  expect(screen.getByText(mapText("ru", "following"))).toBeVisible();
  expect(config.onLocationFound).toHaveBeenCalledOnce();
  expect(map.easeTo).not.toHaveBeenCalled();
  expect(config.onPick).not.toHaveBeenCalled();
});

it("fits all three stops and origin without inventing a line for approximate routes", async () => {
  const seed = structuredClone(
    examples.cases.find((entry) => entry.name === "place_valid")!.instance,
  ) as Place;
  const places = [
    { ...seed, id: "synthetic:one", location: { lon: 71.43, lat: 51.13 } },
    { ...seed, id: "synthetic:two", location: { lon: 71.44, lat: 51.14 } },
    { ...seed, id: "synthetic:three", location: { lon: 71.45, lat: 51.15 } },
  ];
  const route = (
    examples.cases.find((entry) => entry.name === "recommendations_valid")!
      .instance as { recommendations: { route: RouteEstimate }[] }
  ).recommendations[0].route;
  const config = {
    ...props(),
    picking: false,
    places,
    route,
    origin: { lon: 71.42, lat: 51.12 },
    routeStopIds: places.map((place) => place.id),
  };
  const view = render(<CityMap {...config} overviewRequest={0} />);
  const map = await loadMap();
  const bounds = [
    [71.42, 51.12],
    [71.45, 51.15],
  ];
  await waitFor(() =>
    expect(map.fitBounds).toHaveBeenLastCalledWith(bounds, expect.anything()),
  );
  expect(screen.getByTestId("map-route-overview")).toBeEnabled();
  expect(screen.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "none",
  );
  const count = map.fitBounds.mock.calls.length;
  view.rerender(<CityMap {...config} overviewRequest={1} />);
  expect(map.fitBounds).toHaveBeenCalledTimes(count + 1);
  fireEvent.click(screen.getByTestId("map-route-overview"));
  expect(map.fitBounds).toHaveBeenCalledTimes(count + 2);
});

it("reframes sheet insets immediately while explicit route overview still animates", async () => {
  vi.mocked(window.matchMedia).mockReturnValue({
    matches: false,
  } as MediaQueryList);
  const seed = structuredClone(
    examples.cases.find((entry) => entry.name === "place_valid")!.instance,
  ) as Place;
  const route = (
    examples.cases.find((entry) => entry.name === "recommendations_valid")!
      .instance as { recommendations: { route: RouteEstimate }[] }
  ).recommendations[0].route;
  const config = { ...props(), places: [seed], route, routeStopIds: [seed.id] };
  const view = render(
    <CityMap {...config} bottomInset={132} overviewRequest={0} />,
  );
  const map = await loadMap();
  await waitFor(() =>
    expect(map.fitBounds).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 750 }),
    ),
  );
  const count = map.fitBounds.mock.calls.length;
  view.rerender(<CityMap {...config} bottomInset={450} overviewRequest={0} />);
  expect(map.fitBounds).toHaveBeenCalledTimes(count + 1);
  expect(map.fitBounds).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: 0 }),
  );
  view.rerender(<CityMap {...config} bottomInset={450} overviewRequest={1} />);
  expect(map.fitBounds).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: 750 }),
  );
});

it("fits the latest journey once a hidden mobile map becomes visible without recentering later resizes", async () => {
  const width = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockReturnValue(0);
  const height = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(0);
  const seed = structuredClone(
    examples.cases.find((entry) => entry.name === "place_valid")!.instance,
  ) as Place;
  const route = (
    examples.cases.find((entry) => entry.name === "recommendations_valid")!
      .instance as { recommendations: { route: RouteEstimate }[] }
  ).recommendations[0].route;
  const config = {
    ...props(),
    places: [seed],
    route,
    origin: { lon: 71.42, lat: 51.12 },
    routeStopIds: [seed.id],
  };
  const view = render(<CityMap {...config} />);
  const map = await loadMap();
  expect(map.fitBounds).not.toHaveBeenCalled();
  const latest = { ...seed, location: { lon: 71.45, lat: 51.15 } };
  view.rerender(<CityMap {...config} places={[latest]} />);
  expect(map.fitBounds).not.toHaveBeenCalled();
  width.mockReturnValue(390);
  height.mockReturnValue(170);
  act(() => fake.resizeObservers.forEach((notify) => notify()));
  expect(map.fitBounds).toHaveBeenCalledExactlyOnceWith(
    [
      [71.42, 51.12],
      [71.45, 51.15],
    ],
    expect.objectContaining({
      padding: { top: 50, right: 65, bottom: 35, left: 65 },
    }),
  );
  act(() => fake.resizeObservers.forEach((notify) => notify()));
  expect(map.fitBounds).toHaveBeenCalledOnce();
});

it("starts with real vector 3D and switches to genuinely flat footprints", async () => {
  render(<CityMap {...props()} />);
  const map = await loadMap();
  expect(map.options).toMatchObject({
    style: "https://tiles.openfreemap.org/styles/liberty",
    zoom: 15.5,
    pitch: 50,
  });
  expect(map.addControl).toHaveBeenCalledTimes(4);
  expect(screen.getByTestId("map-panel")).toHaveAttribute(
    "data-map-mode",
    "3d",
  );
  fireEvent.click(screen.getByTestId("map-mode-2d"));
  expect(map.setLayoutProperty).toHaveBeenLastCalledWith(
    BUILDING_LAYER,
    "visibility",
    "none",
  );
  expect(map.easeTo).toHaveBeenLastCalledWith({ pitch: 0, duration: 0 });
  fireEvent.click(screen.getByTestId("map-mode-3d"));
  expect(map.setLayoutProperty).toHaveBeenLastCalledWith(
    BUILDING_LAYER,
    "visibility",
    "visible",
  );
  fireEvent.click(screen.getByText(mapText("ru", "privacyLabel")));
  expect(screen.getByText(mapText("ru", "heights"))).toBeVisible();
});
it("accepts map clicks only during start selection and does not swap lat/lon", async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      status: "empty",
      features: [],
      retrieved_at: "2026-10-19T10:00:00Z",
      attribution: "© OpenStreetMap contributors",
    }),
  });
  vi.stubGlobal("fetch", fetch);
  const config = props();
  const view = render(<CityMap {...config} />);
  const map = await loadMap();
  act(() =>
    map.emit("click", {
      point: { x: 300, y: 200 },
      lngLat: { lng: 71.43056789, lat: 51.12834567 },
    }),
  );
  expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
  expect(config.onPick).toHaveBeenCalledExactlyOnceWith({
    lat: 51.128346,
    lon: 71.430568,
  });
  view.rerender(<CityMap {...config} picking={false} />);
  act(() => map.emit("click", { lngLat: { lng: 71.44, lat: 51.13 } }));
  expect(config.onPick).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.getByText(mapText("ru", "inspectEmpty"))).toBeVisible(),
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/map-features",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        location: { lat: 51.13, lon: 71.44 },
        locale: "ru",
      }),
    }),
  );
});

it("looks up the footprint of a clicked 3D roof instead of the ground behind it", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  vi.stubGlobal("fetch", fetch);
  render(<CityMap {...props()} picking={false} />);
  const map = await loadMap();
  map.queryRenderedFeatures.mockReturnValue([
    {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [71.4304, 51.1282],
            [71.4306, 51.1282],
            [71.4306, 51.1284],
            [71.4304, 51.1284],
            [71.4304, 51.1282],
          ],
        ],
      },
    },
  ]);
  const pixel = { x: 300, y: 200 };
  act(() =>
    map.emit("click", {
      point: pixel,
      lngLat: { lng: 71.43031, lat: 51.12928 },
    }),
  );
  expect(map.queryRenderedFeatures).toHaveBeenCalledExactlyOnceWith(pixel, {
    layers: [BUILDING_LAYER],
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request.location.lat).toBeCloseTo(51.1283, 6);
  expect(request.location.lon).toBeCloseTo(71.4305, 6);
  expect(request.locale).toBe("ru");
});

it.each(["missing", "empty", "invalid", "throws", "flat"])(
  "keeps ground lookup when the extrusion is %s",
  async (state) => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetch);
    render(<CityMap {...props()} picking={false} />);
    const map = await loadMap();
    if (state === "missing") map.layers.delete(BUILDING_LAYER);
    if (state === "invalid")
      map.queryRenderedFeatures.mockReturnValue([
        { geometry: { type: "Polygon", coordinates: [] } },
      ]);
    if (state === "throws")
      map.queryRenderedFeatures.mockImplementation(() => {
        throw new Error("Style changed");
      });
    if (state === "flat") fireEvent.click(screen.getByTestId("map-mode-2d"));
    act(() =>
      map.emit("click", {
        point: { x: 300, y: 200 },
        lngLat: { lng: 71.44, lat: 51.13 },
      }),
    );
    if (state === "missing" || state === "flat")
      expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      location: { lon: 71.44, lat: 51.13 },
      locale: "ru",
    });
  },
);

it("opens full numbered stop details immediately on click and keyboard, with a compact map preview", async () => {
  const place = structuredClone(
    examples.cases.find((entry) => entry.name === "place_valid")!.instance,
  ) as Place;
  const config = {
    ...props(),
    places: [place],
    selectedIds: [],
    routeStopIds: [place.id],
    picking: false,
    onDetails: vi.fn(),
  };
  const view = render(<CityMap {...config} />);
  await loadMap();
  const button = await screen.findByRole("button", {
    name: `${mapText("ru", "firstStop")}: ${place.name}`,
  });
  expect(button.querySelector(".map-marker-symbol")).toHaveTextContent("1");
  fireEvent.click(button);
  const marker = fake.markers.find((entry) => entry.element === button)!;
  expect(marker.togglePopup).toHaveBeenCalledOnce();
  expect(config.onSelect).toHaveBeenCalledWith(place.id);
  expect(config.onDetails).toHaveBeenCalledExactlyOnceWith(place.id);
  const popup = marker.popup!.content!;
  expect(popup.textContent).toContain(mapText("ru", "firstStop"));
  expect(popup.textContent).toContain(place.name);
  fireEvent.click(popup.querySelector("button")!);
  expect(config.onDetails).toHaveBeenCalledWith(place.id);
  view.rerender(
    <CityMap {...config} routeStopIds={[place.id]} activeId={place.id} />,
  );
  expect(marker.remove).not.toHaveBeenCalled();
  expect(button).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(button, { key: "Enter" });
  expect(marker.togglePopup).toHaveBeenCalledTimes(2);
  expect(config.onDetails).toHaveBeenCalledTimes(3);
});

it.each(["click", "Enter"] as const)(
  "retains an inactive stop popup on the first %s when parent selection rebuilds markers",
  async (activation) => {
    const first = structuredClone(
      examples.cases.find((entry) => entry.name === "place_valid")!.instance,
    ) as Place;
    const second = { ...first, id: "second-stop", name: "Second cafe" };
    const route = (
      examples.cases.find((entry) => entry.name === "recommendations_valid")!
        .instance as { recommendations: { route: RouteEstimate }[] }
    ).recommendations[0].route;
    const config = props();
    function Parent({ hideSecond = false }: { hideSecond?: boolean }) {
      const [activeId, setActiveId] = useState(first.id);
      return (
        <CityMap
          {...config}
          places={hideSecond ? [first] : [first, second]}
          origin={{ lat: 51.12, lon: 71.43 }}
          activeId={activeId}
          onSelect={setActiveId}
          selectedIds={[first.id, second.id]}
          routeStopIds={[first.id, second.id]}
          route={{
            ...route,
            method: "routed",
            geometry: {
              type: "LineString",
              coordinates: [
                [71.43, 51.12],
                [71.44, 51.13],
              ],
            },
          }}
          communityEvents={[]}
          sharedLocations={[]}
          picking={false}
        />
      );
    }
    const view = render(<Parent />);
    const map = await loadMap();
    const markerButton = () =>
      screen.getByRole("button", {
        name: new RegExp(`: ${second.name}$`),
      });
    await waitFor(() => expect(markerButton()).toBeVisible());
    const original = markerButton();
    const routePaints = map.getSource("journey")!.setData.mock.calls.length;
    const routeOverviews = map.fitBounds.mock.calls.length;
    expect(original).toHaveAttribute("aria-pressed", "false");
    if (activation === "click") fireEvent.click(original);
    else fireEvent.keyDown(original, { key: "Enter" });

    await waitFor(() => expect(markerButton()).not.toBe(original));
    const selected = markerButton();
    const marker = fake.markers.find((entry) => entry.element === selected)!;
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(marker.popup?.isOpen()).toBe(true);
    expect(marker.popup?.content).toHaveTextContent(second.name);
    expect(map.getSource("journey")!.setData).toHaveBeenCalledTimes(
      routePaints,
    );
    expect(map.fitBounds).toHaveBeenCalledTimes(routeOverviews);
    expect(fake.markers.filter((entry) => entry.popup?.isOpen())).toEqual([
      marker,
    ]);

    // A dismissed popup must stay dismissed on the next parent render.
    marker.popup!.remove();
    view.rerender(<Parent />);
    await waitFor(() => expect(markerButton()).not.toBe(selected));
    expect(fake.markers.some((entry) => entry.popup?.isOpen())).toBe(false);

    // Removing an open stop must not resurrect its old popup.
    fireEvent.click(markerButton());
    expect(fake.markers.some((entry) => entry.popup?.isOpen())).toBe(true);
    view.rerender(<Parent hideSecond />);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: new RegExp(`: ${second.name}$`),
        }),
      ).not.toBeInTheDocument(),
    );
    expect(fake.markers.some((entry) => entry.popup?.isOpen())).toBe(false);
  },
);

it("ignores stale object lookups and distinguishes nearby information from an exact building", async () => {
  let finishFirst: (result: unknown) => void = () => {};
  const first = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const feature = {
    id: "osm:way:123",
    name: "Nearby building",
    kind: "building",
    description: null,
    address: null,
    location: { lat: 51.13, lon: 71.44 },
    match: "nearby",
    distance_meters: 35,
    attributes: [],
    source_url: "https://www.openstreetmap.org/way/123",
    source_label: "OpenStreetMap",
  };
  const response = {
    status: "ok",
    features: [feature],
    retrieved_at: "2026-10-19T10:00:00Z",
    attribution: "© OpenStreetMap contributors",
  };
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => first)
    .mockResolvedValue({ ok: true, json: async () => response });
  vi.stubGlobal("fetch", fetch);
  render(<CityMap {...props()} picking={false} />);
  const map = await loadMap();
  act(() => map.emit("click", { lngLat: { lng: 71.43, lat: 51.12 } }));
  expect(screen.getByText(mapText("ru", "inspectLoading"))).toHaveAttribute(
    "role",
    "status",
  );
  act(() => map.emit("click", { lngLat: { lng: 71.44, lat: 51.13 } }));
  await screen.findByText("Nearby building");
  expect(
    screen.getByText(`${mapText("ru", "nearbyMatch")} · 35 м`),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute(
    "href",
    feature.source_url,
  );
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => {
    finishFirst({
      ok: true,
      json: async () => ({
        ...response,
        features: [{ ...feature, name: "Old result" }],
      }),
    });
  });
  expect(screen.queryByText("Old result")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: mapText("ru", "closePopup") }),
  );
  expect(screen.queryByTestId("map-inspection")).not.toBeInTheDocument();
});
for (const locale of ["ru", "kk", "en"] as const) {
  it(`has a keyboard-operable centre confirmation and translated controls in ${locale}`, async () => {
    const config = { ...props(), locale };
    render(<CityMap {...config} />);
    const map = await loadMap();
    map.center = { lng: 71.45, lat: 51.14 };
    expect(map.canvas).toHaveAttribute(
      "aria-label",
      mapText(locale, "interactive"),
    );
    const button = screen.getByRole("button", {
      name: mapText(locale, "confirm"),
    });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(config.onPick).toHaveBeenCalledExactlyOnceWith({
      lat: 51.14,
      lon: 71.45,
    });
  });
}
it("keeps a usable map after a transient tile error but provides retry for a fatal style failure", async () => {
  render(<CityMap {...props()} />);
  const map = await loadMap();
  act(() => map.emit("error"));
  expect(screen.getByText(mapText("ru", "transient"))).toBeVisible();
  expect(screen.queryByText(mapText("ru", "failed"))).not.toBeInTheDocument();
  expect(screen.getByTestId("map-confirm-origin")).toBeEnabled();
  map.getStyle.mockReturnValue(undefined);
  act(() => map.emit("error"));
  expect(screen.getByText(mapText("ru", "failed"))).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: mapText("ru", "retry") }));
  await waitFor(() => expect(fake.maps).toHaveLength(2));
  expect(map.remove).toHaveBeenCalledOnce();
});
it("retains the offline provider without external tiles or an available 3D button", async () => {
  render(<CityMap {...props()} provider="none" />);
  const map = await loadMap();
  expect(map.options.style).toMatchObject({ sources: {} });
  expect(screen.getByTestId("map-mode-3d")).toBeDisabled();
  expect(screen.getByText(mapText("ru", "offline"))).toBeVisible();
});
it("renders only canonical routed geometry and clears the line for approximate results", async () => {
  const route = structuredClone(
    (
      examples.cases.find((item) => item.name === "recommendations_valid")!
        .instance as { recommendations: { route: RouteEstimate }[] }
    ).recommendations[0].route,
  );
  const routed = {
    ...route,
    method: "routed" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [71.43, 51.12],
        [71.44, 51.13],
      ] as [number, number][],
    },
  };
  const config = props();
  const view = render(<CityMap {...config} route={routed} />);
  const map = await loadMap();
  await waitFor(() =>
    expect(map.getSource("journey")?.setData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        features: [expect.objectContaining({ geometry: routed.geometry })],
      }),
    ),
  );
  view.rerender(<CityMap {...config} route={route} />);
  await waitFor(() =>
    expect(map.getSource("journey")?.setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: [],
    }),
  );
  expect(screen.getByTestId("map-panel")).toHaveAttribute(
    "data-route-geometry",
    "none",
  );
});
it("starts the labelled motion demo by default and lets the user turn it off", async () => {
  render(<CityMap {...props()} />);
  await loadMap();
  const toggle = screen.getByTestId("map-motion-toggle");
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("map-motion-summary")).toBeVisible();
  expect(
    screen.getByText(mapText("ru", "simulation"), { exact: false }),
  ).not.toBeVisible();
  fireEvent.click(screen.getByText(mapText("ru", "privacyLabel")));
  expect(
    screen.getByText(mapText("ru", "simulation"), { exact: false }),
  ).toBeVisible();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByTestId("map-motion-summary")).not.toBeInTheDocument();
  expect(
    screen.queryByText(mapText("ru", "simulation"), { exact: false }),
  ).not.toBeInTheDocument();
});
it.each(["ru", "kk", "en"] as const)(
  "keeps attribution visible and map explanations expandable in %s",
  async (locale) => {
    render(<CityMap {...props()} locale={locale} picking={false} />);
    await loadMap();
    const about = screen.getByTestId("map-about");
    expect(about).not.toHaveAttribute("open");
    expect(screen.getByTestId("map-attribution")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "© OpenStreetMap" }),
    ).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    expect(screen.getByRole("link", { name: "OpenFreeMap" })).toBeVisible();
    expect(screen.getByText(mapText(locale, "heights"))).not.toBeVisible();
    expect(
      screen.getByText(mapText(locale, "inspectPrivacy")),
    ).not.toBeVisible();
    fireEvent.click(screen.getByText(mapText(locale, "privacyLabel")));
    expect(about).toHaveAttribute("open");
    expect(screen.getByText(mapText(locale, "heights"))).toBeVisible();
    expect(screen.getByText(mapText(locale, "inspectPrivacy"))).toBeVisible();
    expect(screen.getByText(mapText(locale, "privacy"))).toBeVisible();
    expect(screen.getByText(mapText(locale, "followHint"))).toBeVisible();
    expect(
      screen.getByText(mapText(locale, "simulation"), { exact: false }),
    ).toBeVisible();
    fireEvent.click(screen.getByText(mapText(locale, "privacyLabel")));
    expect(screen.getByText(mapText(locale, "heights"))).not.toBeVisible();
    expect(screen.getByTestId("map-attribution")).toBeVisible();
  },
);
it("keeps community events distinct, unverified and safe from HTML injection", async () => {
  render(
    <CityMap
      {...props()}
      communityEvents={[
        {
          id: "event-one",
          title: "<img src=x onerror=alert(1)>",
          description: "Community description",
          location: { lat: 51.13, lon: 71.44 },
          starts_at: new Date().toISOString(),
          ends_at: new Date(Date.now() + 60_000).toISOString(),
          created_at: new Date().toISOString(),
          author: { id: "author-one", name: "Alex" },
          is_verified: false,
        },
      ]}
    />,
  );
  await loadMap();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /не проверено.*<img/ }),
    ).toBeVisible(),
  );
  const popup = fake.markers.find((marker) => marker.popup)?.popup?.content;
  expect(popup?.querySelector("img")).toBeNull();
  expect(popup?.textContent).toContain(mapText("ru", "community"));
});
it("removes shared positions on expiry without waiting for another backend response", async () => {
  render(
    <CityMap
      {...props()}
      sharedLocations={[
        {
          profile: { id: "friend-one", name: "Dana" },
          coordinates: { lat: 51.13, lon: 71.44 },
          expires_at: new Date(Date.now() + 500).toISOString(),
        },
        {
          profile: { id: "friend-old", name: "Expired" },
          coordinates: { lat: 51.13, lon: 71.44 },
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
      ]}
    />,
  );
  await loadMap();
  await waitFor(() =>
    expect(screen.getByRole("img", { name: /Dana/ })).toBeVisible(),
  );
  expect(
    screen.queryByRole("img", { name: /Expired/ }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("img", { name: /Dana/ })).not.toBeInTheDocument(),
  );
});
