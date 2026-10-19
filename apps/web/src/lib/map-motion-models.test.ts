import { expect, it } from "vitest";
import { modelParts, modelScale, type ModelPart } from "./map-motion-models";

const origin: [number, number] = [71.43, 51.128];
const options = {
  actor: "test-0",
  kind: "car" as const,
  coordinates: origin,
  heading: 0,
  phase: 0,
  zoom: 17,
};
const center = (part: ModelPart) => {
  const ring = part.geometry.coordinates[0].slice(0, -1);
  return ring.reduce(
    (sum, point) => [
      sum[0] + point[0] / ring.length,
      sum[1] + point[1] / ring.length,
    ],
    [0, 0],
  );
};

it("builds solid cars with raised cabins, four wheels and distinguishable front and rear", () => {
  const car = modelParts(options);
  const part = (name: string) =>
    car.find((item) => item.properties.part === name)!;
  expect(
    car.filter((item) => item.properties.part.startsWith("wheel-")),
  ).toHaveLength(4);
  expect(part("cabin").properties.base).toBe(part("body").properties.height);
  expect(part("cabin").properties.height).toBeGreaterThan(
    part("body").properties.height,
  );
  expect(center(part("headlight-1"))[1]).toBeGreaterThan(
    center(part("tail-light-1"))[1],
  );
  for (const item of car) {
    const ring = item.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring.at(-1));
    expect(item.properties.height).toBeGreaterThan(item.properties.base);
    const area = ring
      .slice(1)
      .reduce(
        (sum, point, index) =>
          sum +
          (ring[index][0] - origin[0]) * (point[1] - origin[1]) -
          (point[0] - origin[0]) * (ring[index][1] - origin[1]),
        0,
      );
    expect(area).toBeGreaterThan(0);
  }
});

it("rotates the physical model toward the road heading without swapping lon/lat", () => {
  const east = modelParts({ ...options, heading: 90 });
  const front = center(
    east.find((part) => part.properties.part === "headlight-1")!,
  );
  const rear = center(
    east.find((part) => part.properties.part === "tail-light-1")!,
  );
  expect(front[0]).toBeGreaterThan(rear[0]);
  expect(front[1]).toBeCloseTo(rear[1], 5);
});

it("has a human silhouette and alternating limbs while keeping the body on the path", () => {
  const a = modelParts({ ...options, kind: "walker", phase: Math.PI / 2 });
  const b = modelParts({ ...options, kind: "walker", phase: Math.PI * 1.5 });
  const part = (model: ModelPart[], name: string) =>
    model.find((item) => item.properties.part === name)!;
  expect(part(a, "head").properties.base).toBeGreaterThan(
    part(a, "torso").properties.base,
  );
  expect(center(part(a, "left-leg"))[1]).toBeGreaterThan(
    center(part(a, "right-leg"))[1],
  );
  expect(center(part(b, "left-leg"))[1]).toBeLessThan(
    center(part(b, "right-leg"))[1],
  );
  expect(center(part(a, "left-arm"))[1]).toBeLessThan(
    center(part(a, "right-arm"))[1],
  );
  expect(center(part(a, "torso"))).toEqual(center(part(b, "torso")));
});

it("keeps display exaggeration bounded and shrinks it when zooming closer", () => {
  for (const kind of ["car", "walker"] as const) {
    expect(modelScale(kind, 15)).toBeGreaterThan(modelScale(kind, 18));
    expect(modelScale(kind, 10)).toBe(modelScale(kind, 15));
    expect(modelScale(kind, 22)).toBe(modelScale(kind, 18));
    expect(modelScale(kind, NaN)).toBe(modelScale(kind, 17));
  }
});
