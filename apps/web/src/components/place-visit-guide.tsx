import {
  Clock3,
  ExternalLink,
  Lightbulb,
  Mail,
  MapPin,
  Phone,
  Utensils,
} from "lucide-react";
import type { Place } from "@astana/api-client";
import type { Locale } from "@/lib/i18n";
import { duration, safeUrl } from "@/lib/format";
import { placeText } from "@/lib/place-presentation";
import {
  placeVisitGuide,
  visitText,
  type VisitAction,
  type VisitRecord,
} from "@/lib/place-visit-guide";
import styles from "./place-visit-guide.module.css";

function ActionLinks({ actions }: { actions: VisitAction[] }) {
  return (
    <div className={styles.actions}>
      {actions.map((action) => {
        const Icon = {
          website: ExternalLink,
          menu: Utensils,
          phone: Phone,
          email: Mail,
          map: MapPin,
        }[action.kind];
        const external =
          action.kind === "website" ||
          action.kind === "menu" ||
          action.kind === "map";
        return (
          <a
            key={`${action.kind}:${action.href}`}
            href={action.href}
            title={action.detail}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
          >
            <Icon size={14} aria-hidden="true" />
            {action.label}
            {action.detail && <span>{action.detail}</span>}
          </a>
        );
      })}
    </div>
  );
}

function Records({ records }: { records: VisitRecord[] }) {
  return (
    <dl className={styles.records}>
      {records.map((item) => (
        <div key={item.key}>
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            <div className={styles.sources}>
              {item.evidence.map((source) => {
                const href = safeUrl(source.source_url);
                return href ? (
                  <a
                    key={source.id}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.source_name}
                  </a>
                ) : null;
              })}
            </div>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function PlaceVisitGuide({
  place,
  locale,
  compact = false,
  visitSeconds,
}: {
  place: Place;
  locale: Locale;
  compact?: boolean;
  visitSeconds?: number;
}) {
  const guide = placeVisitGuide(place, locale);
  const hasPlannedVisit =
    typeof visitSeconds === "number" &&
    Number.isFinite(visitSeconds) &&
    visitSeconds > 0;
  const compactActions = guide.actions
    .filter((action) => action.kind !== "map")
    .slice(0, 2);
  if (
    compact &&
    !guide.address &&
    guide.hours.length === 0 &&
    compactActions.length === 0
  )
    return null;
  if (compact)
    return (
      <div
        className={`${styles.guide} ${styles.compact}`}
        data-testid="place-visit-summary"
      >
        {guide.address && (
          <p className={styles.address}>
            <MapPin size={15} aria-hidden="true" />
            {guide.address}
          </p>
        )}
        {guide.hours[0] && (
          <p className={styles.compactFact}>
            <b>{guide.hours[0].label}:</b> {guide.hours[0].value}
          </p>
        )}
        <ActionLinks actions={compactActions} />
      </div>
    );

  return (
    <div className={styles.guide} data-testid="place-visit-guide">
      <section
        className={styles.practical}
        aria-label={visitText(locale, "practical")}
      >
        <h3>{visitText(locale, "practical")}</h3>
        {guide.address && (
          <p className={styles.address}>
            <MapPin size={18} aria-hidden="true" />
            <span>{guide.address}</span>
          </p>
        )}
        {guide.actions.length > 0 && <ActionLinks actions={guide.actions} />}
        {(guide.hours.length > 0 ||
          guide.practical.length > 0 ||
          guide.rating) && (
          <Records
            records={[
              ...guide.hours,
              ...guide.practical,
              ...(guide.rating
                ? [{ ...guide.rating, label: visitText(locale, "rating") }]
                : []),
            ]}
          />
        )}
        {guide.hours.length > 0 && (
          <p className={styles.hint}>{placeText(locale, "scheduleNote")}</p>
        )}
        <p className={styles.hint}>{visitText(locale, "contactNote")}</p>
      </section>
      {guide.highlights.length > 0 && (
        <section
          className={styles.highlights}
          aria-label={visitText(locale, "highlights")}
        >
          <h3>{visitText(locale, "highlights")}</h3>
          <Records records={guide.highlights} />
        </section>
      )}
      <section className={styles.idea} aria-label={visitText(locale, "idea")}>
        <div className={styles.ideaTitle}>
          <Lightbulb size={16} aria-hidden="true" />
          {visitText(locale, "idea")}
        </div>
        <p>{guide.idea}</p>
        <p className={styles.hint}>{visitText(locale, "ideaNote")}</p>
        <p className={styles.estimate}>
          <Clock3 size={16} aria-hidden="true" />
          {visitText(locale, "estimate")}
          <strong>
            {hasPlannedVisit ? duration(visitSeconds, locale) : guide.estimate}
          </strong>
        </p>
        <p className={styles.hint}>
          {visitText(
            locale,
            hasPlannedVisit ? "planEstimateNote" : "estimateNote",
          )}
        </p>
      </section>
      {guide.amenities.length > 0 && (
        <section
          className={styles.conditions}
          aria-label={visitText(locale, "amenities")}
        >
          <h3>{visitText(locale, "amenities")}</h3>
          <Records records={guide.amenities} />
        </section>
      )}
      {guide.notes.map((note) => (
        <aside className={styles.note} key={note.key}>
          <h3>{visitText(locale, "before")}</h3>
          <p>{note.value}</p>
          <div className={styles.sources}>
            {note.evidence.map((source) => {
              const href = safeUrl(source.source_url);
              return href ? (
                <a
                  href={href}
                  key={source.id}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.source_name}
                </a>
              ) : null;
            })}
          </div>
        </aside>
      ))}
    </div>
  );
}
