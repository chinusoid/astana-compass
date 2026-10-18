import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { RouteEstimate } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import { BUILDING_LAYER } from "@/lib/map-style";
import { mapText } from "@/lib/map-copy";
import CityMap from "./city-map";

const fake = vi.hoisted(() => ({
  maps: [] as MockMap[],
  markers: [] as MockMarker[],
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
  addControl = vi.fn();
  setLayoutProperty = vi.fn();
  remove = vi.fn();
  resize = vi.fn();
  fitBounds = vi.fn();
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
  content: HTMLElement | null = null;
  setDOMContent(content: HTMLElement) {
    this.content = content;
    return this;
  }
}
class MockMarker {
  element: HTMLElement;
  popup: MockPopup | null = null;
  remove = vi.fn(() => this.element.remove());
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
  setWorkerUrl: vi.fn(),
}));
beforeEach(() => {
  fake.maps.length = 0;
  fake.markers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
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

it("starts with real vector 3D and switches to genuinely flat footprints", async () => {
  render(<CityMap {...props()} />);
  const map = await loadMap();
  expect(map.options).toMatchObject({
    style: "https://tiles.openfreemap.org/styles/liberty",
    zoom: 15.5,
    pitch: 50,
  });
  expect(map.addControl).toHaveBeenCalledTimes(3);
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
  expect(screen.getByText(mapText("ru", "heights"))).toBeVisible();
});
it("accepts map clicks only during start selection and does not swap lat/lon", async () => {
  const config = props();
  const view = render(<CityMap {...config} />);
  const map = await loadMap();
  act(() =>
    map.emit("click", { lngLat: { lng: 71.43056789, lat: 51.12834567 } }),
  );
  expect(config.onPick).toHaveBeenCalledExactlyOnceWith({
    lat: 51.128346,
    lon: 71.430568,
  });
  view.rerender(<CityMap {...config} picking={false} />);
  act(() => map.emit("click", { lngLat: { lng: 71.44, lat: 51.13 } }));
  expect(config.onPick).toHaveBeenCalledTimes(1);
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
it("keeps motion optional and explicitly labels it as simulation", async () => {
  render(<CityMap {...props()} />);
  await loadMap();
  const toggle = screen.getByTestId("map-motion-toggle");
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(
    screen.queryByText(mapText("ru", "simulation"), { exact: false }),
  ).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByText(mapText("ru", "simulation"), { exact: false }),
  ).toBeVisible();
});
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
