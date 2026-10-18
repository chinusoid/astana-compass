import { expect, it } from "vitest";
import { astanaInputDate, astanaInstant, duration, safeUrl } from "./format";

it("preserves seconds rather than rounding away the budget", () => {
  expect(duration(61, "ru")).toBe("1 мин 1 с");
  expect(duration(59, "en")).toBe("59 sec");
  expect(duration(3600, "kk")).toBe("60 мин");
});
it("interprets city time independently of the browser time zone", () => {
  expect(astanaInputDate(new Date("2026-10-19T06:30:00Z"))).toBe(
    "2026-10-19T11:30",
  );
  expect(astanaInstant("2026-10-19T11:30")).toBe("2026-10-19T06:30:00.000Z");
  expect(() => astanaInstant("2026-02-31T11:30")).toThrow();
});
it("does not turn an external string into an executable link", () => {
  expect(safeUrl("javascript:alert(1)")).toBeUndefined();
  expect(safeUrl("https://user:secret@example.com")).toBeUndefined();
  expect(safeUrl("https://example.com/source")).toBe(
    "https://example.com/source",
  );
});
