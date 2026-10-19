"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import type { MapFeatureResponse } from "@astana/api-client";
import {
  fetchPlaceDirectory,
  PlaceDirectoryError,
} from "@/lib/place-directory";
import { dateTime } from "@/lib/format";
import type { Locale } from "@/lib/i18n";

const copy = {
  title: ["Сведения из 2ГИС", "2GIS мәліметтері", "Information from 2GIS"],
  check: [
    "Проверить описание и часы в 2ГИС",
    "2GIS-тен сипаттама мен жұмыс уақытын тексеру",
    "Check descriptions and hours in 2GIS",
  ],
  privacy: [
    "По нажатию сервис найдёт сведения о выбранном месте в 2ГИС. Результаты не добавляются в сохранённую карточку или ИИ-запрос.",
    "Басқанда қызмет таңдалған орын туралы мәліметті 2GIS-тен іздейді. Нәтижелер сақталған карточкаға немесе ЖИ сұрауына қосылмайды.",
    "On click, the service looks up the selected place in 2GIS. Results are not added to saved place facts or AI requests.",
  ],
  candidates: [
    "Сверьте название и адрес — рядом могут быть другие филиалы.",
    "Атауы мен мекенжайын салыстырыңыз — жақын жерде басқа филиалдар болуы мүмкін.",
    "Check the name and address — nearby results may be other branches.",
  ],
  loading: [
    "Ищем доступные сведения в 2ГИС…",
    "2GIS-тен қолжетімді мәліметтерді іздеудеміз…",
    "Looking up available information in 2GIS…",
  ],
  cancel: [
    "Отменить поиск в 2ГИС",
    "2GIS іздеуін тоқтату",
    "Cancel the 2GIS lookup",
  ],
  cancelled: [
    "Поиск отменён. Можно запустить его снова.",
    "Іздеу тоқтатылды. Оны қайта бастауға болады.",
    "Lookup cancelled. You can start it again.",
  ],
  retry: [
    "Повторить поиск в 2ГИС",
    "2GIS іздеуін қайталау",
    "Retry the 2GIS lookup",
  ],
  empty: [
    "2ГИС не вернул подходящих карточек. Проверьте сайт места или повторите поиск позже.",
    "2GIS сәйкес карточкаларды қайтармады. Орынның сайтын тексеріңіз немесе кейінірек қайталаңыз.",
    "2GIS returned no matching cards. Check the place's website or try again later.",
  ],
  unavailable: [
    "2ГИС сейчас недоступен. Попробуйте позже; ваш маршрут сохранён.",
    "2GIS қазір қолжетімсіз. Кейінірек қайталаңыз; маршрутыңыз сақталды.",
    "2GIS is unavailable right now. Try later; your route is kept.",
  ],
  invalid: [
    "Не удалось проверить ответ 2ГИС. Повторите поиск позже; ваш маршрут сохранён.",
    "2GIS жауабын тексеру мүмкін болмады. Кейінірек қайталаңыз; маршрутыңыз сақталды.",
    "The 2GIS response could not be verified. Try later; your route is kept.",
  ],
  busy: [
    "Слишком много запросов к 2ГИС. Подождите немного и повторите поиск.",
    "2GIS-ке сұраулар тым көп. Біраз күтіп, іздеуді қайталаңыз.",
    "Too many 2GIS requests. Wait a moment and try again.",
  ],
  found: [
    "Найдены карточки: {count}",
    "Табылған карточкалар: {count}",
    "Cards found: {count}",
  ],
  addressMissing: [
    "Адрес не указан в ответе 2ГИС",
    "2GIS жауабында мекенжай жоқ",
    "No address supplied by 2GIS",
  ],
  distance: [
    "м от выбранного места · по прямой",
    "м таңдалған орыннан · түзу сызықпен",
    "m from the selected place · straight-line distance",
  ],
  description: [
    "Описание из источника",
    "Дереккөз сипаттамасы",
    "Source description",
  ],
  noDetails: [
    "Описание и часы в ответе не указаны. Дополнительные сведения могут быть в карточке 2ГИС.",
    "Жауапта сипаттама мен жұмыс уақыты жоқ. Қосымша мәлімет 2GIS карточкасында болуы мүмкін.",
    "No description or hours were included. The 2GIS card may have more information.",
  ],
  hoursNote: [
    "Расписание показано как в источнике; открытие к вашему прибытию не проверялось.",
    "Кесте дереккөздегідей көрсетілген; сіз келген кезде ашық болатыны тексерілмеген.",
    "Hours are shown as supplied; opening at your arrival time has not been verified.",
  ],
  source: [
    "Открыть карточку в 2ГИС",
    "2GIS карточкасын ашу",
    "Open the 2GIS card",
  ],
  retrieved: ["Данные получены", "Деректер алынды", "Retrieved"],
} as const;

export function directoryText(locale: Locale, key: keyof typeof copy) {
  return copy[key][locale === "ru" ? 0 : locale === "kk" ? 1 : 2];
}

type Props = { placeId: string; locale: Locale };

export default function PlaceDirectory(props: Props) {
  // A new place or language gets a fresh session before any old data can render.
  return (
    <DirectoryLookup
      key={JSON.stringify([props.placeId, props.locale])}
      {...props}
    />
  );
}

function DirectoryLookup({ placeId, locale }: Props) {
  const titleId = useId();
  const statusId = useId();
  const current = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<MapFeatureResponse | null>(null);
  const [error, setError] = useState<PlaceDirectoryError["code"] | null>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => () => current.current?.abort(), []);
  const text = (key: keyof typeof copy) => directoryText(locale, key);

  async function lookup() {
    if (current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setPending(true);
    setResult(null);
    setError(null);
    setCancelled(false);
    try {
      const response = await fetchPlaceDirectory(
        placeId,
        locale,
        controller.signal,
      );
      if (!controller.signal.aborted && current.current === controller)
        setResult(response);
    } catch (reason) {
      if (!controller.signal.aborted && current.current === controller)
        setError(
          reason instanceof PlaceDirectoryError ? reason.code : "unavailable",
        );
    } finally {
      if (current.current === controller && !controller.signal.aborted) {
        current.current = null;
        setPending(false);
      }
    }
  }
  function cancel() {
    current.current?.abort();
    current.current = null;
    setPending(false);
    setCancelled(true);
  }
  const message = pending
    ? text("loading")
    : error
      ? text(error)
      : cancelled
        ? text("cancelled")
        : result
          ? result.status === "empty"
            ? text("empty")
            : text("found").replace("{count}", String(result.features.length))
          : "";
  return (
    <section
      className="panel"
      aria-labelledby={titleId}
      data-testid="place-directory"
    >
      <h3 id={titleId}>{text("title")}</h3>
      <p className="field-hint">{text("privacy")}</p>
      <button
        type="button"
        className="secondary"
        onClick={() => void lookup()}
        disabled={pending}
        aria-describedby={message ? statusId : undefined}
      >
        <Search size={17} aria-hidden="true" />
        {error || result?.status === "empty" || cancelled
          ? text("retry")
          : text("check")}
      </button>
      {pending && (
        <button type="button" className="text-button" onClick={cancel}>
          {text("cancel")}
        </button>
      )}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={error ? "notice amber" : "field-hint"}
      >
        {message}
      </p>
      {result?.features.length ? (
        <>
          <p className="notice amber">{text("candidates")}</p>
          {result.features.map((feature) => (
            <article
              key={feature.id}
              className="source-status"
              aria-label={feature.name}
            >
              <h4>{feature.name}</h4>
              <p>{feature.address || text("addressMissing")}</p>
              <p className="small">
                {new Intl.NumberFormat(locale, {
                  maximumFractionDigits: 0,
                }).format(feature.distance_meters)}{" "}
                {text("distance")}
              </p>
              {feature.description && (
                <div>
                  <strong>{text("description")}</strong>
                  <p>{feature.description}</p>
                </div>
              )}
              {feature.attributes.length > 0 && (
                <div className="source-summary">
                  <dl>
                    {feature.attributes.map((attribute, index) => (
                      <div key={`${attribute.label}-${index}`}>
                        <dt>{attribute.label}</dt>
                        <dd>{attribute.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="field-hint">{text("hoursNote")}</p>
                </div>
              )}
              {!feature.description && feature.attributes.length === 0 && (
                <p className="field-hint">{text("noDetails")}</p>
              )}
              <a
                href={feature.source_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {text("source")}
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            </article>
          ))}
          <p className="small">
            {text("retrieved")}: {dateTime(result.retrieved_at, locale)}
          </p>
        </>
      ) : null}
      <p className="small">
        {result?.attribution ? `${result.attribution} · ` : ""}
        <a href="https://dev.2gis.ru" target="_blank" rel="noopener noreferrer">
          2ГИС
        </a>
      </p>
    </section>
  );
}
