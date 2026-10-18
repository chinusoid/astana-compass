import type { Locale } from "@/lib/i18n";

const copy = {
  ru: { data: "Данные мест", contributors: "© участники OpenStreetMap" },
  kk: {
    data: "Орындар деректері",
    contributors: "© OpenStreetMap қатысушылары",
  },
  en: { data: "Place data", contributors: "© OpenStreetMap contributors" },
};

export function isOsmSourceUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ["openstreetmap.org", "www.openstreetmap.org"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export default function OsmAttribution({ locale }: { locale: Locale }) {
  const text = copy[locale];
  return (
    <p className="small catalog-attribution">
      {text.data}:{" "}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
      >
        {text.contributors}
      </a>
      {" · "}
      <a
        href="https://opendatacommons.org/licenses/odbl/1-0/"
        target="_blank"
        rel="noopener noreferrer"
      >
        ODbL 1.0
      </a>
    </p>
  );
}
