import type { Locale } from "./i18n";
import { t } from "./i18n";

export function duration(seconds: number, locale: Locale): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return [
    minutes ? `${minutes} ${t(locale, "minutes")}` : "",
    rest || !minutes ? `${rest} ${t(locale, "seconds")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
export function dateTime(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Almaty",
  }).format(new Date(value));
}
export function astanaInputDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
// Interpret the wall-clock input in Astana, independently of the browser timezone.
export function astanaInstant(input: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input))
    throw new Error("invalid date");
  const desired = Date.parse(`${input}:00Z`);
  let instant = desired;
  for (let i = 0; i < 3; i++) {
    const displayed = Date.parse(`${astanaInputDate(new Date(instant))}:00Z`);
    instant += desired - displayed;
  }
  if (astanaInputDate(new Date(instant)) !== input)
    throw new Error("invalid date");
  return new Date(instant).toISOString();
}
export function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
