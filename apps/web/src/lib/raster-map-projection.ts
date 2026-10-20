import type { Location } from "@astana/api-client";

export type RasterCamera = { x: number; y: number; zoom: number };
export const RASTER_TILE_SIZE = 256;
export const RASTER_DEFAULT: Location = { lat: 51.1283, lon: 71.4305 };

export function mercator(point: Location): { x: number; y: number } {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  const sine = Math.sin((lat * Math.PI) / 180);
  return {
    x: (point.lon + 180) / 360,
    y: 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI),
  };
}

export function unproject(x: number, y: number): Location {
  return {
    lon: ((((x * 360 - 180 + 180) % 360) + 360) % 360) - 180,
    lat:
      (Math.atan(Math.sinh(Math.PI * (1 - 2 * Math.max(0, Math.min(1, y))))) *
        180) /
      Math.PI,
  };
}

export function rasterScreen(
  point: Location,
  camera: RasterCamera,
  width: number,
  height: number,
) {
  const p = mercator(point);
  const scale = RASTER_TILE_SIZE * 2 ** camera.zoom;
  return {
    x: (p.x - camera.x) * scale + width / 2,
    y: (p.y - camera.y) * scale + height / 2,
  };
}

export function fitRaster(
  points: Location[],
  width: number,
  height: number,
  bottomInset = 0,
): RasterCamera {
  const valid = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
  const projected = (valid.length ? valid : [RASTER_DEFAULT]).map(mercator);
  const xs = projected.map((p) => p.x),
    ys = projected.map((p) => p.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const top = Math.min(112, height * 0.25),
    bottom = 60 + Math.max(0, Math.min(bottomInset, height - 200));
  const usableWidth = Math.max(80, width - 112),
    usableHeight = Math.max(80, height - top - bottom);
  const zoom = Math.max(
    3,
    Math.min(
      16,
      Math.floor(
        Math.log2(
          Math.min(
            usableWidth / (256 * Math.max(maxX - minX, 0.000001)),
            usableHeight / (256 * Math.max(maxY - minY, 0.000001)),
          ),
        ),
      ),
    ),
  );
  const scale = 256 * 2 ** zoom;
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2 + (bottom - top) / (2 * scale),
    zoom,
  };
}
