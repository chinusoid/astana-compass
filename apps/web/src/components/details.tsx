"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, ArrowUpRight, Check, X } from "lucide-react";
import type { Evidence, Place, RouteEstimate } from "@astana/api-client";
import { ApiError } from "@/lib/api";
import { dateTime, safeUrl } from "@/lib/format";
import { label, t, type Locale } from "@/lib/i18n";

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
}: {
  warnings: string[];
  locale: Locale;
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
      <details className="warnings">
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
  );
}

export function PlaceFacts({
  place,
  locale,
}: {
  place: Place;
  locale: Locale;
}) {
  return (
    <>
      {place.description && <p>{place.description}</p>}
      <h3>{t(locale, "facts")}</h3>
      <div className="fact-list">
        {place.facts.map((f) => (
          <div className="fact" key={f.key}>
            <div className="fact-heading">
              <strong>{label(locale, f.key)}</strong>
              <span className={`fact-status ${f.status}`}>
                {f.status === "known" && <Check size={14} aria-hidden="true" />}
                {t(locale, f.status)}
              </span>
            </div>
            {f.status === "known" && (
              <p>
                {typeof f.value === "boolean"
                  ? t(locale, f.value ? "yes" : "no")
                  : Array.isArray(f.value)
                    ? f.value.join(", ")
                    : String(f.value)}
              </p>
            )}
            {f.note && <p className="muted">{f.note}</p>}
            <Sources
              evidence={place.evidence.filter((e) =>
                f.evidence_ids.includes(e.id),
              )}
              locale={locale}
            />
          </div>
        ))}
      </div>
      <h3>{t(locale, "sources")}</h3>
      <p className="small muted">{t(locale, "freshness")}</p>
      <Sources evidence={place.evidence} locale={locale} />
    </>
  );
}

export function Dialog({
  title,
  locale,
  close,
  children,
}: {
  title: string;
  locale: Locale;
  close: () => void;
  children: React.ReactNode;
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
      className="dialog"
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
