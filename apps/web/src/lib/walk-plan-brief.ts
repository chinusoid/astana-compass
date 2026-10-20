import type { ItineraryResponse } from "@astana/api-client";
import type { Locale } from "./i18n";

export function planBrief(
  itinerary: ItineraryResponse,
  hasTimeTarget: boolean,
) {
  if (!itinerary.stops.length || !itinerary.route) return null;
  const walking = itinerary.route.duration_seconds;
  const visiting = itinerary.stops.reduce(
    (sum, stop) => sum + stop.visit_duration_seconds,
    0,
  );
  const total = itinerary.total_duration_seconds;
  const target = hasTimeTarget ? itinerary.request.available_seconds : null;
  return {
    walking,
    visiting,
    total,
    target,
    distance: itinerary.route.distance_meters,
    approximate: itinerary.route.method !== "routed",
    difference: target === null ? null : total - target,
    walkingShare: total > 0 ? Math.round((walking / total) * 100) : 0,
    unknownPreferences: [
      ...new Set(
        itinerary.stops.flatMap((stop) =>
          stop.constraint_evaluations
            .filter((item) => item.outcome === "unknown")
            .map((item) => item.key),
        ),
      ),
    ],
    categories: [
      ...new Set(itinerary.places.flatMap((place) => place.categories)),
    ],
  };
}

export function refineWalkQuery(
  query: string,
  goal: "lessWalking" | "scenic" | "variety",
  locale: Locale,
) {
  const phrases = {
    lessWalking: {
      ru: "Хочу поменьше ходить: короткие переходы между остановками.",
      kk: "Аз жүріп, аялдамалар арасында қысқа жол болғанын қалаймын.",
      en: "I would like less walking and short transfers between stops.",
    },
    scenic: {
      ru: "Хочу больше красивых видов и архитектуры для фотографий.",
      kk: "Суретке түсіруге әдемі көріністер мен сәулет көбірек болсын.",
      en: "I would like more scenic views and architecture for photographs.",
    },
    variety: {
      ru: "Хочу разнообразную прогулку с разными занятиями и категориями мест.",
      kk: "Әртүрлі істері мен орындары бар алуан серуенді қалаймын.",
      en: "I would like a varied walk with different activities and kinds of places.",
    },
  };
  const addition = phrases[goal][locale];
  const text = query.trim();
  // Never truncate away the user's original requirements to make room for ours.
  if (text.includes(addition) || text.length + addition.length + 1 > 2000)
    return text;
  return `${text}${text ? "\n" : ""}${addition}`;
}
