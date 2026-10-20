"use client";

import {
  ArrowUpRight,
  Bookmark,
  Check,
  Clock3,
  Footprints,
  Plus,
} from "lucide-react";
import type { JourneyPlan, Place, Recommendation } from "@astana/api-client";
import { duration } from "@/lib/format";
import { t, label, type Locale } from "@/lib/i18n";
import { Sources, RouteNotes, Warnings } from "./details";
import OsmAttribution from "./osm-attribution";
import PlaceOverview from "./place-overview";
import PlacePhoto from "./place-photo";
import PlaceVisitGuide from "./place-visit-guide";
import TimeBudgetNote from "./time-budget-note";
import { factLabel, placeText } from "@/lib/place-presentation";
import { recommendationRationale } from "@/lib/recommendation-rationale";

const cardCopy = {
  ru: {
    evidence: "Условия и подтверждения",
    distance: "Путь",
    roundTrip: "туда и обратно",
    oneWay: "в одну сторону",
    estimate: "Время посещения — ориентир",
    partial: "Есть неподтверждённые или невыполненные пожелания",
    meters: "м",
    kilometers: "км",
  },
  kk: {
    evidence: "Талаптар мен дәлелдер",
    distance: "Жол",
    roundTrip: "барып-қайту",
    oneWay: "бір бағытта",
    estimate: "Бару уақыты шамамен берілген",
    partial: "Кейбір қалаулар расталмаған немесе орындалмаған",
    meters: "м",
    kilometers: "км",
  },
  en: {
    evidence: "Conditions and evidence",
    distance: "Journey",
    roundTrip: "round trip",
    oneWay: "one way",
    estimate: "Visit time is an estimate",
    partial: "Some preferences are unverified or not met",
    meters: "m",
    kilometers: "km",
  },
};

type Props = {
  place: Place;
  recommendation?: Recommendation;
  budgetSeconds?: number;
  requestQuery?: string;
  journeyPlan?: JourneyPlan;
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
  budgetSeconds,
  requestQuery,
  journeyPlan,
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
  const copy = cardCopy[locale];
  const unknownFacts = place.facts.filter(
    (fact) =>
      fact.status !== "known" &&
      !item?.constraint_evaluations.some(
        (evaluation) =>
          evaluation.key === fact.key &&
          ["satisfied", "unsatisfied"].includes(evaluation.outcome),
      ),
  );
  const distance =
    item &&
    new Intl.NumberFormat(locale, {
      maximumFractionDigits: item.route.distance_meters >= 1000 ? 1 : 0,
    }).format(
      item.route.distance_meters >= 1000
        ? item.route.distance_meters / 1000
        : item.route.distance_meters,
    );
  return (
    <article
      className={`place-card ${active ? "active" : ""}`}
      id={`place-${item ? "result" : "catalog"}-${place.id}`}
      data-testid="place-card"
    >
      <PlacePhoto place={place} locale={locale} />
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
      <PlaceVisitGuide place={place} locale={locale} compact />
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
          <TimeBudgetNote
            totalSeconds={item.total_duration_seconds}
            budgetSeconds={budgetSeconds}
            locale={locale}
          />
          <p className="walk-distance">
            <Footprints size={15} aria-hidden="true" />
            {copy.distance}: {distance}{" "}
            {item.route.distance_meters >= 1000 ? copy.kilometers : copy.meters}
            {" · "}
            {item.route.includes_return ? copy.roundTrip : copy.oneWay}
          </p>
          <p className="small muted visit-estimate">{copy.estimate}</p>
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
          <div className="why-summary">
            <strong>{t(locale, "why")}</strong>
            <p>{recommendationRationale(place, item, requestQuery, locale, journeyPlan)}</p>
          </div>
          {item.constraint_evaluations.some(
            (e) => e.outcome !== "satisfied",
          ) && <p className="preference-caution">{copy.partial}</p>}
          <div className="activity">
            <span>{t(locale, "suggestion")}</span>
            <p>{item.suggested_activity}</p>
          </div>
          <details className="why">
            <summary>{copy.evidence}</summary>
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
      ) : null}
      <PlaceOverview place={place} locale={locale} showSummary={false} />
      {!place.is_synthetic &&
        place.evidence.some(
          (e) => e.source_type === "osm" && !e.is_synthetic,
        ) && <OsmAttribution locale={locale} />}
      {unknownFacts.length > 0 && (
        <details className="small muted unknown-note">
          <summary>
            {placeText(locale, "unknownConditions")} · {unknownFacts.length}
          </summary>
          <p>
            {unknownFacts.map((fact) => factLabel(locale, fact.key)).join(", ")}
          </p>
        </details>
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
