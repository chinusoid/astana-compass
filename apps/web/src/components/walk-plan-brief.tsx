"use client";
import type { ItineraryResponse } from "@astana/api-client";
import { Footprints, Clock3, MapPin, ArrowRight, Sparkles } from "lucide-react";
import { duration } from "@/lib/format";
import { label, type Locale } from "@/lib/i18n";
import { planBrief } from "@/lib/walk-plan-brief";
import { journeyColor } from "@/lib/map-route-segments";
import styles from "./walk-assistant-dock.module.css";

const copy = {
  ru: {
    title: "Разбор вашей прогулки",
    walking: "Переходы",
    visiting: "Посещения ≈",
    total: "Всего",
    target: "Ваш ориентир",
    extra: "Сверх ориентира",
    spare: "Запас времени",
    noTarget: "Вы не задавали длительность — показываем полное время плана.",
    approximate:
      "Точный путь по дорогам пока не подтверждён. Длительность и расстояние приблизительные.",
    visitHint:
      "Время посещений приблизительное; занятия — предложения, а не обещание услуг или мероприятий.",
    walkingHeavy:
      "Большая часть времени уйдёт на переходы. Можно поискать места ближе друг к другу.",
    unknown:
      "Некоторые пожелания не подтверждены источниками. Проверьте сведения в карточках перед посещением.",
    refine: "Изменить подбор",
    lessWalking: "Найти с меньшей ходьбой",
    scenic: "Больше красивых видов",
    variety: "Больше разнообразия",
    sources: "Открыть место",
    routeUnavailable: "Расчёт пути пока недоступен.",
  },
  kk: {
    title: "Серуеніңізді талдау",
    walking: "Жаяу жол",
    visiting: "Аралау ≈",
    total: "Барлығы",
    target: "Сіздің бағдарыңыз",
    extra: "Бағдардан артық",
    spare: "Бос уақыт",
    noTarget: "Ұзақтық берілмеді — жоспардың толық уақытын көрсетеміз.",
    approximate:
      "Жолдар бойынша нақты бағыт әлі расталмады. Уақыт пен қашықтық шамамен берілген.",
    visitHint:
      "Аралау уақыты шамамен; әрекеттер — қызмет не шара туралы уәде емес, ұсыныстар.",
    walkingHeavy:
      "Уақыттың көбі жолға кетеді. Бір-біріне жақын орындарды іздеуге болады.",
    unknown:
      "Кейбір қалаулар дереккөздермен расталмады. Барар алдында карточкаларды тексеріңіз.",
    refine: "Таңдауды өзгерту",
    lessWalking: "Аз жүретін бағыт табу",
    scenic: "Әдемі көріністер көбірек",
    variety: "Әртүрлі орындар көбірек",
    sources: "Орынды ашу",
    routeUnavailable: "Жолды есептеу әзірге қолжетімсіз.",
  },
  en: {
    title: "Your walk explained",
    walking: "Walking",
    visiting: "Visits ≈",
    total: "Total",
    target: "Your target",
    extra: "Above your target",
    spare: "Time to spare",
    noTarget: "You did not set a duration — this is the complete plan time.",
    approximate:
      "The road path is not confirmed yet. Duration and distance are approximate.",
    visitHint:
      "Visit times are estimates; activities are ideas, not promises of services or events.",
    walkingHeavy:
      "Most of this time is spent walking. You can look for places closer together.",
    unknown:
      "Some preferences are not confirmed by sources. Check each card before visiting.",
    refine: "Refine this walk",
    lessWalking: "Find with less walking",
    scenic: "More scenic views",
    variety: "More variety",
    sources: "Open place",
    routeUnavailable: "The path calculation is unavailable.",
  },
};
export default function WalkPlanBrief({
  itinerary,
  locale,
  hasTimeTarget,
  onDetails,
  onRefine,
  disabled = false,
}: {
  itinerary: ItineraryResponse;
  locale: Locale;
  hasTimeTarget: boolean;
  onDetails: (id: string) => void;
  onRefine: (goal: "lessWalking" | "scenic" | "variety") => void;
  disabled?: boolean;
}) {
  const brief = planBrief(itinerary, hasTimeTarget);
  const text = copy[locale];
  if (!brief) return <p>{text.routeUnavailable}</p>;
  return (
    <section className={styles.brief} aria-label={text.title}>
      <h3>
        <Sparkles size={17} aria-hidden="true" />
        {text.title}
      </h3>
      <dl className={styles.metrics}>
        <div>
          <dt>
            <Footprints size={14} aria-hidden="true" />
            {text.walking}
          </dt>
          <dd>{duration(brief.walking, locale)}</dd>
        </div>
        <div>
          <dt>
            <Clock3 size={14} aria-hidden="true" />
            {text.visiting}
          </dt>
          <dd>{duration(brief.visiting, locale)}</dd>
        </div>
        <div>
          <dt>{text.total}</dt>
          <dd>{duration(brief.total, locale)}</dd>
        </div>
      </dl>
      <p className={styles.distance}>
        {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
          brief.distance / 1000,
        )}{" "}
        km · {brief.walkingShare}% {text.walking.toLocaleLowerCase(locale)}
      </p>
      {brief.target !== null ? (
        <p className={brief.difference! > 0 ? styles.caution : styles.fit}>
          {text.target}: {duration(brief.target, locale)} ·{" "}
          {brief.difference! > 0 ? text.extra : text.spare}:{" "}
          {duration(Math.abs(brief.difference!), locale)}
        </p>
      ) : (
        <p className={styles.note}>{text.noTarget}</p>
      )}
      {brief.approximate && (
        <p className={styles.caution}>{text.approximate}</p>
      )}
      {brief.walkingShare > 60 && (
        <p className={styles.note}>{text.walkingHeavy}</p>
      )}
      <ol className={styles.timeline}>
        {itinerary.stops.map((stop, index) => {
          const place = itinerary.places.find(
            (item) => item.id === stop.place_id,
          );
          if (!place) return null;
          return (
            <li key={stop.place_id}>
              <button
                type="button"
                className={styles.stop}
                onClick={() => onDetails(stop.place_id)}
                aria-label={`${text.sources}: ${place.name}`}
              >
                <span style={{ background: journeyColor(index) }}>
                  {index + 1}
                </span>
                <strong>{place.name}</strong>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
              <p className={styles.note}>
                {place.categories
                  .map((category) => label(locale, category))
                  .join(" · ")}{" "}
                · ≈ {duration(stop.visit_duration_seconds, locale)}
              </p>
              <p>{stop.suggested_activity}</p>
            </li>
          );
        })}
      </ol>
      <p className={styles.note}>{text.visitHint}</p>
      {brief.unknownPreferences.length > 0 && (
        <p className={styles.caution}>
          {text.unknown}{" "}
          {brief.unknownPreferences
            .map((key) => label(locale, key))
            .join(" · ")}
        </p>
      )}
      <h4>{text.refine}</h4>
      <div className={styles.refinements}>
        {(["lessWalking", "scenic", "variety"] as const).map((goal) => (
          <button
            key={goal}
            type="button"
            disabled={disabled}
            onClick={() => onRefine(goal)}
          >
            <MapPin size={14} aria-hidden="true" />
            {text[goal]}
          </button>
        ))}
      </div>
    </section>
  );
}
