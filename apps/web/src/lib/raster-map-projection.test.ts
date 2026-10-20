import { describe, expect, it } from "vitest";
import {
  fitRaster,
  mercator,
  rasterScreen,
  unproject,
} from "./raster-map-projection";

describe("DOM map projection", () => {
  it("round trips Astana coordinates and clamps the Mercator poles", () => {
    const point = { lat: 51.1283, lon: 71.4305 };
    const projected = mercator(point);
    const restored = unproject(projected.x, projected.y);
    expect(restored.lat).toBeCloseTo(point.lat, 6);
    expect(restored.lon).toBeCloseTo(point.lon, 6);
    expect(Number.isFinite(mercator({ lat: 90, lon: 0 }).y)).toBe(true);
  });
  it("keeps every route point above a mobile sheet when fitting", () => {
    const points = [
      { lat: 51.08, lon: 71.4 },
      { lat: 51.15, lon: 71.48 },
      { lat: 51.12, lon: 71.45 },
    ];
    const camera = fitRaster(points, 390, 700, 260);
    for (const point of points) {
      const screen = rasterScreen(point, camera, 390, 700);
      expect(screen.x).toBeGreaterThanOrEqual(50);
      expect(screen.x).toBeLessThanOrEqual(340);
      expect(screen.y).toBeGreaterThanOrEqual(110);
      expect(screen.y).toBeLessThanOrEqual(390);
    }
  });
});
