"use client";

import { Check, Plus, Sparkles } from "lucide-react";
import type { Place, PlaceSuggestion } from "@astana/api-client";
import { label, t, type Locale } from "@/lib/i18n";
import { Sources } from "./details";
import PlacePhoto from "./place-photo";
import OsmAttribution from "./osm-attribution";
import styles from "./route-ideas.module.css";

export const ideasCopy = {
  ru: {
    title: "Идеи по пути",
    proposal: "Предложение",
    hint: "Дополнительно к вашим пожеланиям. Маршрут и время проверим, когда вы добавите место.",
    add: "Добавить в маршрут",
    selected: "Уже в маршруте",
    full: "В маршруте уже 6 мест",
  },
  kk: {
    title: "Жолдағы идеялар",
    proposal: "Ұсыныс",
    hint: "Қалауларыңызға қосымша. Орынды қосқаннан кейін маршрут пен уақыт қайта тексеріледі.",
    add: "Маршрутқа қосу",
    selected: "Маршрутқа қосылған",
    full: "Маршрутта 6 орын бар",
  },
  en: {
    title: "Ideas along the way",
    proposal: "Suggestion",
    hint: "Extra ideas beyond your wishes. Route and time are checked after you add a place.",
    add: "Add to route",
    selected: "Already in route",
    full: "The route already has 6 places",
  },
};

export default function RouteIdeas({
  suggestions,
  places,
  selectedIds,
  locale,
  onAdd,
  onDetails,
}: {
  suggestions: PlaceSuggestion[];
  places: Place[];
  selectedIds: string[];
  locale: Locale;
  onAdd: (place: Place) => void;
  onDetails: (id: string) => void;
}) {
  const text = ideasCopy[locale];
  const ideas = suggestions.flatMap((suggestion) => {
    const place = places.find((entry) => entry.id === suggestion.place_id);
    return place ? [{ place, suggestion }] : [];
  });
  if (!ideas.length) return null;
  return (
    <section
      className={styles.ideas}
      aria-labelledby="route-ideas"
      data-testid="route-ideas"
    >
      <h3 id="route-ideas" tabIndex={-1}>
        <Sparkles size={18} aria-hidden="true" />
        {text.title} <span className="count">{ideas.length}</span>
      </h3>
      <p className={styles.hint}>{text.hint}</p>
      {ideas.map(({ place, suggestion }) => {
        const selected = selectedIds.includes(place.id);
        const disabled = selected || selectedIds.length >= 6;
        return (
          <article
            className={styles.card}
            key={place.id}
            data-testid="route-idea"
          >
            <div className={styles.cover}>
              <PlacePhoto place={place} locale={locale} />
            </div>
            <div className={styles.body}>
              <span className={styles.badge}>{text.proposal}</span>
              <p className={styles.category}>
                {place.categories
                  .map((category) => label(locale, category))
                  .join(" · ")}
              </p>
              <h4>{place.name}</h4>
              <p className={styles.why}>{suggestion.why}</p>
              <p className={styles.activity}>{suggestion.suggested_activity}</p>
              <details className={styles.sources}>
                <summary>
                  {t(locale, "sources")}:{" "}
                  {[
                    ...new Set(
                      place.evidence.map((entry) => entry.source_name),
                    ),
                  ].join(" · ")}
                </summary>
                <Sources evidence={place.evidence} locale={locale} />
                {suggestion.constraint_evaluations.map((evaluation) => (
                  <p key={evaluation.key}>
                    <strong>{label(locale, evaluation.key)}</strong>:{" "}
                    {t(locale, evaluation.strength)} ·{" "}
                    {t(locale, evaluation.outcome)}. {evaluation.explanation}
                  </p>
                ))}
              </details>
              {!place.is_synthetic &&
                place.evidence.some(
                  (entry) => entry.source_type === "osm" && !entry.is_synthetic,
                ) && <OsmAttribution locale={locale} />}
              <div className={styles.actions}>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => onAdd(place)}
                  aria-label={`${selected ? text.selected : text.add}: ${place.name}`}
                >
                  {selected ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <Plus size={16} aria-hidden="true" />
                  )}
                  {selected
                    ? text.selected
                    : selectedIds.length >= 6
                      ? text.full
                      : text.add}
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onDetails(place.id)}
                  aria-label={`${t(locale, "details")}: ${place.name}`}
                >
                  {t(locale, "details")}
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
