"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, ArrowUpRight, Check, X } from "lucide-react";
import type { Evidence, Place, RouteEstimate } from "@astana/api-client";
import { ApiError } from "@/lib/api";
import { dateTime, safeUrl } from "@/lib/format";
import { t, type Locale } from "@/lib/i18n";
import {
  factLabel,
  factValue,
  placeText,
  primaryFact,
  rawFactValue,
  type PlaceFact,
} from "@/lib/place-presentation";
import PlaceOverview from "./place-overview";
import PlaceDirectory from "./place-directory";
import PlaceVisitGuide from "./place-visit-guide";
import { visitText } from "@/lib/place-visit-guide";
import guideStyles from "./place-visit-guide.module.css";

export function ErrorNotice({
  error,
  locale,
  retry,
}: {
  error: ApiError | null;
  locale: Locale;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <AlertCircle size={20} aria-hidden="true" />
      <div>
        <p>{t(locale, error.code)}</p>
        {error.requestId && (
          <small>
            {t(locale, "requestId")}: {error.requestId}
          </small>
        )}
        {retry && (
          <button type="button" className="text-button" onClick={retry}>
            {t(locale, "retry")}
          </button>
        )}
      </div>
    </div>
  );
}

export function Warnings({
  warnings,
  locale,
  expanded = false,
}: {
  warnings: string[];
  locale: Locale;
  expanded?: boolean;
}) {
  if (!warnings.length) return null;
  // The current contract has human-readable warnings, without generation status codes.
  // Preserve every original warning; this label only summarizes the known foundation messages.
  const fallback = warnings.some((w) =>
    /^(Языковая модель не настроена|Генератор объяснений недоступен|Тілдік модель бапталмаған|Түсіндірме генераторы қолжетімсіз|No language model is configured|The explanation generator was unavailable)/.test(
      w,
    ),
  );
  return (
    <>
      {fallback && (
        <p className="small fallback-label">{t(locale, "fallback")}</p>
      )}
      <details className="warnings" open={expanded || undefined}>
        <summary>
          {t(locale, "warnings")} <span>{warnings.length}</span>
        </summary>
        <ul>
          {[...new Set(warnings)].map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </details>
    </>
  );
}

export function Sources({
  evidence,
  locale,
}: {
  evidence: Evidence[];
  locale: Locale;
}) {
  return (
    <div className="source-list">
      {evidence.map((e) => (
        <div className="source" key={e.id}>
          {e.is_synthetic && (
            <span className="badge amber">{t(locale, "synthetic")}</span>
          )}
          {safeUrl(e.source_url) ? (
            <a
              href={safeUrl(e.source_url)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {e.source_name}
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          ) : (
            <strong>{e.source_name}</strong>
          )}
          <small>
            {t(locale, "sourceRecord")}: {e.source_record_id}
          </small>
          <small>
            {t(locale, "retrieved")}: {dateTime(e.retrieved_at, locale)}
          </small>
        </div>
      ))}
    </div>
  );
}

export function RouteNotes({
  route,
  locale,
}: {
  route: RouteEstimate;
  locale: Locale;
}) {
  return (
    <>
      {route.method === "routed" && route.provider === "TomTom Maps" && (
        <p className="notice" data-testid="route-access-note">
          {t(locale, "routeAccessNote")}
        </p>
      )}
      <details className="route-notes">
        <summary>{t(locale, "routeNotes")}</summary>
        <p>
          {route.provider} ·{" "}
          {new Intl.NumberFormat(locale).format(route.distance_meters)} m
        </p>
        <ul>
          {route.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <Sources evidence={route.evidence} locale={locale} />
      </details>
    </>
  );
}

export function PlaceFacts({
  place,
  locale,
  visitSeconds,
}: {
  place: Place;
  locale: Locale;
  visitSeconds?: number;
}) {
  const mainFacts = place.facts
    .filter((fact) => primaryFact(fact) && fact.status !== "unknown")
    .sort(
      (a, b) => Number(b.status === "known") - Number(a.status === "known"),
    );
  const otherFacts = place.facts.filter((fact) => !primaryFact(fact));
  const unknownFacts = place.facts.filter(
    (fact) => primaryFact(fact) && fact.status === "unknown",
  );
  const factRecord = (fact: PlaceFact) => {
    const value = factValue(locale, fact);
    const website =
      ["osm:website", "osm:contact:website"].includes(fact.key) &&
      typeof fact.value === "string"
        ? safeUrl(fact.value)
        : undefined;
    return (
      <div className="fact" key={fact.key}>
        <div className="fact-heading">
          <strong>{factLabel(locale, fact.key)}</strong>
          <span className={`fact-status ${fact.status}`}>
            {fact.status === "known" && <Check size={14} aria-hidden="true" />}
            {t(locale, fact.status)}
          </span>
        </div>
        {fact.status === "known" && (
          <p>
            {website ? (
              <a href={website} target="_blank" rel="noopener noreferrer">
                {value}
              </a>
            ) : (
              value
            )}
          </p>
        )}
        {(fact.note || fact.evidence_ids.length > 0) && (
          <details className="fact-original">
            <summary>{placeText(locale, "sourceDetails")}</summary>
            {fact.status === "known" && (
              <p>
                <code>{fact.key}</code>: {rawFactValue(fact)}
              </p>
            )}
            {fact.note && <p className="muted">{fact.note}</p>}
            <Sources
              evidence={place.evidence.filter((source) =>
                fact.evidence_ids.includes(source.id),
              )}
              locale={locale}
            />
          </details>
        )}
      </div>
    );
  };
  return (
    <>
      <PlaceOverview
        place={place}
        locale={locale}
        detailed
        showSummary={false}
      />
      <PlaceVisitGuide
        place={place}
        locale={locale}
        visitSeconds={visitSeconds}
      />
      <p className="field-hint">{placeText(locale, "sourceClaim")}</p>
      {mainFacts.some((fact) => fact.status === "conflicting") && (
        <section className={guideStyles.conflicts}>
          <h3>{visitText(locale, "conflicts")}</h3>
          {mainFacts
            .filter((fact) => fact.status === "conflicting")
            .map(factRecord)}
        </section>
      )}
      <PlaceDirectory placeId={place.id} locale={locale} />
      {unknownFacts.length > 0 && (
        <details
          className="other-source-facts"
          data-testid="unknown-place-facts"
        >
          <summary>
            {placeText(locale, "unknownConditions")} · {unknownFacts.length}
          </summary>
          <p className="small muted">
            {unknownFacts
              .map((fact) => factLabel(locale, fact.key))
              .join(" · ")}
          </p>
          {unknownFacts.map(factRecord)}
        </details>
      )}
      <details
        className={guideStyles.recordsDisclosure}
        data-testid="place-source-records"
      >
        <summary>{visitText(locale, "records")}</summary>
        <h3>{placeText(locale, "amenities")}</h3>
        <div className="fact-list">
          {mainFacts.filter((fact) => fact.status === "known").map(factRecord)}
        </div>
        {otherFacts.length > 0 && (
          <details className="other-source-facts">
            <summary>
              {placeText(locale, "otherFacts")} · {otherFacts.length}
            </summary>
            {otherFacts.map(factRecord)}
          </details>
        )}
        <h3>{t(locale, "sources")}</h3>
        <p className="small muted">{t(locale, "freshness")}</p>
        <Sources evidence={place.evidence} locale={locale} />
      </details>
    </>
  );
}

export function Dialog({
  title,
  locale,
  close,
  children,
  placement = "center",
}: {
  title: string;
  locale: Locale;
  close: () => void;
  children: React.ReactNode;
  placement?: "center" | "side";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${placement === "side" ? " place-drawer" : ""}`}
      aria-labelledby="dialog-title"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="dialog-content">
        <header>
          <h2 id="dialog-title">{title}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label={t(locale, "close")}
            autoFocus
          >
            <X size={22} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
