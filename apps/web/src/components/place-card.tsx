"use client";

import {
  ArrowUpRight,
  Bookmark,
  Check,
  Clock3,
  Footprints,
  Plus,
} from "lucide-react";
import type { Place, Recommendation } from "@astana/api-client";
import { duration } from "@/lib/format";
import { t, label, type Locale } from "@/lib/i18n";
import { Sources, RouteNotes, Warnings } from "./details";

type Props = {
  place: Place;
  recommendation?: Recommendation;
  locale: Locale;
  active: boolean;
  selected: boolean;
  full: boolean;
  saved: boolean;
  onSelect: () => void;
  onDetails: () => void;
  onAdd: () => void;
  onSave: () => void;
};
export default function PlaceCard({
  place,
  recommendation: item,
  locale,
  active,
  selected,
  full,
  saved,
  onSelect,
  onDetails,
  onAdd,
  onSave,
}: Props) {
  return (
    <article
      className={`place-card ${active ? "active" : ""}`}
      id={`place-${item ? "result" : "catalog"}-${place.id}`}
      data-testid="place-card"
    >
      <div className="card-top">
        <span className="place-number">
          {item ? String(item.rank).padStart(2, "0") : <Footprints size={21} />}
        </span>
        <div className="card-heading">
          <div className="badges">
            {place.is_synthetic && (
              <span className="badge amber">{t(locale, "synthetic")}</span>
            )}
            {place.categories.map((category) => (
              <span className="category" key={category}>
                {label(locale, category)}
              </span>
            ))}
          </div>
          <h3>{place.name}</h3>
        </div>
        <button
          className={`icon-button bookmark ${saved ? "saved" : ""}`}
          type="button"
          onClick={onSave}
          aria-pressed={saved}
          aria-label={`${t(locale, saved ? "unsave" : "save")}: ${place.name}`}
        >
          <Bookmark size={20} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>
      {item ? (
        <>
          <div className="timings">
            <div>
              <Clock3 size={15} aria-hidden="true" />
              <strong>{duration(item.total_duration_seconds, locale)}</strong>
              <span>{t(locale, "total")}</span>
            </div>
            <div>
              <span>{t(locale, "travel")}</span>
              <b>{duration(item.route.duration_seconds, locale)}</b>
            </div>
            <div>
              <span>{t(locale, "visit")}</span>
              <b>{duration(item.visit_duration_seconds, locale)}</b>
            </div>
          </div>
          <span
            className={`badge ${item.route.method === "approximate" || !item.route.geometry ? "amber" : "green"}`}
          >
            {t(
              locale,
              item.route.method === "routed" && item.route.geometry
                ? "routed"
                : "approximate",
            )}
          </span>
          <div className="activity">
            <span>{t(locale, "suggestion")}</span>
            <p>{item.suggested_activity}</p>
          </div>
          <details className="why">
            <summary>{t(locale, "why")}</summary>
            <p>{item.why}</p>
            {item.constraint_evaluations.map((e) => (
              <div className="evaluation" key={e.key}>
                <strong>{label(locale, e.key)}</strong>
                <span>
                  {t(locale, e.strength)} · {t(locale, e.outcome)}
                </span>
                <p>{e.explanation}</p>
                <Sources
                  evidence={place.evidence.filter((source) =>
                    e.evidence_ids.includes(source.id),
                  )}
                  locale={locale}
                />
              </div>
            ))}
            <RouteNotes route={item.route} locale={locale} />
            <Warnings warnings={item.warnings} locale={locale} />
          </details>
          <div className="card-sources">
            <span>{t(locale, "sources")}:</span>{" "}
            {place.evidence
              .map((e) => e.source_name)
              .filter((v, i, list) => list.indexOf(v) === i)
              .join(" · ")}
          </div>
        </>
      ) : (
        place.description && (
          <p className="catalog-description">{place.description}</p>
        )
      )}
      {place.facts.some((f) => f.status !== "known") && (
        <p className="small muted unknown-note">
          {t(locale, "unknown")}:{" "}
          {place.facts
            .filter((f) => f.status !== "known")
            .map((f) => label(locale, f.key))
            .join(", ")}
        </p>
      )}
      <div className="card-actions">
        <button type="button" className="text-button" onClick={onDetails}>
          {t(locale, "details")}
          <ArrowUpRight size={15} />
        </button>
        <button type="button" className="text-button" onClick={onSelect}>
          {t(locale, "showMap")}
        </button>
        <button
          type="button"
          className="secondary small-button"
          disabled={selected || full}
          onClick={onAdd}
        >
          {selected ? <Check size={16} /> : <Plus size={16} />}
          {t(locale, selected ? "added" : "add")}
        </button>
      </div>
    </article>
  );
}
