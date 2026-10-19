import type { FillExtrusionLayerSpecification } from "maplibre-gl";

export type ModelKind = "car" | "walker";
export type ModelPart = {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  properties: {
    actor: string;
    kind: ModelKind;
    part: string;
    base: number;
    height: number;
    color: string;
    simulation: true;
  };
};
type ModelOptions = {
  actor: string;
  kind: ModelKind;
  coordinates: [number, number];
  /** Clockwise degrees from north, in geographic rather than screen space. */
  heading: number;
  phase: number;
  zoom: number;
  color?: string;
};
const CAR_COLORS = ["#e9a443", "#eff3f5", "#427ba5", "#b85649"];
const COAT_COLORS = ["#346986", "#975342", "#527c60", "#815c8c"];

/** A modest cartographic exaggeration keeps models legible at city-map zooms. */
export function modelScale(kind: ModelKind, zoom: number) {
  const detailed = Math.min(
    18,
    Math.max(15, Number.isFinite(zoom) ? zoom : 17),
  );
  const close = (detailed - 15) / 3;
  return kind === "car" ? 3.2 - close * 2 : 5 - close * 3.2;
}

/**
 * Small solid meshes made of extruded polygons: no sprite or external 3D asset.
 * Local x points right and local y points forward, so the whole actor turns at
 * each actual road/path bend. Heights are metres, including the display scale.
 */
export function modelParts(options: ModelOptions): ModelPart[] {
  const { actor, kind, coordinates, phase } = options;
  const scale = modelScale(kind, options.zoom);
  const heading = (options.heading * Math.PI) / 180;
  const sin = Math.sin(heading),
    cos = Math.cos(heading);
  const lonMeters =
    111_320 * Math.max(0.01, Math.cos((coordinates[1] * Math.PI) / 180));
  const parts: ModelPart[] = [];
  const ordinal = [...actor].reduce(
    (sum, letter) => sum + letter.charCodeAt(0),
    0,
  );
  const project = ([right, forward]: number[]): [number, number] => [
    coordinates[0] + (scale * (right * cos + forward * sin)) / lonMeters,
    coordinates[1] + (scale * (-right * sin + forward * cos)) / 111_320,
  ];
  const solid = (
    part: string,
    points: number[][],
    base: number,
    height: number,
    color: string,
  ) => {
    const ring = points.map(project);
    ring.push([...ring[0]]);
    parts.push({
      type: "Feature",
      properties: {
        actor,
        kind,
        part,
        base: base * scale,
        height: height * scale,
        color,
        simulation: true,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  };
  const box = (
    part: string,
    x: number,
    y: number,
    width: number,
    length: number,
    base: number,
    height: number,
    color: string,
  ) =>
    solid(
      part,
      [
        [x - width / 2, y - length / 2],
        [x + width / 2, y - length / 2],
        [x + width / 2, y + length / 2],
        [x - width / 2, y + length / 2],
      ],
      base,
      height,
      color,
    );

  if (kind === "car") {
    const color = options.color ?? CAR_COLORS[ordinal % CAR_COLORS.length];
    // Bevelled bonnet/boot and a contrasting raised glass cabin read as a car
    // both from overhead and at the map's 3D pitch.
    solid(
      "body",
      [
        [-0.73, -2.2],
        [0.73, -2.2],
        [0.94, -1.9],
        [0.94, 1.65],
        [0.65, 2.2],
        [-0.65, 2.2],
        [-0.94, 1.65],
        [-0.94, -1.9],
      ],
      0.3,
      1.02,
      color,
    );
    solid(
      "cabin",
      [
        [-0.7, -0.95],
        [0.7, -0.95],
        [0.66, 0.85],
        [-0.66, 0.85],
      ],
      1.02,
      1.65,
      "#354d5a",
    );
    box("roof", 0, -0.15, 1.22, 1.05, 1.65, 1.75, color);
    for (const side of [-1, 1]) {
      for (const axle of [-1.35, 1.35])
        box(
          `wheel-${side}-${axle}`,
          side * 0.92,
          axle,
          0.3,
          0.72,
          0.12,
          0.69,
          "#27303a",
        );
      box(
        `headlight-${side}`,
        side * 0.47,
        2.16,
        0.36,
        0.14,
        0.59,
        0.86,
        "#fff2c5",
      );
      box(
        `tail-light-${side}`,
        side * 0.51,
        -2.16,
        0.32,
        0.14,
        0.59,
        0.86,
        "#9d2f31",
      );
    }
  } else {
    const coat = options.color ?? COAT_COLORS[ordinal % COAT_COLORS.length];
    const stride = Math.sin(phase) * 0.21;
    const bob = Math.abs(Math.cos(phase)) * 0.035;
    // Opposing arms/legs and alternating lifted feet give a restrained walking
    // gait while every part remains a real solid with a non-zero height.
    box("left-leg", -0.15, stride, 0.2, 0.25, 0.12, 0.83, "#303b51");
    box("right-leg", 0.15, -stride, 0.2, 0.25, 0.12, 0.83, "#303b51");
    box(
      "left-shoe",
      -0.15,
      stride + 0.065,
      0.24,
      0.39,
      0.03 + Math.max(0, stride) * 0.3,
      0.19 + Math.max(0, stride) * 0.3,
      "#252e39",
    );
    box(
      "right-shoe",
      0.15,
      -stride + 0.065,
      0.24,
      0.39,
      0.03 + Math.max(0, -stride) * 0.3,
      0.19 + Math.max(0, -stride) * 0.3,
      "#252e39",
    );
    box("torso", 0, 0, 0.55, 0.33, 0.78 + bob, 1.43 + bob, coat);
    box(
      "left-arm",
      -0.36,
      -stride * 0.8,
      0.16,
      0.2,
      0.85 + bob,
      1.36 + bob,
      coat,
    );
    box(
      "right-arm",
      0.36,
      stride * 0.8,
      0.16,
      0.2,
      0.85 + bob,
      1.36 + bob,
      coat,
    );
    solid(
      "head",
      Array.from({ length: 8 }, (_, index) => {
        const angle = (index * Math.PI) / 4;
        return [Math.cos(angle) * 0.19, Math.sin(angle) * 0.19 + 0.025];
      }),
      1.45 + bob,
      1.82 + bob,
      "#d5ac87",
    );
    box("hair", 0, 0.005, 0.31, 0.3, 1.77 + bob, 1.87 + bob, "#493e37");
  }
  return parts;
}

/** Shared by the local city illustration and provider-backed traffic flow. */
export function modelLayer(
  id: string,
  source: string,
): FillExtrusionLayerSpecification {
  return {
    id,
    type: "fill-extrusion",
    source,
    minzoom: 14,
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-base": ["get", "base"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-opacity": 1,
      "fill-extrusion-vertical-gradient": true,
      // Avoid interpolating the gait and positions twice: GeoJSON advances at
      // a bounded 10 fps rather than queuing paint transitions between frames.
      "fill-extrusion-base-transition": { duration: 0 },
      "fill-extrusion-height-transition": { duration: 0 },
    },
  };
}
