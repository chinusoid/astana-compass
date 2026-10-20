import type { JourneyPlan, Place, Recommendation } from "@astana/api-client";
import { label, type Locale } from "./i18n";
import { factLabel, sourcedFact } from "./place-presentation";
import { placeVisitGuide } from "./place-visit-guide";

// Only replace the backend's known fallback sentences. Any additional source
// detail or generated reasoning keeps the original explanation intact.
const genericReasons = new Set([
  "Место найдено в каталоге.", "Орын каталогтан табылды.", "The place was found in the catalog.",
  "«{name}» отмечено в каталоге как кафе — вариант для остановки на кофе.",
  "«{name}» отмечено в каталоге как парк — вариант для прогулки.",
  "«{name}» отмечено в каталоге как сад — вариант для прогулки.",
  "«{name}» отмечено в каталоге как музей — вариант для знакомства с культурой и экспозициями.",
  "«{name}» отмечено в каталоге как смотровая точка — вариант для осмотра города.",
  "«{name}» относится к искусству по категории каталога — вариант для внимательного осмотра работ и деталей.",
  "«{name}» отмечено в каталоге категорией архитектуры — вариант для осмотра форм и деталей.",
  "«{name}» отмечено исторической или мемориальной категорией каталога.",
  "«{name}» каталогта кафе ретінде көрсетілген — кофе ішуге аялдаудың бір нұсқасы.",
  "«{name}» каталогта саябақ ретінде көрсетілген — серуендеудің бір нұсқасы.",
  "«{name}» каталогта бақ ретінде көрсетілген — серуендеудің бір нұсқасы.",
  "«{name}» каталогта мұражай ретінде көрсетілген — мәдениет пен экспозициялармен танысу нұсқасы.",
  "«{name}» каталогта шолу нүктесі ретінде көрсетілген — қаланы қарау нұсқасы.",
  "«{name}» каталогта өнер санатына жатады — туындылар мен бөлшектерді қарау нұсқасы.",
  "«{name}» каталогта сәулет санатымен белгіленген — пішіндер мен бөлшектерді қарау нұсқасы.",
  "«{name}» каталогта тарихи немесе мемориалдық санатпен белгіленген.",
  "{name} is listed in the catalog as a cafe — an option for a coffee stop.",
  "{name} is listed in the catalog as a park — an option for a walk.",
  "{name} is listed in the catalog as a garden — an option for a walk.",
  "{name} is listed as a museum — an option for exploring culture and exhibitions.",
  "{name} is listed as a viewpoint — an option for observing the city.",
  "{name} has an art category in the catalog — an option for looking closely at works and details.",
  "{name} has an architecture category in the catalog — an option for observing forms and details.",
  "{name} has a historic or memorial category in the catalog.",
]);
const stagePrefix = /^(?:Этап (\d+) из вашего пожелания\.|Қалауыңыздағы (\d+)-кезең\.|Stage (\d+) of your wish\.)\s*/u;
const timeSuffix = /\s*(?:Расчётное время дороги и посещения: \d+ мин\.|Жол мен барудың есептік уақыты: \d+ мин\.|Estimated travel and visit time: \d+ min\.)\s*$/u;

export function recommendationRationale(
  place: Place,
  item: Recommendation,
  query: string | undefined,
  locale: Locale,
  journeyPlan?: JourneyPlan,
): string {
  if (!query?.trim()) return item.why;
  const marker = item.why.match(stagePrefix);
  const plain = item.why.replace(stagePrefix, "").replace(timeSuffix, "").trim();
  if (!genericReasons.has(plain.replaceAll(place.name, "{name}"))) return item.why;
  // Rank can differ from stage order when a stage has no result. Only the
  // explicit backend stage marker can associate a stop with a source quote.
  const order = marker ? Number(marker[1] ?? marker[2] ?? marker[3]) : null;
  const stage = order ? journeyPlan?.stages[order - 1] : undefined;
  const purpose = stage?.source_quote && query.includes(stage.source_quote)
    ? stage.source_quote : query;
  const shortPurpose = purpose.replace(/\s+/gu, " ").trim();
  const wish = shortPurpose.length > 160 ? `${shortPurpose.slice(0, 157)}…` : shortPurpose;
  const categories = place.categories.map((key) => label(locale, key)).join(", ");
  const amenities = item.constraint_evaluations.flatMap((evaluation) => {
    const fact = sourcedFact(place, evaluation.key);
    return evaluation.outcome === "satisfied" && fact?.value === true
      ? [factLabel(locale, evaluation.key)] : [];
  }).slice(0, 2).join(", ");
  const activity = item.suggested_activity.trim() || placeVisitGuide(place, locale).idea;
  const night = /ноч[\p{L}]*|вечер[\p{L}]*|\b(?:night|evening)\b|түн[\p{L}]*|кешкі/iu.test(query);
  const reasons = {
    ru: [
      `Для пожелания «${wish}» предлагаю остановку «${place.name}»: категория в источнике — ${categories}.`,
      activity,
      amenities ? `По данным источника: ${amenities}.` : "",
      night ? "Освещение и доступ ночью не подтверждены; проверьте их перед выходом." : "",
    ],
    kk: [
      `«${wish}» тілегіңізге «${place.name}» аялдамасын ұсынамын: дереккөздегі санаты — ${categories}.`,
      activity,
      amenities ? `Дереккөз мәліметтері: ${amenities}.` : "",
      night ? "Жарықтандыру мен түнгі кіру расталмаған; шығар алдында тексеріңіз." : "",
    ],
    en: [
      `For your wish “${wish}”, I suggest “${place.name}” as a stop: its source category is ${categories}.`,
      activity,
      amenities ? `Source-listed conditions: ${amenities}.` : "",
      night ? "Lighting and nighttime access are unverified; check before setting out." : "",
    ],
  };
  return reasons[locale].filter(Boolean).join(" ");
}
