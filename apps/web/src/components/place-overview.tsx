import type { Place } from "@astana/api-client";
import type { Locale } from "@/lib/i18n";
import { safeUrl } from "@/lib/format";
import {
  factLabel,
  factValue,
  overviewKeys,
  placeText,
  sourceDescription,
  sourcedFact,
} from "@/lib/place-presentation";

export default function PlaceOverview({
  place,
  locale,
  detailed = false,
}: {
  place: Place;
  locale: Locale;
  detailed?: boolean;
}) {
  const description = sourceDescription(place, locale);
  const address = ["osm:addr:street", "osm:addr:housenumber", "osm:addr:city"]
    .map((key) => sourcedFact(place, key))
    .filter((fact) => fact !== undefined)
    .map((fact) => factValue(locale, fact))
    .join(", ");
  const facts = overviewKeys
    .map((key) => sourcedFact(place, key))
    .filter((fact) => fact !== undefined);
  return (
    <div className="place-overview">
      {description ? (
        <div className="source-description">
          <p className="overview-label">{placeText(locale, "description")}</p>
          <p className={detailed ? undefined : "description-preview"}>
            {description.text}
          </p>
          {detailed && !description.localized && (
            <p className="field-hint">{placeText(locale, "sourceText")}</p>
          )}
          <div className="description-sources">
            {description.evidence.map(
              (source) =>
                safeUrl(source.source_url) && (
                  <a
                    key={source.id}
                    href={safeUrl(source.source_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.source_name}
                  </a>
                ),
            )}
          </div>
        </div>
      ) : detailed ? (
        <p className="field-hint">{placeText(locale, "noDescription")}</p>
      ) : null}
      {(address || facts.length > 0) && (
        <div className="source-summary">
          <p className="overview-label">{placeText(locale, "summary")}</p>
          <dl>
            {address && (
              <div>
                <dt>{placeText(locale, "address")}</dt>
                <dd>{address}</dd>
              </div>
            )}
            {facts.map((fact) => (
              <div key={fact.key}>
                <dt>{factLabel(locale, fact.key)}</dt>
                <dd>{factValue(locale, fact)}</dd>
              </div>
            ))}
          </dl>
          {facts.some((fact) => fact.key === "opening_hours") && (
            <p className="field-hint">{placeText(locale, "scheduleNote")}</p>
          )}
        </div>
      )}
    </div>
  );
}
